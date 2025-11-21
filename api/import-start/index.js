const { app } = require("@azure/functions");
const { httpRequest } = require("../_http");
const { getProxyBase, json: sharedJson } = require("../_shared");
const { CosmosClient } = require("@azure/cosmos");

function json(obj, status = 200) {
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

async function saveCompaniesToCosmos(companies, sessionId) {
  try {
    const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
    const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

    if (!endpoint || !key) {
      console.warn("[import-start] Cosmos DB not configured, skipping save");
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
        console.warn(`[import-start] Failed to save company: ${e.message}`);
      }
    }

    return { saved, failed };
  } catch (e) {
    console.error("[import-start] Error in saveCompaniesToCosmos:", e.message);
    return { saved: 0, failed: companies?.length || 0 };
  }
}

app.http("importStart", {
  route: "import/start",
  methods: ["POST", "OPTIONS"],
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
        },
      };
    }

    const bodyObj = await req.json().catch(() => ({}));
    const sessionId = bodyObj.session_id || `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    console.log(`[import-start] Received request with session_id: ${sessionId}`);
    console.log(`[import-start] Request body:`, JSON.stringify(bodyObj));

    const base = getProxyBase();
    console.log(`[import-start] XAI_PROXY_BASE: '${process.env.XAI_PROXY_BASE || ''}'`);
    console.log(`[import-start] XAI_EXTERNAL_BASE: '${process.env.XAI_EXTERNAL_BASE || ''}'`);
    console.log(`[import-start] Using base: '${base}'`);

    if (base) {
      const proxyUrl = `${base}/import/start`;
      console.log(`[import-start] Proxying POST to: ${proxyUrl}`);
      console.log(`[import-start] Request timeout: 30000ms`);

      try {
        const startTime = Date.now();
        const out = await httpRequest("POST", proxyUrl, {
          headers: { "content-type": "application/json" },
          body: { ...bodyObj, session_id: sessionId },
        });
        const elapsed = Date.now() - startTime;

        console.log(`[import-start] Response received after ${elapsed}ms, status: ${out.status}`);
        console.log(`[import-start] Response headers:`, JSON.stringify(out.headers));
        console.log(`[import-start] Response body length: ${out.body?.length || 0} chars`);
        console.log(`[import-start] Response body (first 500 chars):`, out.body?.substring(0, 500) || '');

        let body = out.body;
        try {
          body = JSON.parse(out.body);
        } catch (parseErr) {
          console.warn(`[import-start] Failed to parse JSON response: ${parseErr.message}`);
        }

        if (out.status >= 200 && out.status < 300) {
          const companies = body?.companies || body?.results || [];
          console.log(`[import-start] Found ${companies.length} companies in response`);

          if (Array.isArray(companies) && companies.length > 0) {
            const saveResult = await saveCompaniesToCosmos(companies, sessionId);
            console.log(`[import-start] Saved ${saveResult.saved} companies from external API, failed: ${saveResult.failed}`);
          }

          return json({ ...body, session_id: sessionId, ok: true }, out.status);
        }

        console.error(`[import-start] Error response status: ${out.status}, body:`, body);
        return json({ ok: false, error: body || "Upstream error", session_id: sessionId }, out.status || 502);
      } catch (e) {
        console.error(`[import-start] Proxy error after ${Date.now() - startTime}ms:`, e.message);
        console.error(`[import-start] Full error:`, e);
        return json(
          { ok: false, error: `Proxy error: ${e.message || String(e)}`, session_id: sessionId },
          502
        );
      }
    }

    console.warn(`[import-start] No proxy base configured, returning stub response`);
    return json(
      { ok: true, session_id: sessionId, note: "XAI_PROXY_BASE not set; stub mode." },
      200
    );
  },
});
