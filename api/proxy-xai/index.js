// Azure Functions v4 HTTP trigger: GET/POST /api/proxy-xai
import { app } from "@azure/functions";
import axios from "axios";

/** ---- Helpers ---- */
function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-request-id",
  };
}
function json(obj, status = 200, req) {
  return { status, headers: { ...cors(req), "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
function safeCenter(c) {
  if (!c) return undefined;
  const lat = Number(c.lat), lng = Number(c.lng);
  return (Number.isFinite(lat) && Number.isFinite(lng)) ? { lat, lng } : undefined;
}
function normalizeIndustries(input) {
  if (Array.isArray(input)) return [...new Set(input.map(s => String(s).trim()).filter(Boolean))];
  if (typeof input === "string") return [...new Set(input.split(/[,;|]/).map(s => s.trim()).filter(Boolean))];
  return [];
}
function normalizeKeywords(value, industries) {
  let kws = [];
  if (Array.isArray(value)) for (const v of value) kws.push(...String(v).split(","));
  else if (typeof value === "string") kws.push(...value.split(","));
  kws = kws.map((s) => s.trim()).filter(Boolean);
  const merged = [...new Set([...kws, ...(industries || [])])].filter(Boolean);
  while (merged.length && merged.length < 5) merged.push(merged[merged.length - 1]);
  return merged.join(", ");
}

// FORCE our affiliate tag on Amazon urls
function ensureAmazonAffiliateTag(input) {
  if (!input) return { amazon_url: input, tagged: false };
  try {
    const url = new URL(input.startsWith("http") ? input : `https://${input}`);
    if (!/amazon\./i.test(url.hostname)) return { amazon_url: url.toString(), tagged: false };
    url.searchParams.set("tag", "tabarnam00-20"); // ← always overwrite
    return { amazon_url: url.toString(), tagged: true };
  } catch {
    return { amazon_url: input, tagged: false };
  }
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180, R = 3958.7613;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function enrichCompany(company, center) {
  const c = { ...(company || {}) };
  c.industries = normalizeIndustries(c.industries);
  c.product_keywords = normalizeKeywords(c.product_keywords, c.industries);
  const { amazon_url, tagged } = ensureAmazonAffiliateTag(c.amazon_url);
  c.amazon_url = amazon_url;
  c.amazon_url_tagged = tagged;
  if (center && Number.isFinite(c.hq_lat) && Number.isFinite(c.hq_lng)) {
    c.distance_miles = Number(haversineMiles(center.lat, center.lng, c.hq_lat, c.hq_lng).toFixed(1));
  }
  c.social = c.social || {};
  for (const k of ["linkedin", "instagram", "x", "twitter", "facebook", "tiktok", "youtube"]) {
    if (typeof c.social[k] !== "string") c.social[k] = c.social[k] || "";
  }
  return c;
}

/** Map legacy UI shape -> upstream shape */
function toUpstreamBody(input) {
  const center = safeCenter(input.center);
  // Already in upstream format
  if (input.queryType && input.query) {
    const limit = Number(input.limit || input.maxImports) || 5;
    return { queryType: String(input.queryType), query: String(input.query), limit, ...(center ? { center } : {}) };
  }
  // Legacy UI: { search: { field: value }, maxImports }
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
  // Fallback
  return { queryType: "product_keyword", query: String(input.query || "").trim() || "candles", limit: Number(input.limit) || 3, ...(center ? { center } : {}) };
}

app.http("proxyXai", {
  route: "proxy-xai",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    const started = Date.now();
    const vals = process.env || {};
    const XAI_STUB = (vals.XAI_STUB || "").trim() === "1";
    const baseUrl = (vals.FUNCTION_URL || "").trim();
    const funcKey = (vals.FUNCTION_KEY || "").trim();

    if (req.method === "GET") {
      const configured = { FUNCTION_URL: !!baseUrl, FUNCTION_KEY: !!funcKey, XAI_STUB: XAI_STUB === true };
      return json({ ok: true, route: "/api/proxy-xai", configured, now: new Date().toISOString() }, 200, req);
    }

    // POST
    let inbound = {};
    try { inbound = await req.json(); } catch {}
    if (XAI_STUB) {
      const center = safeCenter(inbound.center);
      const demo = [
        { company_name: "Carpigiani", industries: ["food & beverage","equipment"], hq_lat: 44.5, hq_lng: 11.3, amazon_url: "" },
        { company_name: "Bunn", industries: ["food & beverage","equipment"], hq_lat: 40.1, hq_lng: -91.6, amazon_url: "https://www.amazon.com/dp/B000" },
        { company_name: "Taylor Company", industries: ["food & beverage","equipment"], hq_lat: 41.9, hq_lng: -88.3, amazon_url: "" },
      ].map(c => enrichCompany(c, center));
      return json({ companies: demo, meta: { request_id: `stub_${Date.now()}`, model: "stub", latency_ms: Date.now() - started } }, 200, req);
    }

    if (!baseUrl || !funcKey) {
      return json({ error: "Server not configured (FUNCTION_URL / FUNCTION_KEY)" }, 500, req);
    }

    const upstreamBody = toUpstreamBody(inbound);
    const clientId = req.headers.get("x-client-request-id") || `req_${Math.random().toString(36).slice(2)}_${Date.now()}`;

    try {
      const res = await axios.post(baseUrl, upstreamBody, {
        headers: {
          "Content-Type": "application/json",
          "x-functions-key": funcKey,
          "x-client-request-id": clientId,
        },
        timeout: 90000,
        validateStatus: () => true, // pass through non-2xx
      });

      const contentType = res.headers?.["content-type"] || "application/json";
      if (res.status < 200 || res.status >= 300) {
        return { status: res.status, headers: { ...cors(req), "Content-Type": contentType }, body: typeof res.data === "string" ? res.data : JSON.stringify(res.data) };
      }

      const data = res.data;
      const center = safeCenter(inbound.center);
      const companies = Array.isArray(data?.companies) ? data.companies : [];
      const enriched = companies.map((c) => enrichCompany(c, center));

      return json({
        companies: enriched,
        meta: {
          request_id: clientId,
          model: data?.meta?.model || "unknown",
          token_usage: data?.meta?.token_usage || null,
          latency_ms: Date.now() - started,
          rate_limit_remaining: data?.meta?.rate_limit_remaining ?? null,
          warnings: Array.isArray(data?.meta?.warnings) ? data.meta.warnings : [],
        },
      }, 200, req);

    } catch (e) {
      return json({ error: e?.message || "Proxy error" }, 500, req);
    }
  },
});
