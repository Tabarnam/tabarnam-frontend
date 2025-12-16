const { app } = require("@azure/functions");

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

async function googlePlacesAutocomplete({ input, country }) {
  const key = (process.env.GOOGLE_MAPS_KEY || "").trim();
  if (!key) return null;

  const params = new URLSearchParams();
  params.set("input", input);
  params.set("key", key);
  params.set("components", "country:" + (country || ""));

  const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params.toString()}`;
  const res = await fetch(url);
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
  const key = (process.env.GOOGLE_MAPS_KEY || "").trim();
  if (!key) return null;

  const params = new URLSearchParams();
  params.set("place_id", placeId);
  params.set("key", key);
  params.set("fields", "geometry,address_components");

  const url = `https://maps.googleapis.com/maps/api/place/details/json?${params.toString()}`;
  const res = await fetch(url);
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

async function handle(req) {
  if (req.method === "OPTIONS") {
    return { status: 200, headers: cors(req) };
  }

  const input = (req.query?.input || "").trim();
  const country = (req.query?.country || "").trim();
  const placeId = (req.query?.place_id || "").trim();

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
