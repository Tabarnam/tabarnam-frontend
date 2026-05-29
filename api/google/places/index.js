// Two levels up (api/google/places/ → api/_app.js); the previous "../_app"
// resolved to api/google/_app.js which doesn't exist, so the require silently
// failed, the fallback no-op app was used, and app.http() never registered
// the route — explaining why /api/google/places returned 404 in production
// even after api/index.js started require()-ing this file.
let app;
try {
  ({ app } = require("../../_app"));
} catch {
  app = { http() {} };
}
const { fetchWithTimeout } = require("../../_fetchWithTimeout");

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
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(body, status, req) {
  return {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// Match the env-var priority list used by api/_geocode.js so a single Azure
// App Setting (e.g. GOOGLE_GEOCODING_API_KEY, the name actually set on
// tabarnam-xai-dedicated) wires up both autocomplete and details.
function getApiKey() {
  return (
    process.env.GOOGLE_PLACES_KEY ||
    process.env.GOOGLE_MAPS_KEY ||
    process.env.GOOGLE_GEOCODE_KEY ||
    process.env.GOOGLE_GEOCODING_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    ""
  ).trim();
}

async function googlePlacesAutocomplete({ input, country }) {
  const key = getApiKey();
  if (!key) return null;

  const params = new URLSearchParams();
  params.set("input", input);
  params.set("key", key);
  // Only add the country bias when a country was actually provided. Sending
  // "components=country:" (empty value) makes Google return INVALID_REQUEST,
  // which is what /api/google/places?input=edinburgh (no country) was hitting.
  if (country) params.set("components", `country:${country.toLowerCase()}`);

  const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params.toString()}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || !Array.isArray(data.predictions)) return null;

  return {
    predictions: data.predictions.map((p) => ({
      place_id: p.place_id,
      description: p.description,
      main_text: p.main_text,
      secondary_text: p.secondary_text,
    })),
    status: data.status,
    source: "google_places",
  };
}

async function googlePlacesDetails({ placeId }) {
  const key = getApiKey();
  if (!key) return null;

  const params = new URLSearchParams();
  params.set("place_id", placeId);
  params.set("key", key);
  params.set("fields", "geometry,address_components");

  const url = `https://maps.googleapis.com/maps/api/place/details/json?${params.toString()}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || !data.result) return null;

  const result = data.result;
  const loc = result.geometry?.location;
  const components = Array.isArray(result.address_components)
    ? result.address_components.map((c) => ({
        long_name: c.long_name,
        short_name: c.short_name,
        types: c.types,
      }))
    : [];

  return {
    geometry: loc ? { lat: loc.lat, lng: loc.lng } : null,
    components,
    status: data.status,
    source: "google_places",
  };
}

// v4 Functions runtime exposes req.query as URLSearchParams, not a plain
// object. The previous req.query?.input gave undefined (URLSearchParams uses
// .get(name)) so every request returned 400 "Missing input or place_id"
// even when the param was clearly present in the URL. Try both shapes plus
// parsing the URL directly so this works across runtime versions.
function getQueryParam(req, key) {
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

async function handle(req) {
  if (req.method === "OPTIONS") {
    return { status: 200, headers: cors(req) };
  }

  const input = getQueryParam(req, "input").trim();
  const country = getQueryParam(req, "country").trim();
  const placeId = getQueryParam(req, "place_id").trim();

  if (!input && !placeId) {
    return json({ error: "Missing input or place_id parameter" }, 400, req);
  }

  let result = null;

  try {
    if (placeId) {
      result = await googlePlacesDetails({ placeId });
    } else {
      result = await googlePlacesAutocomplete({ input, country });
    }
  } catch (e) {
    console.error("Places API error:", e?.message);
    result = null;
  }

  if (!result) {
    return json({ error: "Places API request failed" }, 500, req);
  }

  return json(result, 200, req);
}

app.http("googlePlaces", {
  route: "google/places",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const res = await handle(req);
    return res;
  },
});
