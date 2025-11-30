// api/search-companies/index.js
const { app } = require("@azure/functions");

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function json(obj, status = 200, req) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-functions-key",
    },
    body: JSON.stringify(obj),
  };
}

function getCompaniesContainer() {
  try {
    const endpoint = env("COSMOS_DB_ENDPOINT", "");
    const key = env("COSMOS_DB_KEY", "");
    const databaseId = env("COSMOS_DB_DATABASE", "tabarnam-db");
    const containerId = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");

    if (!endpoint || !key) return null;

    const { CosmosClient } = require("@azure/cosmos");
    const client = new CosmosClient({ endpoint, key });
    return client.database(databaseId).container(containerId);
  } catch (err) {
    console.error("Failed to initialize Cosmos container:", err);
    return null;
  }
}

// Single declaration (avoids the "Cannot redeclare block-scoped variable" error)
const SQL_TEXT_FILTER = `
  (IS_DEFINED(c.company_name) AND CONTAINS(LOWER(c.company_name), @q)) OR
  (IS_DEFINED(c.product_keywords) AND CONTAINS(LOWER(c.product_keywords), @q)) OR
  (IS_DEFINED(c.industries) AND ARRAY_LENGTH(
      ARRAY(SELECT VALUE i FROM i IN c.industries WHERE CONTAINS(LOWER(i), @q))
    ) > 0) OR
  (IS_DEFINED(c.normalized_domain) AND CONTAINS(LOWER(c.normalized_domain), @q)) OR
  (IS_DEFINED(c.amazon_url) AND CONTAINS(LOWER(c.amazon_url), @q))
`;

app.http("searchCompanies", {
  route: "search-companies",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();
    if (method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "content-type,x-functions-key",
          "Access-Control-Max-Age": "86400",
        },
      };
    }
    if (method !== "GET") {
      return json({ ok: false, success: false, error: "Method Not Allowed" }, 405, req);
    }

    const url = new URL(req.url);
    const qRaw = (url.searchParams.get("q") || "").trim();
    const q = qRaw.toLowerCase();
    const sort = (url.searchParams.get("sort") || "recent").toLowerCase();
    const take = Math.min(200, Math.max(1, Number(url.searchParams.get("take") || 50)));
    const rawSkip = url.searchParams.get("skip");
    const skip = Math.max(0, Number(rawSkip || 0) || 0);
    const limit = Math.min(500, skip + take || take);

    // 1) Cosmos DB path (prioritized - local data source first)
    const container = getCompaniesContainer();
    if (container) {
      try {
        let items = [];
        const params = [{ name: "@take", value: limit }];
        if (q) params.push({ name: "@q", value: q });

        if (sort === "manu") {
          const whereText = q ? `AND (${SQL_TEXT_FILTER})` : "";

          // A) With manufacturing locations
          const sqlA = `
            SELECT TOP @take c.id, c.company_name, c.industries, c.url, c.amazon_url,
                             c.normalized_domain, c.created_at, c.session_id, c._ts,
                             c.manufacturing_locations, c.manufacturing_geocodes,
                             c.headquarters, c.headquarters_location,
                             c.hq_lat, c.hq_lng, c.product_keywords, c.keywords,
                             c.star_rating, c.star_score, c.confidence_score
            FROM c
            WHERE IS_DEFINED(c.manufacturing_locations) AND ARRAY_LENGTH(c.manufacturing_locations) > 0
            ${whereText}
            ORDER BY c._ts DESC
          `;
          const partA = await container.items
            .query({ query: sqlA, parameters: params }, { enableCrossPartitionQuery: true })
            .fetchAll();
          items = partA.resources || [];

          // B) Fill remainder without manufacturing data
          const remaining = Math.max(0, limit - items.length);
          if (remaining > 0) {
            const sqlB = `
              SELECT TOP @take2 c.id, c.company_name, c.industries, c.url, c.amazon_url,
                                c.normalized_domain, c.created_at, c.session_id, c._ts,
                                c.manufacturing_locations, c.manufacturing_geocodes,
                                c.headquarters, c.headquarters_location,
                                c.hq_lat, c.hq_lng, c.product_keywords, c.keywords,
                                c.star_rating, c.star_score, c.confidence_score
              FROM c
              WHERE (NOT IS_DEFINED(c.manufacturing_locations) OR ARRAY_LENGTH(c.manufacturing_locations) = 0)
              ${whereText}
              ORDER BY c._ts DESC
            `;
            const paramsB = [{ name: "@take2", value: remaining }];
            if (q) paramsB.push({ name: "@q", value: q });
            const partB = await container.items
              .query({ query: sqlB, parameters: paramsB }, { enableCrossPartitionQuery: true })
              .fetchAll();
            items = items.concat(partB.resources || []);
          }
        } else {
          const orderBy = sort === "name" ? "ORDER BY c.company_name ASC" : "ORDER BY c._ts DESC";
          const sql = q
            ? `
              SELECT TOP @take c.id, c.company_name, c.industries, c.url, c.amazon_url,
                               c.normalized_domain, c.created_at, c.session_id, c._ts,
                               c.manufacturing_locations, c.manufacturing_geocodes,
                               c.headquarters, c.headquarters_location,
                               c.hq_lat, c.hq_lng, c.product_keywords, c.keywords,
                               c.star_rating, c.star_score, c.confidence_score
              FROM c
              WHERE ${SQL_TEXT_FILTER}
              ${orderBy}
            `
            : `
              SELECT TOP @take c.id, c.company_name, c.industries, c.url, c.amazon_url,
                               c.normalized_domain, c.created_at, c.session_id, c._ts,
                               c.manufacturing_locations, c.manufacturing_geocodes,
                               c.headquarters, c.headquarters_location,
                               c.hq_lat, c.hq_lng, c.product_keywords, c.keywords,
                               c.star_rating, c.star_score, c.confidence_score
              FROM c
              ${orderBy}
            `;
          const res = await container.items
            .query({ query: sql, parameters: params }, { enableCrossPartitionQuery: true })
            .fetchAll();
          items = res.resources || [];
        }

        // Normalize created_at from _ts when missing
        const normalized = items.map((r) => {
          if (!r?.created_at && typeof r?._ts === "number") {
            try {
              r.created_at = new Date(r._ts * 1000).toISOString();
            } catch {}
          }
          return r;
        });

        const paged = normalized.slice(skip, skip + take);

        return json(
          { ok: true, success: true, items: paged, count: normalized.length, meta: { q: qRaw, sort, skip, take } },
          200,
          req
        );
      } catch (e) {
        context.log("search-companies cosmos error:", e?.message || e, e?.stack);
        console.error("search-companies error details:", {
          message: e?.message,
          stack: e?.stack,
          sort,
          q,
          limit,
        });
        return json({ ok: false, success: false, error: e?.message || "query failed" }, 500, req);
      }
    }

    // 2) Error if no Cosmos DB available
    return json({ ok: false, success: false, error: "Cosmos DB not configured" }, 503, req);
  },
});
