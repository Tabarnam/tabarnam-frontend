// api/search-companies/index.js
import { app } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";

const getEnv = (k, d = "") => (process.env[k] ?? d);

function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
function json(obj, status, req) {
  return {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function getCosmos() {
  const endpoint   = getEnv("COSMOS_DB_ENDPOINT");
  const key        = getEnv("COSMOS_DB_KEY");
  const databaseId = getEnv("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId= getEnv("COSMOS_DB_CONTAINER", "companies_ingest");
  if (!endpoint || !key) return null;
  const client = new CosmosClient({ endpoint, key });
  const db = client.database(databaseId);
  return { client, container: db.container(containerId) };
}

// shared text filter
function textFilterSql() {
  return `
    (IS_DEFINED(c.company_name) AND CONTAINS(LOWER(c.company_name), @q)) OR
    (IS_DEFINED(c.normalized_domain) AND CONTAINS(LOWER(c.normalized_domain), @q)) OR
    (IS_DEFINED(c.amazon_url) AND CONTAINS(LOWER(c.amazon_url), @q))
  `;
}

app.http("searchCompanies", {
  route: "search-companies",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    const url  = new URL(req.url);
    const qRaw = (url.searchParams.get("q") || "").trim();
    const sort = (url.searchParams.get("sort") || "recent").toLowerCase(); // recent | name | manu
    const take = Math.min(Math.max(parseInt(url.searchParams.get("take") || "50", 10) || 50, 1), 200);

    const cos = getCosmos();
    if (!cos) return json({ error: "Cosmos not configured" }, 500, req);

    try {
      const paramsBase = [{ name: "@take", value: take }];
      if (qRaw) paramsBase.push({ name: "@q", value: qRaw.toLowerCase() });

      let items = [];

      if (sort === "manu") {
        // Cosmos cannot ORDER BY expressions like IS_DEFINED(...).
        // Do two queries: first with manu present, then fill remainder with manu missing.
        const whereText = qRaw ? `AND (${textFilterSql()})` : "";

        const sqlHasManu = `
          SELECT TOP @take c.id, c.company_name, c.industries, c.url, c.amazon_url,
                           c.normalized_domain, c.created_at, c.session_id, c._ts,
                           c.manufacturing_locations
          FROM c
          WHERE IS_DEFINED(c.manufacturing_locations)
            AND ARRAY_LENGTH(c.manufacturing_locations) > 0
            ${whereText}
          ORDER BY c._ts DESC
        `;
        const { resources: partA } = await cos.container.items
          .query({ query: sqlHasManu, parameters: paramsBase }, { enableCrossPartitionQuery: true })
          .fetchAll();

        items = partA || [];
        const remaining = Math.max(0, take - items.length);

        if (remaining > 0) {
          const sqlNoManu = `
            SELECT TOP @take2 c.id, c.company_name, c.industries, c.url, c.amazon_url,
                              c.normalized_domain, c.created_at, c.session_id, c._ts,
                              c.manufacturing_locations
            FROM c
            WHERE (NOT IS_DEFINED(c.manufacturing_locations) OR ARRAY_LENGTH(c.manufacturing_locations) = 0)
              ${whereText}
            ORDER BY c._ts DESC
          `;
          const paramsB = paramsBase
            .filter(p => p.name !== "@take")
            .concat({ name: "@take2", value: remaining });

          const { resources: partB } = await cos.container.items
            .query({ query: sqlNoManu, parameters: paramsB }, { enableCrossPartitionQuery: true })
            .fetchAll();

          items = items.concat(partB || []);
        }
      } else {
        // Single query sorts that Cosmos supports natively
        let orderBy;
        if (sort === "name") orderBy = "ORDER BY c.company_name ASC";
        else orderBy = "ORDER BY c._ts DESC"; // recent (default)

        let sql, parameters = paramsBase;
        if (qRaw) {
          sql = `
            SELECT TOP @take c.id, c.company_name, c.industries, c.url, c.amazon_url,
                             c.normalized_domain, c.created_at, c.session_id, c._ts
            FROM c
            WHERE ${textFilterSql()}
            ${orderBy}
          `;
        } else {
          sql = `
            SELECT TOP @take c.id, c.company_name, c.industries, c.url, c.amazon_url,
                             c.normalized_domain, c.created_at, c.session_id, c._ts
            FROM c
            ${orderBy}
          `;
        }

        const { resources } = await cos.container.items
          .query({ query: sql, parameters }, { enableCrossPartitionQuery: true })
          .fetchAll();
        items = resources || [];
      }

      // Ensure created_at is present (fallback from _ts)
      const normalized = items.map((r) => {
        if (!r?.created_at && typeof r?._ts === "number") {
          try { r.created_at = new Date(r._ts * 1000).toISOString(); } catch {}
        }
        return r;
      });

      return json({ items: normalized, count: normalized.length, meta: { q: qRaw, sort } }, 200, req);
    } catch (e) {
      ctx.log("search-companies error:", e?.message || e);
      return json({ error: e?.message || "query failed" }, 500, req);
    }
  }
});
