// Public geocode proxy: thin wrapper around Google's Geocoding API.
//
// The frontend (src/lib/google.js) calls POST /api/google/geocode with a
// body shaped like { address?, lat?, lng?, ipLookup? } and expects a
// response shaped like:
//   { best: { location: { lat, lng }, formatted_address?, address_components?, components?, types? } }
//
// We forward to Google, normalize the top result, and surface the structured
// components both as `address_components` (Google's native shape) and as
// `components` (legacy alias the frontend also reads). On any failure we
// return a 502 with { error } so the caller can degrade gracefully.

let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const axios = require("axios");

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function getApiKey() {
  return (
    env("GOOGLE_MAPS_KEY") ||
    env("GOOGLE_GEOCODE_KEY") ||
    env("GOOGLE_GEOCODING_API_KEY") ||
    env("GOOGLE_MAPS_API_KEY") ||
    ""
  );
}

function getHeader(req, name) {
  if (!req || !req.headers) return "";
  const headers = req.headers;
  if (typeof headers.get === "function") {
    try {
      return headers.get(name) || headers.get(name.toLowerCase()) || "";
    } catch {
      return "";
    }
  }
  return headers[name] || headers[name.toLowerCase()] || "";
}

function cors(req) {
  const origin = getHeader(req, "origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
  };
}

function json(body, status, req) {
  return {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function getJson(req) {
  if (!req) return {};
  if (typeof req.json === "function") {
    try {
      const val = await req.json();
      if (val && typeof val === "object") return val;
    } catch {}
  }
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try {
      const parsed = JSON.parse(req.body);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  if (typeof req.rawBody === "string" && req.rawBody) {
    try {
      const parsed = JSON.parse(req.rawBody);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return {};
}

function toFiniteNumber(v) {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

function shapeBest(googleResult) {
  if (!googleResult || typeof googleResult !== "object") return null;
  const loc = googleResult?.geometry?.location;
  const lat = toFiniteNumber(loc?.lat);
  const lng = toFiniteNumber(loc?.lng);
  if (lat == null || lng == null) return null;
  const components = Array.isArray(googleResult.address_components) ? googleResult.address_components : [];
  return {
    location: { lat, lng },
    formatted_address: googleResult.formatted_address || "",
    // Both names so callers reading either work — frontend uses both `address_components`
    // and `components` interchangeably across the codebase.
    address_components: components,
    components,
    types: Array.isArray(googleResult.types) ? googleResult.types : [],
    place_id: googleResult.place_id || "",
    partial_match: Boolean(googleResult.partial_match),
  };
}

async function geocodeByAddress(address, key, timeoutMs) {
  const res = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
    params: { address, key },
    timeout: timeoutMs,
    validateStatus: () => true,
  });
  const status = String(res?.data?.status || "").toUpperCase();
  const results = Array.isArray(res?.data?.results) ? res.data.results : [];
  return { status, results };
}

async function geocodeByLatLng(lat, lng, key, timeoutMs) {
  const res = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
    params: { latlng: `${lat},${lng}`, key },
    timeout: timeoutMs,
    validateStatus: () => true,
  });
  const status = String(res?.data?.status || "").toUpperCase();
  const results = Array.isArray(res?.data?.results) ? res.data.results : [];
  return { status, results };
}

async function geocodeByIp(timeoutMs, req) {
  // Google doesn't expose an IP-geolocation API on the standard Maps key. We
  // do a lightweight best-effort using the request's caller IP via a free
  // service — but only if the env opts in. Most deployments will leave this
  // off and the frontend will degrade to "no proximity center", which is the
  // intended behavior per the proximity-is-a-hint principle.
  const ipUrl = env("IP_GEOLOCATION_URL");
  if (!ipUrl) return { status: "ZERO_RESULTS", results: [] };

  const ip = getHeader(req, "x-forwarded-for").split(",")[0].trim() || getHeader(req, "x-azure-clientip");
  if (!ip) return { status: "ZERO_RESULTS", results: [] };

  try {
    const r = await axios.get(`${ipUrl}${encodeURIComponent(ip)}`, {
      timeout: timeoutMs,
      validateStatus: () => true,
    });
    const lat = toFiniteNumber(r?.data?.latitude ?? r?.data?.lat);
    const lng = toFiniteNumber(r?.data?.longitude ?? r?.data?.lng ?? r?.data?.lon);
    if (lat == null || lng == null) return { status: "ZERO_RESULTS", results: [] };
    return {
      status: "OK",
      results: [{
        geometry: { location: { lat, lng } },
        formatted_address: r?.data?.city ? `${r.data.city}, ${r.data.country_name || ""}`.trim() : "",
        address_components: r?.data?.country_code ? [{ short_name: r.data.country_code, long_name: r.data.country_name || "", types: ["country"] }] : [],
        types: ["approximate"],
      }],
    };
  } catch {
    return { status: "ZERO_RESULTS", results: [] };
  }
}

async function handler(req, context) {
  const method = String(req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return { status: 200, headers: cors(req) };
  }
  if (method !== "POST") {
    return json({ error: "Method not allowed" }, 405, req);
  }

  const body = await getJson(req);
  const address = typeof body?.address === "string" ? body.address.trim() : "";
  const lat = toFiniteNumber(body?.lat);
  const lng = toFiniteNumber(body?.lng);
  const ipLookup = body?.ipLookup === true;

  if (!address && !(lat != null && lng != null) && !ipLookup) {
    return json({ error: "address, lat/lng, or ipLookup required" }, 400, req);
  }

  const key = getApiKey();
  if (!key && !ipLookup) {
    return json({ error: "geocode unavailable: no API key configured" }, 503, req);
  }

  const timeoutMs = Math.min(15000, Math.max(2000, toFiniteNumber(body?.timeoutMs) || 5000));

  try {
    let response;
    if (address) response = await geocodeByAddress(address, key, timeoutMs);
    else if (lat != null && lng != null) response = await geocodeByLatLng(lat, lng, key, timeoutMs);
    else response = await geocodeByIp(timeoutMs, req);

    if (response.status !== "OK" || response.results.length === 0) {
      return json({ error: "geocode failed", status: response.status, best: null }, 502, req);
    }

    const best = shapeBest(response.results[0]);
    if (!best) {
      return json({ error: "geocode result missing coordinates", best: null }, 502, req);
    }

    return json({ best, status: response.status }, 200, req);
  } catch (e) {
    context.log("[google-geocode] error", e?.message || String(e));
    return json({ error: "geocode failed", detail: e?.message || String(e) }, 502, req);
  }
}

app.http("googleGeocode", {
  route: "google/geocode",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler,
});

module.exports = { handler };
