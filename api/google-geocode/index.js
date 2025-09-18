// Azure Functions v4 HTTP trigger: POST /api/google/geocode
import { app } from "@azure/functions";

// ---------- tiny in-memory cache (per warm instance) ----------
const TTL_MS = 1000 * 60 * 60 * 6; // 6h
const MAX = 500;
const cache = new Map();
const now = () => Date.now();
const makeKey = (o) => JSON.stringify(o);
const get = (k) => {
  const v = cache.get(k);
  if (!v) return null;
  if (now() - v.t > TTL_MS) { cache.delete(k); return null; }
  return v.d;
};
const set = (k, d) => {
  if (cache.size >= MAX) cache.delete(cache.keys().next().value);
  cache.set(k, { t: now(), d });
};

// ---------- helpers ----------
function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json; charset=utf-8",
  };
}
function json(obj, status = 200, req) {
  return { status, headers: cors(req), body: JSON.stringify(obj) };
}
function isNum(v){ return Number.isFinite(Number(v)); }
function pickEnv(...names){
  for (const n of names){
    const v = process.env[n];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}

async function googleAddressGeocode(API_KEY, address) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", API_KEY);
  const r = await fetch(url.toString(), { method: "GET" });
  const data = await r.json();
  if (!r.ok) throw new Error(`Google error ${r.status}`);
  return normalizeGeocode(data);
}
async function googleReverseGeocode(API_KEY, lat, lng) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("latlng", `${lat},${lng}`);
  url.searchParams.set("key", API_KEY);
  const r = await fetch(url.toString(), { method: "GET" });
  const data = await r.json();
  if (!r.ok) throw new Error(`Google error ${r.status}`);
  return normalizeGeocode(data);
}
function normalizeGeocode(resp) {
  const results = Array.isArray(resp?.results) ? resp.results : [];
  if (!results.length) return { results: [], best: null, lat: null, lng: null, raw: resp };

  const best = results[0];
  const location = best?.geometry?.location || {};
  const components = (best?.address_components || []).map(c => ({
    long_name: c.long_name,
    short_name: c.short_name,
    types: c.types
  }));
  return {
    results: results.map(r => ({
      formatted_address: r.formatted_address,
      location: r.geometry?.location || null,
      place_id: r.place_id,
      types: r.types || []
    })),
    best: {
      formatted_address: best.formatted_address,
      location,
      place_id: best.place_id,
      components
    },
    lat: typeof location.lat === "number" ? location.lat : null,
    lng: typeof location.lng === "number" ? location.lng : null,
    raw: resp
  };
}

// ---------- function ----------
app.http("googleGeocode", {
  route: "google/geocode",
  methods: ["POST","OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    let body = {};
    try { body = await req.json(); } catch {}
    const { address, lat, lng, ipLookup } = body || {};

    const API_KEY = pickEnv(
      "GOOGLE_GEOCODING_API_KEY",
      "GOOGLE_MAPS_API_KEY",
      "GOOGLE_GEOCODE_API_KEY"
    );

    // Quietly bail if no inputs; optionally try IP lookup
    const hasAddress = typeof address === "string" && address.trim() !== "";
    const hasLatLng = isNum(lat) && isNum(lng);

    if (!hasAddress && !hasLatLng) {
      if (ipLookup !== false) {
        try {
          const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
          const ipUrl = `https://ipapi.co/${ip || ""}/json/`;
          const ipResp = await fetch(ipUrl);
          const ipData = await ipResp.json().catch(() => ({}));
          if (isNum(ipData?.latitude) && isNum(ipData?.longitude) && API_KEY) {
            const geo = await googleReverseGeocode(API_KEY, ipData.latitude, ipData.longitude);
            return json({ ok: true, source: "ip", ...geo, ip: {
              city: ipData.city, region: ipData.region, country: ipData.country,
              lat: ipData.latitude, lng: ipData.longitude
            }}, 200, req);
          }
        } catch (e) {
          ctx.log?.warn?.("ip geolookup failed:", e?.message || e);
        }
      }
      // No inputs (or ip lookup failed): return quiet 200
      return json({ ok: false, reason: "empty_request", lat: null, lng: null }, 200, req);
    }

    // If address/latlng were provided but no API key, respond quietly
    if (!API_KEY) {
      return json({ ok: false, reason: "missing_api_key", lat: null, lng: null }, 200, req);
    }

    // Cache
    const key = makeKey({ address: hasAddress ? address.trim() : null, lat: hasLatLng ? Number(lat) : null, lng: hasLatLng ? Number(lng) : null });
    const hit = get(key);
    if (hit) return json({ ok: true, source: "cache", ...hit }, 200, req);

    try {
      const out = hasAddress
        ? await googleAddressGeocode(API_KEY, address.trim())
        : await googleReverseGeocode(API_KEY, Number(lat), Number(lng));

      set(key, out);
      return json({ ok: true, ...out }, 200, req);
    } catch (e) {
      ctx.log?.warn?.("google-geocode error:", e?.message || e);
      return json({ ok: false, reason: "fetch_error", message: e?.message || "Geocode fetch failed", lat: null, lng: null }, 200, req);
    }
  }
});
