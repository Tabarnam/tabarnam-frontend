const { app } = require("@azure/functions");
const { geocodeLocationEntry, normalizeLocationInput } = require("../_geocode");

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

function stripLatLngForForce(loc) {
  if (!loc || typeof loc !== "object") return loc;
  const out = { ...loc };
  delete out.lat;
  delete out.lng;
  delete out.latitude;
  delete out.longitude;
  delete out.lon;
  if (out.location && typeof out.location === "object") {
    const nextLoc = { ...out.location };
    delete nextLoc.lat;
    delete nextLoc.lng;
    delete nextLoc.latitude;
    delete nextLoc.longitude;
    delete nextLoc.lon;
    out.location = nextLoc;
  }
  return out;
}

app.http("adminGeocodeLocation", {
  route: "xadmin-api-geocode-location",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return { status: 200, headers: cors(req) };
    }

    if (method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405, req);
    }

    let body = await getJson(req);
    body = body && typeof body === "object" ? body : {};

    const timeoutMsRaw = body.timeoutMs ?? body.timeout_ms;
    const timeoutMs = Math.min(30000, Math.max(2000, Math.floor(toFiniteNumber(timeoutMsRaw) || 5000)));

    const force = body.force === true || body.force === "true" || body.force === 1;

    let input = body.location ?? body.loc ?? body.entry ?? body;
    if (typeof body.address === "string" && body.address.trim()) {
      input = { ...(typeof input === "object" && input ? input : {}), address: body.address.trim() };
    }

    input = normalizeLocationInput(input);
    if (!input) {
      return json({ ok: false, error: "location payload required" }, 400, req);
    }

    const location = force ? stripLatLngForForce(input) : input;

    try {
      const geocoded = await geocodeLocationEntry(location, { timeoutMs });
      return json({ ok: true, location: geocoded }, 200, req);
    } catch (e) {
      context.log("[admin-geocode-location] Failed", { message: e?.message || String(e) });
      return json({ ok: false, error: "geocode_failed", detail: e?.message || String(e) }, 500, req);
    }
  },
});
