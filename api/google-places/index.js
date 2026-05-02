// Public Places proxy: thin wrapper around Google's Places API.
//
// One endpoint handles two operations, switched by which query param is present:
//   GET /api/google/places?input=...&country=...   → autocomplete predictions
//   GET /api/google/places?place_id=...            → place details
//
// Frontend (src/lib/google.js) expects:
//   autocomplete: { predictions: [{ place_id, description, main_text, secondary_text }] }
//   details:      { components: [...address_components], geometry: { location: { lat, lng } } }
//
// We forward to Google, normalize the shape, and return 502 on upstream failure.

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
    env("GOOGLE_PLACES_KEY") ||
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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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

function getQueryParam(req, key) {
  // Newer @azure/functions Request object exposes .query as an object;
  // older runtimes use req.query as a Map-like or plain object on req.
  try {
    const url = new URL(req.url || "", "http://placeholder");
    const v = url.searchParams.get(key);
    if (v != null) return v;
  } catch {}
  if (req?.query) {
    if (typeof req.query.get === "function") return req.query.get(key) || "";
    if (typeof req.query === "object") return req.query[key] || "";
  }
  return "";
}

async function autocomplete(input, country, key, timeoutMs) {
  const params = { input, key };
  if (country) params.components = `country:${country.toLowerCase()}`;
  const res = await axios.get("https://maps.googleapis.com/maps/api/place/autocomplete/json", {
    params,
    timeout: timeoutMs,
    validateStatus: () => true,
  });
  const status = String(res?.data?.status || "").toUpperCase();
  const raw = Array.isArray(res?.data?.predictions) ? res.data.predictions : [];
  const predictions = raw.map((p) => ({
    place_id: p.place_id || "",
    description: p.description || "",
    // Google returns structured_formatting; the frontend reads main_text /
    // secondary_text. Provide both shapes for forward-compat.
    main_text: p?.structured_formatting?.main_text || "",
    secondary_text: p?.structured_formatting?.secondary_text || "",
  }));
  return { status, predictions };
}

async function details(placeId, key, timeoutMs) {
  const fields = [
    "address_component",
    "formatted_address",
    "geometry",
    "name",
    "place_id",
    "type",
  ].join(",");
  const res = await axios.get("https://maps.googleapis.com/maps/api/place/details/json", {
    params: { place_id: placeId, fields, key },
    timeout: timeoutMs,
    validateStatus: () => true,
  });
  const status = String(res?.data?.status || "").toUpperCase();
  const result = res?.data?.result || null;
  if (!result) return { status, body: null };
  return {
    status,
    body: {
      // Frontend reads `components` (alias) and `geometry.location`. Mirror
      // both names so any caller works.
      components: Array.isArray(result.address_components) ? result.address_components : [],
      address_components: Array.isArray(result.address_components) ? result.address_components : [],
      geometry: result.geometry || null,
      formatted_address: result.formatted_address || "",
      place_id: result.place_id || placeId,
      types: Array.isArray(result.types) ? result.types : [],
    },
  };
}

async function handler(req, context) {
  const method = String(req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return { status: 200, headers: cors(req) };
  }
  if (method !== "GET") {
    return json({ error: "Method not allowed" }, 405, req);
  }

  const input = (getQueryParam(req, "input") || "").trim();
  const placeId = (getQueryParam(req, "place_id") || "").trim();
  const country = (getQueryParam(req, "country") || "").trim();

  if (!input && !placeId) {
    return json({ error: "input or place_id required" }, 400, req);
  }

  const key = getApiKey();
  if (!key) {
    return json({ error: "places unavailable: no API key configured" }, 503, req);
  }

  const timeoutMs = 5000;

  try {
    if (placeId) {
      const { status, body } = await details(placeId, key, timeoutMs);
      if (!body || (status !== "OK" && status !== "ZERO_RESULTS")) {
        return json({ error: "place details failed", status }, 502, req);
      }
      return json(body, 200, req);
    }

    const { status, predictions } = await autocomplete(input, country, key, timeoutMs);
    // ZERO_RESULTS is a valid empty response — return 200 with empty array.
    if (status !== "OK" && status !== "ZERO_RESULTS") {
      return json({ error: "autocomplete failed", status, predictions: [] }, 502, req);
    }
    return json({ predictions, status }, 200, req);
  } catch (e) {
    context.log("[google-places] error", e?.message || String(e));
    return json({ error: "places failed", detail: e?.message || String(e) }, 502, req);
  }
}

app.http("googlePlaces", {
  route: "google/places",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler,
});

module.exports = { handler };
