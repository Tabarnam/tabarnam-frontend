// api/save-companies/index.js
import { app } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";

const GEOCODE_MAX_PER_REQUEST = 80; // HQ + manufacturing caps per request

app.http("saveCompanies", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "save-companies",
  handler: async (req) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    let body = {};
    try { body = await req.json(); } catch {}
    const companies = Array.isArray(body?.companies) ? body.companies : [];
    if (!companies.length) return json({ error: "companies array is required" }, 400, req);

    const endpoint = process.env.COSMOS_DB_ENDPOINT;
    const key = process.env.COSMOS_DB_KEY;
    const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
    const containerId = process.env.COSMOS_DB_CONTAINER || "companies";
    const pkPath = process.env.COSMOS_PARTITION_KEY || "/normalized_domain";
    const GOOGLE_KEY = process.env.GOOGLE_GEOCODING_API_KEY;

    if (!endpoint || !key) return json({ error: "Server not configured (COSMOS_DB_ENDPOINT / COSMOS_DB_KEY)" }, 500, req);

    const client = new CosmosClient({ endpoint, key });
    const { database } = await client.databases.createIfNotExists({ id: databaseId });
    const { container } = await database.containers.createIfNotExists({
      id: containerId,
      partitionKey: { kind: "Hash", paths: [pkPath] }
    });

    const geocodeCache = new Map();
    let geocodeCount = 0;

    const results = [];
    for (const raw of companies) {
      const c = normalizeCompany(raw);

      // --- Geocode HQ ---
      if (GOOGLE_KEY && c.headquarters_location && !(isNum(c.hq_lat) && isNum(c.hq_lng))) {
        if (geocodeCount < GEOCODE_MAX_PER_REQUEST) {
          const k = `hq:${c.headquarters_location.trim().toLowerCase()}`;
          let geo = geocodeCache.get(k);
          if (!geo) {
            geo = await safeGeocode(c.headquarters_location, GOOGLE_KEY); geocodeCount++;
            if (geo) geocodeCache.set(k, geo);
          }
          if (geo) {
            c.hq_lat = geo.lat; c.hq_lng = geo.lng;
            c.headquarters_location = geo.formatted_address || c.headquarters_location;
          }
        }
      }

      // --- Geocode Manufacturing Locations ---
      if (GOOGLE_KEY && Array.isArray(c.manufacturing_locations) && c.manufacturing_locations.length) {
        const geoList = [];
        for (const loc of c.manufacturing_locations) {
          if (!loc || geocodeCount >= GEOCODE_MAX_PER_REQUEST) break;
          const k = `manu:${String(loc).trim().toLowerCase()}`;
          let geo = geocodeCache.get(k);
          if (!geo) {
            geo = await safeGeocode(loc, GOOGLE_KEY); geocodeCount++;
            if (geo) geocodeCache.set(k, geo);
          }
          if (geo) {
            geoList.push({
              formatted_address: geo.formatted_address || String(loc),
              lat: geo.lat, lng: geo.lng
            });
          }
        }
        if (geoList.length) c.manufacturing_geocodes = geoList;
      }

      try {
        const { resource } = await container.items.upsert(c);
        results.push({ ok: true, id: resource.id, company_name: c.company_name, normalized_domain: c.normalized_domain });
      } catch (e) {
        results.push({ ok: false, company_name: c.company_name || null, error: e.message });
      }
    }

    const saved = results.filter(r => r.ok).length;
    const failed = results.length - saved;
    return json({ saved, failed, results }, 200, req);
  },
});

function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}
function json(obj, status = 200, req) {
  return { status, headers: { ...cors(req), "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
function isNum(v){ return Number.isFinite(v); }

function normalizeCompany(input) {
  const c = { ...(input || {}) };

  // industries -> array (normalize + dedupe)
  if (Array.isArray(c.industries)) {
    c.industries = uniq(c.industries.map(s => String(s).trim().toLowerCase()).filter(Boolean));
  } else if (typeof c.industries === "string") {
    c.industries = uniq(c.industries.split(/[,;|]/).map(s => s.trim().toLowerCase()).filter(Boolean));
  } else {
    c.industries = [];
  }
  // Optionally map to canonical buckets
  c.industries = c.industries.map(normalizeIndustry);

  // product_keywords -> single comma-separated string, enforce >=5
  if (Array.isArray(c.product_keywords)) c.product_keywords = c.product_keywords.join(", ");
  else if (typeof c.product_keywords !== "string") c.product_keywords = "";
  const kw = c.product_keywords.split(",").map(s => s.trim()).filter(Boolean);
  while (kw.length > 0 && kw.length < 5) kw.push(kw[kw.length - 1] || "keyword");
  c.product_keywords = kw.join(", ");

  // url normalization + domain
  const { canonical_url, normalized_domain } = normalizeUrl(c.canonical_url || c.url);
  c.canonical_url = canonical_url || c.url || "";
  c.url = c.canonical_url;
  c.normalized_domain = c.normalized_domain || normalized_domain || "";

  // id
  const slugName = slug(c.company_name);
  c.id = c.id || `${c.normalized_domain || "na"}__${slugName}`.slice(0, 255);

  // timestamps
  c._ingested_at = c._ingested_at || new Date().toISOString();
  c._updated_at = new Date().toISOString();
  return c;
}

function normalizeIndustry(x) {
  const s = String(x || "").toLowerCase();
  // minimal canonicalization (extend as needed)
  if (/(home ?fragrance|candle|wax)/.test(s)) return "home fragrance";
  if (/(beauty|cosmetic)/.test(s)) return "beauty";
  if (/(food|beverage|grocery)/.test(s)) return "food & beverage";
  if (/(apparel|clothing|fashion)/.test(s)) return "apparel";
  if (/(software|saas|tech|technology)/.test(s)) return "software";
  return s;
}

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    let host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return { canonical_url: url.toString(), normalized_domain: host };
  } catch {
    return { canonical_url: u || "", normalized_domain: "" };
  }
}
function slug(s){ return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }
function uniq(a){ return Array.from(new Set(a)); }

async function safeGeocode(address, apiKey){
  try {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", address);
    url.searchParams.set("key", apiKey);
    const r = await fetch(url.toString(), { method: "GET" });
    const data = await r.json();
    const best = Array.isArray(data?.results) && data.results[0];
    const loc = best?.geometry?.location;
    if (!loc) return null;
    return { lat: Number(loc.lat), lng: Number(loc.lng), formatted_address: best.formatted_address };
  } catch { return null; }
}
