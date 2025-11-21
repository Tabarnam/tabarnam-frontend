// api/import-progress/index.js
const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");
const { httpRequest } = require("../_http");
const { getProxyBase } = require("../_shared");

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

async function saveCompaniesToCosmos(companies, sessionId) {
  try {
    const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
    const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

    if (!endpoint || !key) {
      console.warn("[import-progress] Cosmos DB not configured, skipping save");
      return { saved: 0, failed: 0 };
    }

    const client = new CosmosClient({ endpoint, key });
    const database = client.database(databaseId);
    const container = database.container(containerId);

    let saved = 0;
    let failed = 0;

    for (const company of companies) {
      try {
        const doc = {
          id: `company_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          company_name: company.company_name || company.name || "",
          name: company.name || company.company_name || "",
          url: company.url || company.website_url || company.canonical_url || "",
          website_url: company.website_url || company.canonical_url || company.url || "",
          industries: company.industries || [],
          product_keywords: company.product_keywords || "",
          hq_lat: company.hq_lat,
          hq_lng: company.hq_lng,
          social: company.social || {},
          amazon_url: company.amazon_url || "",
          source: "xai_import",
          session_id: sessionId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        if (!doc.company_name && !doc.url) {
          failed++;
          continue;
        }

        await container.items.create(doc);
        saved++;
      } catch (e) {
        failed++;
        console.warn(`[import-progress] Failed to save company: ${e.message}`);
      }
    }

    return { saved, failed };
  } catch (e) {
    console.error("[import-progress] Error in saveCompaniesToCosmos:", e.message);
    return { saved: 0, failed: companies?.length || 0 };
  }
}

app.http("importProgress", {
  route: "import/progress",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    const sessionId = new URL(req.url).searchParams.get("session_id");
    const take = Number(new URL(req.url).searchParams.get("take") || "200") || 200;
    if (!sessionId) return json({ error: "session_id is required" }, 400, req);

    console.log(`[import-progress] Polling for session_id: ${sessionId}, take: ${take}`);

    const endpoint   = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
    const key        = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId= (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

    if (!endpoint || !key) {
      console.error("[import-progress] Cosmos DB not configured");
      return json({ error: "Cosmos not configured" }, 500, req);
    }

    const client    = new CosmosClient({ endpoint, key });
    const container = client.database(databaseId).container(containerId);

    try {
      // First, try to get companies from Cosmos DB
      const q = {
        query: `
          SELECT TOP @take c.id, c.company_name, c.name, c.url, c.website_url, c.industries, c.product_keywords, c.created_at
          FROM c
          WHERE c.session_id = @sid
          ORDER BY c.created_at DESC
        `,
        parameters: [
          { name: "@sid", value: sessionId },
          { name: "@take", value: take }
        ],
      };
      const { resources } = await container.items.query(q, { enableCrossPartitionQuery: true }).fetchAll();
      const saved = resources.length || 0;
      const lastCreatedAt = resources?.[0]?.created_at || "";

      console.log(`[import-progress] Found ${saved} companies in Cosmos DB for session ${sessionId}`);

      // If no results in Cosmos, try to fetch from external API's /import/status endpoint
      if (saved === 0) {
        const base = getProxyBase();
        console.log(`[import-progress] No Cosmos results, checking external API. Base: '${base}'`);

        if (base) {
          try {
            const statusUrl = `${base}/import/status?session_id=${encodeURIComponent(sessionId)}&take=${encodeURIComponent(take)}`;
            console.log(`[import-progress] Fetching from external API: ${statusUrl}`);
            const startTime = Date.now();
            const out = await httpRequest("GET", statusUrl);
            const elapsed = Date.now() - startTime;
            console.log(`[import-progress] External API response after ${elapsed}ms, status: ${out.status}`);
            console.log(`[import-progress] Response body length: ${out.body?.length || 0} chars`);
            console.log(`[import-progress] Response body (first 500 chars):`, out.body?.substring(0, 500) || '');

            if (out.status >= 200 && out.status < 300) {
              let statusBody;
              try {
                statusBody = JSON.parse(out.body);
              } catch (parseErr) {
                console.warn(`[import-progress] Failed to parse JSON: ${parseErr.message}`);
                statusBody = {};
              }

              const companies = statusBody?.companies || statusBody?.results || statusBody?.items || [];
              console.log(`[import-progress] Found ${companies.length} companies in external API response`);

              if (Array.isArray(companies) && companies.length > 0) {
                const saveResult = await saveCompaniesToCosmos(companies, sessionId);
                console.log(`[import-progress] Saved ${saveResult.saved} companies from external API, failed: ${saveResult.failed}`);
                return json({
                  ok: true,
                  session_id: sessionId,
                  items: companies.slice(0, take),
                  steps: [],
                  stopped: statusBody?.completed || statusBody?.stopped || false,
                  saved: companies.length,
                  lastCreatedAt: companies[0]?.created_at || ""
                }, 200, req);
              }
            } else {
              console.warn(`[import-progress] External API error status: ${out.status}`);
            }
          } catch (e) {
            console.warn(`[import-progress] Failed to fetch from external API: ${e.message}`);
            console.error(`[import-progress] Full error:`, e);
          }
        }
      }

      return json({
        ok: true,
        session_id: sessionId,
        items: resources,
        steps: [],
        stopped: false,
        saved,
        lastCreatedAt
      }, 200, req);
    } catch (e) {
      console.error("[import-progress] Query error:", e.message);
      console.error("[import-progress] Full error:", e);
      return json({ error: "query failed", detail: e?.message || String(e) }, 500, req);
    }
  },
});
