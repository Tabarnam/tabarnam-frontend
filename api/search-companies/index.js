// api/search-companies/index.js
import { app } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";

const E = (k, d = "") => (process.env[k] ?? d).toString().trim();

const cors = (req) => {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
};
const json = (obj, status = 200, req) => ({
  status,
  headers: { ...cors(req), "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

let cosmosClient;
function getCompaniesContainer() {
  const endpoint = E("COSMOS_DB_ENDPOINT");
  const key = E("COSMOS_DB_KEY");
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_COMPANIES_CONTAINER", "companies");
  if (!endpoint || !key) return null;
  cosmosClient ||= new CosmosClient({ endpoint, key });
  return cosmosClient.database(databaseId).container(containerId);
}

const textFilterSql = `
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
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    const url = new URL(req.url);
    const qRaw = (url.searchParams.get("q") || "").trim();
    const qLower = qRaw.toLowerCase();
    const sort = (url.searchParams.get("sort") || "recent").toLowerCase(); // recent | name | manu
    const take = Math.min(200, Math.max(1, Number(url.searchParams.get("take") || 50)));

    const container = getCompaniesContainer();
    if (!container) return json({ error: "Cosmos not configured" }, 500, req);

    try {
      let items = [];
      const params = [{ name: "@take", value: take }];

      if (qLower) params.push({ name: "@q", value: qLower });

      if (sort === "manu") {
        const whereText = qLower ? `AND (${textFilterSql})` : "";

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
        const { resources: partA } = await container.items
          .query({ query: sqlA, parameters: params }, { enableCrossPartitionQuery: true })
          .fetchAll();
        items = partA || [];

        // B) Fill remainder without manufacturing data
        const remaining = Math.max(0, take - items.length);
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
          const paramsB = params
            .filter((p) => p.name !== "@take")
            .concat({ name: "@take2", value: remaining });
          const { resources: partB } = await container.items
            .query({ query: sqlB, parameters: paramsB }, { enableCrossPartitionQuery: true })
            .fetchAll();
          items = items.concat(partB || []);
        }
      } else {
        const orderBy = sort === "name" ? "ORDER BY c.company_name ASC" : "ORDER BY c._ts DESC";
        const sql = qLower
          ? `
            SELECT TOP @take c.id, c.company_name, c.industries, c.url, c.amazon_url,
                             c.normalized_domain, c.created_at, c.session_id, c._ts
            FROM c
            WHERE ${textFilterSql}
            ${orderBy}
          `
          : `
            SELECT TOP @take c.id, c.company_name, c.industries, c.url, c.amazon_url,
                             c.normalized_domain, c.created_at, c.session_id, c._ts
            FROM c
            ${orderBy}
          `;
        const { resources } = await container.items
          .query({ query: sql, parameters: params }, { enableCrossPartitionQuery: true })
          .fetchAll();
        items = resources || [];
      }

      const normalized = items.map((r) => {
        if (!r?.created_at && typeof r?._ts === "number") {
          try {
            r.created_at = new Date(r._ts * 1000).toISOString();
          } catch {}
        }
        return r;
      });

      return json({ items: normalized, count: normalized.length, meta: { q: qRaw, sort } }, 200, req);
    } catch (e) {
      ctx.log("search-companies error:", e?.message || e);
      return json({ error: e?.message || "query failed" }, 500, req);
    }
  },
});
