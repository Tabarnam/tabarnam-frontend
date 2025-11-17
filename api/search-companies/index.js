// api/search-companies/index.js
import { app } from "@azure/functions";
import { httpRequest } from "../_http.js";
import { getProxyBase } from "../_shared.js";

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

// Lazy-load Cosmos only if present
let CosmosClientCtor = null;
function loadCosmosCtor() {
  if (CosmosClientCtor !== null) return CosmosClientCtor;
  try {
    const cosmos = await import("@azure/cosmos");
    CosmosClientCtor = cosmos.CosmosClient;
  } catch {
    CosmosClientCtor = undefined;
  }
  return CosmosClientCtor;
}

function getCompaniesContainer() {
  const endpoint = env("COSMOS_DB_ENDPOINT", "");
  const key = env("COSMOS_DB_KEY", "");
  const databaseId = env("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");

  if (!endpoint || !key) return null;
  const C = loadCosmosCtor();
  if (!C) return null;

  const client = new C({ endpoint, key });
  return client.database(databaseId).container(containerId);
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

    // 1) Proxy to upstream if configured
    const base = getProxyBase();
    if (base) {
      try {
        const proxyUrl = `${base}/search-companies?q=${encodeURIComponent(qRaw)}&take=${encodeURIComponent(take)}&sort=${encodeURIComponent(sort)}`;
        const out = await httpRequest("GET", proxyUrl);
        let body = out.body;
        try {
          body = JSON.parse(body);
        } catch {}
        return json(body, out.status || 200, req);
      } catch (e) {
        context.log("search-companies proxy error:", e?.message || e);
      }
    }

    // 2) Cosmos DB path
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
                             c.manufacturing_locations
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
                                c.manufacturing_locations
              FROM c
              WHERE (NOT IS_DEFINED(c.manufacturing_locations) OR ARRAY_LENGTH(c.manufacturing_locations) = 0)
              ${whereText}
              ORDER BY c._ts DESC
            `;
            const paramsB = params.filter((p) => p.name !== "@take").concat({ name: "@take2", value: remaining });
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
                               c.normalized_domain, c.created_at, c.session_id, c._ts
              FROM c
              WHERE ${SQL_TEXT_FILTER}
              ${orderBy}
            `
            : `
              SELECT TOP @take c.id, c.company_name, c.industries, c.url, c.amazon_url,
                               c.normalized_domain, c.created_at, c.session_id, c._ts
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
        context.log("search-companies cosmos error:", e?.message || e);
        return json({ ok: false, success: false, error: e?.message || "query failed" }, 500, req);
      }
    }

    // 3) Stub (no proxy and no cosmos)
    const baseItems = [
      {
        id: "stub1",
        company_name: "Acme Candles",
        url: "https://example.com",
        product_keywords: "candles, wax",
        confidence_score: 0.9,
      },
      {
        id: "stub2",
        company_name: "Glow Co.",
        url: "https://example.org",
        product_keywords: "candles, aroma",
        confidence_score: 0.86,
      },
    ];
    const items = baseItems.slice(skip, skip + take);

    return json(
      { ok: true, success: true, q: qRaw, skip, take, count: baseItems.length, items },
      200,
      req
    );
  },
});