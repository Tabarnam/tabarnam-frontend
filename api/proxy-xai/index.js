// api/proxy-xai/index.js  (Azure Functions v4, CommonJS)
const { app } = require("@azure/functions");
const axios = require("axios");
const { CosmosClient } = require("@azure/cosmos");

const BUILD_STAMP = "proxy-xai build 2025-10-01T02:55Z";

// ----- helpers -----
function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-client-request-id, x-session-id",
  };
}
function json(obj, status = 200, req) {
  return {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}
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
const safeNum = (n) => (Number.isFinite(Number(n)) ? Number(n) : undefined);
function safeCenter(c) {
  const lat = safeNum(c?.lat),
    lng = safeNum(c?.lng);
  return lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
}
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
function normalizeKeywords(value, industries) {
  let kws = [];
  if (Array.isArray(value)) for (const v of value) kws.push(...String(v).split(","));
  else if (typeof value === "string") kws.push(...value.split(","));
  kws = kws.map((s) => s.trim()).filter(Boolean);
  const merged = [...new Set([...(kws || []), ...(industries || [])])].filter(Boolean);
  while (merged.length && merged.length < 5) merged.push(merged[merged.length - 1]);
  return merged.join(", ");
}
function ensureAmazonAffiliateTag(input) {
  if (!input) return { amazon_url: input, tagged: false };
  try {
    const url = new URL(input.startsWith("http") ? input : `https://${input}`);
    if (!/amazon\./i.test(url.hostname))
      return { amazon_url: url.toString(), tagged: false };
    url.searchParams.set("tag", "tabarnam00-20");
    return { amazon_url: url.toString(), tagged: true };
  } catch {
    return { amazon_url: input, tagged: false };
  }
}
function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180,
    R = 3958.7613;
  const dLat = toRad(lat2 - lat1),
    dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function enrichCompany(company, center) {
  const c = { ...(company || {}) };
  c.industries = normalizeIndustries(c.industries);
  c.product_keywords = normalizeKeywords(c.product_keywords, c.industries);
  const { amazon_url, tagged } = ensureAmazonAffiliateTag(c.amazon_url);
  c.amazon_url = amazon_url;
  c.amazon_url_tagged = tagged;
  const urlForDomain = c.canonical_url || c.url || "";
  c.normalized_domain = toNormalizedDomain(urlForDomain);
  if (center && Number.isFinite(c.hq_lat) && Number.isFinite(c.hq_lng)) {
    c.distance_miles = Number(
      haversineMiles(center.lat, center.lng, c.hq_lat, c.hq_lng).toFixed(1)
    );
  }
  c.social = c.social || {};
  for (const k of ["linkedin", "instagram", "x", "twitter", "facebook", "tiktok", "youtube"]) {
    if (typeof c.social[k] !== "string") c.social[k] = c.social[k] || "";
  }
  return c;
}

// ----- optional Cosmos logging -----
let cosmosClient = null;
function getLogsContainer() {
  const ep = (process.env.COSMOS_DB_ENDPOINT || "").trim();
  const key = (process.env.COSMOS_DB_KEY || "").trim();
  const db = (process.env.COSMOS_DB_DATABASE || "").trim();
  const ct = (process.env.COSMOS_DB_LOGS_CONTAINER || "import_logs").trim();
  if (!ep || !key || !db || !ct) return null;
  cosmosClient ||= new CosmosClient({ endpoint: ep, key });
  return cosmosClient.database(db).container(ct);
}
async function writeDoneLog(sessionId, payload = {}) {
  try {
    const c = getLogsContainer();
    if (!c) return;
    const doc = {
      id: `${Date.now()}-done-${Math.random().toString(36).slice(2)}`,
      session_id: sessionId,
      step: "done",
      msg: "import complete",
      ts: new Date().toISOString(),
      ...payload,
    };
    await c.items.upsert(doc, { partitionKey: sessionId || "default" });
  } catch {}
}

// ----- upstream request shaping -----
function toUpstreamBody(input) {
  const center = safeCenter(input.center);
  if (input.queryType && input.query) {
    const limit = Number(input.limit || input.maxImports) || 5;
    return { queryType: String(input.queryType), query: String(input.query), limit, ...(center ? { center } : {}) };
  }
  if (input.search && typeof input.search === "object") {
    const [field, value] = Object.entries(input.search)[0] || [];
    const q = String(value || "").trim();
    const limit = Number(input.maxImports) || 5;
    let queryType = "product_keyword";
    switch (String(field || "").toLowerCase()) {
      case "product_keywords": queryType = "product_keyword"; break;
      case "industries": queryType = "industry"; break;
      case "company_name": queryType = "company_name"; break;
      case "headquarters_location": queryType = "hq_location"; break;
      case "manufacturing_locations": queryType = "manufacturing_location"; break;
      case "email_address": queryType = "email"; break;
      case "url": queryType = "url"; break;
      case "amazon_url": queryType = "amazon_url"; break;
      default: queryType = "product_keyword";
    }
    return { queryType, query: q, limit, ...(center ? { center } : {}) };
  }
  return {
    queryType: "product_keyword",
    query: String(input.query || "").trim() || "candles",
    limit: Number(input.limit) || 3,
    ...(center ? { center } : {}),
  };
}
function withCodeParam(baseUrl, key) {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("code", key);
    return url.toString();
  } catch {
    return baseUrl;
  }
}

// ----- XAI request formatting -----
function buildXaiMessage(queryType, query, limit, center) {
  const basePrompt = `You are a business research assistant. Find and return information about ${limit} companies or products based on this search.

Search query: "${query}"
Search type: ${queryType}

Format your response as a valid JSON array of company objects. Each object must have:
- company_name (string): The name of the company
- url (string): The company website URL
- industries (array): List of industry categories
- product_keywords (string): Comma-separated product keywords
- hq_lat (number, optional): Headquarters latitude
- hq_lng (number, optional): Headquarters longitude
- amazon_url (string, optional): Amazon storefront URL if applicable
- social (object, optional): Social media URLs {linkedin, instagram, x, twitter, facebook, tiktok, youtube}

Only return the JSON array, no other text.`;

  return {
    role: "user",
    content: basePrompt,
  };
}

function parseXaiResponse(responseText) {
  try {
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn("[proxy-xai] No JSON array found in response");
      return [];
    }
    const companies = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(companies)) {
      console.warn("[proxy-xai] Parsed response is not an array");
      return [];
    }
    return companies.filter((c) => c && typeof c === "object");
  } catch (e) {
    console.error("[proxy-xai] Failed to parse XAI response:", e.message);
    return [];
  }
}

// ----- function entrypoint -----
app.http("proxyXai", {
  route: "proxy-xai",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    const started = Date.now();
    const XAI_STUB = (process.env.XAI_STUB || "").trim() === "1";
    const baseUrl = (process.env.FUNCTION_URL || "").trim();
    const apiKey = (process.env.XAI_API_KEY || process.env.FUNCTION_KEY || "").trim();

    if (req.method === "GET") {
      return json(
        {
          ok: true,
          route: "/api/proxy-xai",
          configured: { FUNCTION_URL: !!baseUrl, XAI_API_KEY: !!apiKey, XAI_STUB },
          build: BUILD_STAMP,
          now: new Date().toISOString(),
        },
        200,
        req
      );
    }

    let inbound = {};
    try { inbound = await req.json(); } catch {}

    const center = safeCenter(inbound.center);

    // Stub mode
    if (XAI_STUB) {
      const demo = [
        { company_name: "Carpigiani", industries: ["food & beverage", "equipment"], hq_lat: 44.5, hq_lng: 11.3, url: "https://www.carpigiani.com" },
        { company_name: "Bunn", industries: ["food & beverage", "equipment"], hq_lat: 40.1, hq_lng: -91.6, amazon_url: "https://www.amazon.com/dp/B000", url: "https://www.bunn.com" },
      ].map((c) => enrichCompany(c, center));
      await writeDoneLog(inbound.session_id || "", { saved: demo.length, mode: "stub" });
      return json({ companies: demo, meta: { proxy: { status: "stub", build: BUILD_STAMP } } }, 200, req);
    }

    if (!baseUrl || !apiKey) {
      return json(
        { error: "Server not configured (FUNCTION_URL / XAI_API_KEY)", proxy: { status: "misconfigured", build: BUILD_STAMP } },
        500,
        req
      );
    }

    const upstreamData = toUpstreamBody(inbound);
    const queryType = upstreamData.queryType || "product_keyword";
    const query = upstreamData.query || "";
    const limit = upstreamData.limit || 5;

    const xaiRequest = {
      messages: [
        buildXaiMessage(queryType, query, limit, center),
      ],
      model: "grok-beta",
      temperature: 0.1,
      stream: false,
    };

    const xaiUrl = baseUrl;
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    };

    try {
      console.log("[proxy-xai] Calling XAI API at:", xaiUrl);
      console.log("[proxy-xai] Request body:", JSON.stringify(xaiRequest).substring(0, 200) + "...");

      const res = await axios.post(xaiUrl, xaiRequest, {
        headers,
        timeout: Math.max(1000, Number(process.env.XAI_TIMEOUT_MS) || 600000),
      });

      if (res.status < 200 || res.status >= 300) {
        return json(
          { error: "XAI returned non-2xx", upstream: { status: res.status, message: res.statusText }, proxy: { status: "upstream_error", build: BUILD_STAMP }, duration_ms: Date.now() - started },
          502,
          req
        );
      }

      console.log("[proxy-xai] XAI response status:", res.status);

      const responseText = res.data?.choices?.[0]?.message?.content || JSON.stringify(res.data);
      console.log("[proxy-xai] XAI response text:", responseText.substring(0, 200) + "...");

      const companies = parseXaiResponse(responseText);
      console.log("[proxy-xai] Parsed", companies.length, "companies from response");

      const enriched = companies.map((c) => enrichCompany(c, center));
      await writeDoneLog(inbound.session_id || "", { saved: enriched.length, mode: "live" });

      return json(
        { companies: enriched, meta: { proxy: { status: "ok", build: BUILD_STAMP }, upstream: { status: res.status } }, duration_ms: Date.now() - started },
        200,
        req
      );
    } catch (e) {
      const errorDetail = e?.response
        ? { status: e.response.status, message: e.response.statusText, data: e.response.data }
        : { message: e?.message || String(e), code: e?.code || null };

      console.error("[proxy-xai] XAI call failed:", e.message);
      console.error("[proxy-xai] Error detail:", errorDetail);

      return json(
        { error: "XAI call failed", detail: errorDetail, proxy: { status: "error", build: BUILD_STAMP }, duration_ms: Date.now() - started },
        502,
        req
      );
    }
  },
});
