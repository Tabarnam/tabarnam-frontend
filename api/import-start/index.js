const { app } = require("@azure/functions");
const axios = require("axios");
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

// Helper: normalize industries array
function normalizeIndustries(input) {
  if (Array.isArray(input))
    return [...new Set(input.map((s) => String(s).trim()).filter(Boolean))];
  if (typeof input === "string")
    return [
      ...new Set(
        input
          .split(/[,;|]/)
          .map((s) => s.trim())
          .filter(Boolean)
      ),
    ];
  return [];
}

// Helper: normalize keywords
function normalizeKeywords(value, industries) {
  let kws = [];
  if (Array.isArray(value)) for (const v of value) kws.push(...String(v).split(","));
  else if (typeof value === "string") kws.push(...value.split(","));
  kws = kws.map((s) => s.trim()).filter(Boolean);
  const merged = [...new Set([...(kws || []), ...(industries || [])])].filter(Boolean);
  while (merged.length && merged.length < 5) merged.push(merged[merged.length - 1]);
  return merged.join(", ");
}

// Helper: get safe number
const safeNum = (n) => (Number.isFinite(Number(n)) ? Number(n) : undefined);

// Helper: parse center coordinates
function safeCenter(c) {
  const lat = safeNum(c?.lat),
    lng = safeNum(c?.lng);
  return lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
}

// Helper: get normalized domain
const toNormalizedDomain = (s = "") => {
  try {
    const u = s.startsWith("http") ? new URL(s) : new URL(`https://${s}`);
    let h = u.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h || "unknown";
  } catch {
    return "unknown";
  }
};

// Helper: enrich company data
function enrichCompany(company, center) {
  const c = { ...(company || {}) };
  c.industries = normalizeIndustries(c.industries);
  c.product_keywords = normalizeKeywords(c.product_keywords, c.industries);
  const urlForDomain = c.canonical_url || c.url || "";
  c.normalized_domain = toNormalizedDomain(urlForDomain);
  return c;
}

// Save companies to Cosmos DB
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

    const startTime = Date.now();

    try {
      const center = safeCenter(bodyObj.center);
      const xaiPayload = {
        queryType: bodyObj.queryType || "product_keyword",
        query: bodyObj.query || "",
        limit: Math.max(1, Math.min(Number(bodyObj.limit) || 10, 25)),
        expand_if_few: bodyObj.expand_if_few ?? true,
        session_id: sessionId,
        ...(center ? { center } : {}),
      };

      console.log(`[import-start] XAI Payload:`, JSON.stringify(xaiPayload));

      const timeout = Math.max(1000, Number(bodyObj.timeout_ms) || 600000);
      console.log(`[import-start] Request timeout: ${timeout}ms`);

      // Determine proxy URL - use local proxy-xai endpoint
      const localApiBase = String(process.env.VITE_API_BASE || process.env.API_BASE || "").trim();
      const proxyUrl = localApiBase
        ? `${localApiBase}/proxy-xai`
        : "http://localhost:7071/api/proxy-xai";

      console.log(`[import-start] Calling XAI via proxy at: ${proxyUrl}`);
      console.log(`[import-start] FUNCTION_URL: ${(process.env.FUNCTION_URL || "").trim() || "NOT SET"}`);
      console.log(`[import-start] XAI_EXTERNAL_BASE: ${(process.env.XAI_EXTERNAL_BASE || "").trim() || "NOT SET"}`);

      try {
        const xaiResponse = await axios.post(proxyUrl, xaiPayload, {
          headers: {
            "Content-Type": "application/json",
          },
          timeout: timeout,
        });

        const elapsed = Date.now() - startTime;
        console.log(`[import-start] XAI response received after ${elapsed}ms, status: ${xaiResponse.status}`);
        console.log(`[import-start] XAI response data:`, JSON.stringify(xaiResponse.data).substring(0, 500));

        if (xaiResponse.status >= 200 && xaiResponse.status < 300) {
          // Extract companies from XAI response
          const companies = Array.isArray(xaiResponse.data?.companies) ? xaiResponse.data.companies : [];
          console.log(`[import-start] Found ${companies.length} companies in XAI response`);

          // Enrich companies
          const center = safeCenter(bodyObj.center);
          const enriched = companies.map((c) => enrichCompany(c, center));

          // Save to Cosmos DB
          if (enriched.length > 0) {
            const saveResult = await saveCompaniesToCosmos(enriched, sessionId);
            console.log(`[import-start] Saved ${saveResult.saved} companies, failed: ${saveResult.failed}`);
          }

          // Return success
          return json({
            ok: true,
            session_id: sessionId,
            companies: enriched,
            meta: xaiResponse.data?.meta || {},
            saved: companies.length,
          }, 200);
        } else {
          console.error(`[import-start] XAI error status: ${xaiResponse.status}`);
          return json(
            {
              ok: false,
              error: `XAI returned ${xaiResponse.status}`,
              session_id: sessionId,
              detail: xaiResponse.data,
            },
            502
          );
        }
      } catch (xaiError) {
        const elapsed = Date.now() - startTime;
        console.error(`[import-start] XAI request failed after ${elapsed}ms:`, xaiError.message);
        console.error(`[import-start] Error details:`, xaiError.response?.data || xaiError.toString());

        return json(
          {
            ok: false,
            error: `XAI call failed: ${xaiError.message}`,
            session_id: sessionId,
            detail: xaiError.response?.data,
          },
          502
        );
      }
    } catch (e) {
      console.error(`[import-start] Unexpected error:`, e.message);
      console.error(`[import-start] Full error:`, e);
      return json(
        {
          ok: false,
          error: `Server error: ${e.message}`,
          session_id: sessionId,
        },
        500
      );
    }
  },
});
