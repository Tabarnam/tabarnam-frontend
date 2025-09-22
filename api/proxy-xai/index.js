// api/proxy-xai/index.js (Azure Functions v4 programming model)
import { app } from "@azure/functions";
import axios from "axios";
import { CosmosClient } from "@azure/cosmos";

const BUILD_STAMP = "proxy-xai build 2025-09-07T22:35Z";

// ------------ helpers ------------
function toNormalizedDomain(urlOrHost = "") {
  try {
    const s = String(urlOrHost || "").trim();
    if (!s) return "unknown";
    const u = s.startsWith("http") ? new URL(s) : new URL(`https://${s}`);
    let h = u.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h || "unknown";
  } catch { return "unknown"; }
}
function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-request-id, x-session-id",
  };
}
function json(obj, status = 200, req) {
  return { status, headers: { ...cors(req), "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
function safeCenter(c) {
  if (!c) return undefined;
  const lat = Number(c.lat), lng = Number(c.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
}
function normalizeIndustries(input) {
  if (Array.isArray(input)) return [...new Set(input.map((s) => String(s).trim()).filter(Boolean))];
  if (typeof input === "string") return [...new Set(input.split(/[,;|]/).map((s) => s.trim()).filter(Boolean))];
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
    if (!/amazon\./i.test(url.hostname)) return { amazon_url: url.toString(), tagged: false };
    url.searchParams.set("tag", "tabarnam00-20");
    return { amazon_url: url.toString(), tagged: true };
  } catch { return { amazon_url: input, tagged: false }; }
}
function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180, R = 3958.7613;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function enrichCompany(company, center) {
  const c = { ...(company || {}) };
  c.industries = normalizeIndustries(c.industries);
  c.product_keywords = normalizeKeywords(c.product_keywords, c.industries);
  const { amazon_url, tagged } = ensureAmazonAffiliateTag(c.amazon_url);
  c.amazon_url = amazon_url; c.amazon_url_tagged = tagged;
  const urlForDomain = c.canonical_url || c.url || "";
  c.normalized_domain = toNormalizedDomain(urlForDomain);
  if (center && Number.isFinite(c.hq_lat) && Number.isFinite(c.hq_lng)) {
    c.distance_miles = Number(haversineMiles(center.lat, center.lng, c.hq_lat, c.hq_lng).toFixed(1));
  }
  c.social = c.social || {};
  for (const k of ["linkedin","instagram","x","twitter","facebook","tiktok","youtube"]) {
    if (typeof c.social[k] !== "string") c.social[k] = c.social[k] || "";
  }
  return c;
}

// Cosmos done-log
let cosmosClient = null;
function getLogsContainer() {
  const ep  = (process.env.COSMOS_DB_ENDPOINT || "").trim();
  const key = (process.env.COSMOS_DB_KEY || "").trim();
  const db  = (process.env.COSMOS_DB_DATABASE || "").trim();
  const ct  = (process.env.COSMOS_DB_LOGS_CONTAINER || "import_logs").trim();
  if (!ep || !key || !db || !ct) return null;
  cosmosClient ||= new CosmosClient({ endpoint: ep, key });
  return cosmosClient.database(db).container(ct);
}
async function writeDoneLog(sessionId, payload = {}) {
  try {
    const c = getLogsContainer(); if (!c) return;
    const doc = { id: `${Date.now()}-done-${Math.random().toString(36).slice(2)}`, session_id: sessionId, step: "done", msg: "import complete", ts: new Date().toISOString(), ...payload };
    await c.items.upsert(doc, { partitionKey: sessionId });
  } catch {}
}

// legacy mapper
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
  return { queryType: "product_keyword", query: String(input.query || "").trim() || "candles", limit: Number(input.limit) || 3, ...(center ? { center } : {}) };
}

// geo expansion helpers
const RINGS_MI = [25, 50, 100];
const BEARINGS_DEG = [0,45,90,135,180,225,270,315];
function offsetLatLng(lat0, lng0, miles, bearingDeg) {
  // small-distance approximation
  const latDelta = miles / 69.0;
  const lngDelta = (miles / (69.172 * Math.cos((lat0 * Math.PI) / 180))) || 0;
  const br = (bearingDeg * Math.PI) / 180;
  const ns = Math.cos(br), ew = Math.sin(br);
  return { lat: lat0 + ns * latDelta, lng: lng0 + ew * lngDelta };
}

// ------------ function ------------
app.http("proxyXai", {
  route: "proxy-xai",
  methods: ["GET","POST","OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    const started = Date.now();
    const vals = process.env || {};
    const XAI_STUB = (vals.XAI_STUB || "").trim() === "1";
    const baseUrl = (vals.FUNCTION_URL || "").trim();
    const funcKey = (vals.FUNCTION_KEY || "").trim();

    if (req.method === "GET") {
      return json({
        ok: true,
        route: "/api/proxy-xai",
        configured: { FUNCTION_URL: !!baseUrl, FUNCTION_KEY: !!funcKey, XAI_STUB: XAI_STUB === true },
        build: BUILD_STAMP,
        now: new Date().toISOString()
      }, 200, req);
    }

    let inbound = {};
    try { inbound = await req.json(); } catch {}
    const expandIfFew = inbound.expand_if_few !== false;   // default true

    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    const envDefault = Number(vals.XAI_TIMEOUT_MS);
    const requested = Number(inbound?.timeout_ms);
    const timeoutMs = clamp(Number.isFinite(requested) ? requested : Number.isFinite(envDefault) ? envDefault : 600000, 1000, 60*60*1000);

    const clientId = req.headers.get("x-client-request-id") || `req_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    const sessionId = String(inbound.session_id || req.headers.get("x-session-id") || clientId);

    const center = safeCenter(inbound.center);

    if (XAI_STUB) {
      const demo = [
        { company_name: "Carpigiani", industries: ["food & beverage","equipment"], hq_lat: 44.5, hq_lng: 11.3, amazon_url: "", url: "https://www.carpigiani.com" },
        { company_name: "Bunn", industries: ["food & beverage","equipment"], hq_lat: 40.1, hq_lng: -91.6, amazon_url: "https://www.amazon.com/dp/B000", url: "https://www.bunn.com" },
        { company_name: "Taylor Company", industries: ["food & beverage","equipment"], hq_lat: 41.9, hq_lng: -88.3, amazon_url: "", url: "https://www.taylor-company.com" },
      ].map((c) => enrichCompany(c, center));
      await writeDoneLog(sessionId, { saved: demo.length, mode: "stub" });
      return json({
        companies: demo,
        meta: {
          request_id: `stub_${Date.now()}`,
          session_id: sessionId,
          model: "stub",
          latency_ms: Date.now() - started,
          proxy: { status: "stub", timeout_ms: timeoutMs, build: BUILD_STAMP }
        }
      }, 200, req);
    }

    if (!baseUrl || !funcKey) {
      return json({ error: "Server not configured (FUNCTION_URL / FUNCTION_KEY)", meta: { proxy: { status: "misconfigured", build: BUILD_STAMP } } }, 500, req);
    }

    const upstreamBase = toUpstreamBody(inbound);
    upstreamBase.session_id = sessionId;

    const seen = new Map(); // normalized_domain -> company
    const desired = Number(inbound.limit || inbound.maxImports) || 5;
    let expanded = false;

    const callUpstream = async (body, perCallTimeout) => {
      const res = await axios.post(baseUrl, body, {
        headers: {
          "Content-Type": "application/json",
          "x-functions-key": funcKey,
          "x-client-request-id": clientId,
          "x-session-id": sessionId
        },
        timeout: perCallTimeout,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: () => true,
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`upstream ${res.status}`);
      const data = res.data || {};
      const companies = Array.isArray(data?.companies) ? data.companies : [];
      return companies;
    };

    try {
      // 1) initial call
      let perCallTimeout = Math.max(1500, timeoutMs - (Date.now() - started) - 2000);
      const firstCompanies = await callUpstream(upstreamBase, perCallTimeout);
      const firstEnriched = firstCompanies.map((c) => {
        const e = enrichCompany(c, center);
        if (!e.normalized_domain) e.normalized_domain = toNormalizedDomain(e.url || e.canonical_url || "");
        return e;
      });
      for (const e of firstEnriched) if (e.normalized_domain && !seen.has(e.normalized_domain)) seen.set(e.normalized_domain, e);

      // 2) expand if needed AND allowed
      if (center && expandIfFew && seen.size < desired) {
        expanded = true;
        outer: for (const r of RINGS_MI) {
          for (const b of BEARINGS_DEG) {
            if (seen.size >= desired) break outer;
            const { lat, lng } = offsetLatLng(center.lat, center.lng, r, b);
            const remaining = desired - seen.size;
            const body = { ...upstreamBase, center: { lat, lng }, limit: Math.min(Math.max(remaining, 1), 10) };
            perCallTimeout = Math.max(1200, timeoutMs - (Date.now() - started) - 1500);
            if (perCallTimeout < 1000) break outer;
            try {
              const more = await callUpstream(body, perCallTimeout);
              for (const c of more) {
                const e = enrichCompany(c, center); // distance kept vs original center
                const key = e.normalized_domain || toNormalizedDomain(e.url || e.canonical_url || "");
                if (key && !seen.has(key)) seen.set(key, e);
                if (seen.size >= desired) break;
              }
            } catch { /* ignore */ }
          }
        }
      }

      const finalList = Array.from(seen.values()).slice(0, desired);
      await writeDoneLog(sessionId, { saved: finalList.length, mode: "live", expanded });

      return json({
        companies: finalList,
        meta: {
          request_id: clientId,
          session_id: sessionId,
          model: "unknown",
          token_usage: null,
          latency_ms: Date.now() - started,
          rate_limit_remaining: null,
          warnings: [],
          proxy: { status: "ok", timeout_ms: timeoutMs, build: BUILD_STAMP, baseUrl, expanded }
        },
      }, 200, req);

    } catch (e) {
      const upstream = { status: e?.response?.status ?? null, statusText: e?.response?.statusText ?? null, code: e?.code ?? null, message: e?.message ?? "unknown error" };
      const remoteBody = e?.response?.data ?? null;
      return json({ error: "Upstream call failed", upstream, remoteBody, proxy: { status: "error", timeout_ms: timeoutMs, build: BUILD_STAMP, request_id: clientId, baseUrl, session_id: sessionId } }, e?.code === "ECONNABORTED" ? 504 : 500, req);
    }
  },
});
