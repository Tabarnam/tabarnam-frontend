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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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

async function lookupIpLocation() {
  try {
    const r = await fetch("https://ipapi.co/json/");
    if (!r.ok) return null;
    const data = await r.json();
    if (!data) return null;
    const lat = Number(data.latitude);
    const lng = Number(data.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const components = [];
    if (data.country_code) {
      components.push({ types: ["country"], short_name: data.country_code });
    }
    if (data.city) {
      components.push({ types: ["locality"], short_name: data.city, long_name: data.city });
    }
    return {
      best: {
        location: { lat, lng },
        components,
      },
      source: "ipapi",
    };
  } catch {
    return null;
  }
}

async function googleGeocode({ address, lat, lng }) {
  const key = (process.env.GOOGLE_MAPS_KEY || "").trim();
  if (!key) return null;

  const params = new URLSearchParams();
  if (typeof lat === "number" && typeof lng === "number") {
    params.set("latlng", `${lat},${lng}`);
  } else if (address) {
    params.set("address", address);
  } else {
    return null;
  }
  params.set("key", key);

  const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || !Array.isArray(data.results) || !data.results.length) return null;

  const first = data.results[0];
  const loc = first.geometry?.location;
  if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") return null;

  const components = Array.isArray(first.address_components)
    ? first.address_components.map((c) => ({
        long_name: c.long_name,
        short_name: c.short_name,
        types: c.types,
      }))
    : [];

  return {
    best: {
      location: { lat: loc.lat, lng: loc.lng },
      components,
    },
    raw: data,
    source: "google",
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
  if (typeof req.rawBody === "string" && req.rawBody) {
    try {
      const parsed = JSON.parse(req.rawBody);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return {};
}

async function handle(req) {
  if (req.method === "OPTIONS") {
    return { status: 204, headers: cors(req) };
  }

  let body = await getJson(req);
  body = body || {};

  const address = typeof body.address === "string" ? body.address.trim() : "";
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const hasLatLng = Number.isFinite(lat) && Number.isFinite(lng);
  const ipLookup = body.ipLookup === true || body.ipLookup === "true";

  let result = null;

  try {
    if (hasLatLng || address) {
      result = await googleGeocode({
        address,
        lat: hasLatLng ? lat : undefined,
        lng: hasLatLng ? lng : undefined,
      });
    }

    if (!result && ipLookup) {
      result = await lookupIpLocation();
    }
  } catch {
    result = null;
  }

  if (!result) {
    result = {
      best: {
        location: { lat: 34.0983, lng: -117.8076 },
        components: [{ types: ["country"], short_name: "US" }],
      },
      source: "fallback",
    };
  }

  return json(result, 200, req);
}

app.http("googleGeocode", {
  route: "google/geocode",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const res = await handle(req);
    return res;
  },
});
