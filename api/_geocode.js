const axios = require("axios");

function toFiniteNumber(v) {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

function extractLatLng(obj) {
  if (!obj || typeof obj !== "object") return null;
  const lat = toFiniteNumber(obj.lat ?? obj.latitude ?? obj?.location?.lat ?? obj?.location?.latitude);
  const lng = toFiniteNumber(
    obj.lng ?? obj.lon ?? obj.longitude ?? obj?.location?.lng ?? obj?.location?.lon ?? obj?.location?.longitude
  );
  if (lat == null || lng == null) return null;
  return { lat, lng };
}

function normalizeLocationInput(loc) {
  if (typeof loc === "string") {
    const address = loc.trim();
    return address ? { address } : null;
  }
  if (loc && typeof loc === "object") return loc;
  return null;
}

function getLocationAddress(loc) {
  if (!loc || typeof loc !== "object") return "";
  const candidates = [
    loc.address,
    loc.full_address,
    loc.formatted,
    loc.location,
    loc.city && loc.state && loc.country ? `${loc.city}, ${loc.state}, ${loc.country}` : "",
    loc.city && loc.country ? `${loc.city}, ${loc.country}` : "",
  ];
  for (const c of candidates) {
    const s = typeof c === "string" ? c.trim() : "";
    if (s) return s;
  }
  return "";
}

function getInternalApiBase() {
  const proxyBase = (process.env.XAI_EXTERNAL_BASE || process.env.XAI_PROXY_BASE || "").trim();
  return proxyBase ? `${proxyBase.replace(/\/api$/, "")}/api` : "/api";
}

function confidenceFromSource(source) {
  const s = String(source || "").toLowerCase();
  if (s === "google") return "high";
  if (s === "ipapi") return "medium";
  if (s === "fallback") return "low";
  return "medium";
}

const _geocodeCache = new Map();

async function geocodeAddress(address, { timeoutMs = 5000, strict = true } = {}) {
  const normalized = String(address || "").trim();
  if (!normalized) {
    return { ok: false, geocode_status: "failed", geocoded_at: new Date().toISOString() };
  }

  const cacheKey = normalized.toLowerCase();
  const hit = _geocodeCache.get(cacheKey);
  if (hit) return { ...hit };

  const baseUrl = getInternalApiBase();
  const geocodeUrl = `${baseUrl}/google/geocode`;

  try {
    const response = await axios.post(
      geocodeUrl,
      { address: normalized, ipLookup: false, strict: !!strict },
      {
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const bestLoc = response?.data?.best?.location;
    const lat = toFiniteNumber(bestLoc?.lat);
    const lng = toFiniteNumber(bestLoc?.lng);
    if (lat == null || lng == null) {
      const out = {
        ok: false,
        geocode_status: "failed",
        geocode_source: response?.data?.source || "unknown",
        geocoded_at: new Date().toISOString(),
        geocode_confidence: confidenceFromSource(response?.data?.source),
      };
      _geocodeCache.set(cacheKey, out);
      return { ...out };
    }

    const out = {
      ok: true,
      lat,
      lng,
      geocode_status: "ok",
      geocode_source: response?.data?.source || "google",
      geocoded_at: new Date().toISOString(),
      geocode_confidence: confidenceFromSource(response?.data?.source),
    };
    _geocodeCache.set(cacheKey, out);
    return { ...out };
  } catch (e) {
    const out = {
      ok: false,
      geocode_status: "failed",
      geocode_source: "error",
      geocoded_at: new Date().toISOString(),
      geocode_confidence: "low",
      error: e?.message || String(e),
    };
    _geocodeCache.set(cacheKey, out);
    return { ...out };
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const limit = Math.max(1, Number(concurrency) || 1);
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const current = idx;
      idx += 1;
      results[current] = await mapper(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function geocodeLocationEntry(locRaw, { timeoutMs = 5000 } = {}) {
  const loc = normalizeLocationInput(locRaw);
  const now = new Date().toISOString();

  if (!loc) {
    return { geocode_status: "failed", geocoded_at: now };
  }

  const existingCoords = extractLatLng(loc);
  if (existingCoords) {
    return {
      ...loc,
      lat: existingCoords.lat,
      lng: existingCoords.lng,
      geocode_status: loc.geocode_status || "ok",
      geocode_source: loc.geocode_source || "stored",
      geocoded_at: loc.geocoded_at || now,
      geocode_confidence: loc.geocode_confidence || "high",
    };
  }

  const address = getLocationAddress(loc);
  if (!address) {
    return {
      ...loc,
      geocode_status: "failed",
      geocoded_at: now,
    };
  }

  const res = await geocodeAddress(address, { timeoutMs, strict: true });
  if (res.ok) {
    return {
      ...loc,
      address: loc.address || address,
      lat: res.lat,
      lng: res.lng,
      geocode_status: "ok",
      geocode_source: res.geocode_source,
      geocoded_at: res.geocoded_at,
      geocode_confidence: res.geocode_confidence,
    };
  }

  return {
    ...loc,
    address: loc.address || address,
    geocode_status: "failed",
    geocode_source: res.geocode_source,
    geocoded_at: res.geocoded_at,
    geocode_confidence: res.geocode_confidence,
  };
}

async function geocodeLocationArray(locations, { timeoutMs = 5000, concurrency = 4 } = {}) {
  const list = Array.isArray(locations) ? locations : [];
  const normalized = list.map(normalizeLocationInput).filter(Boolean);
  const geocoded = await mapWithConcurrency(normalized, concurrency, (loc) =>
    geocodeLocationEntry(loc, { timeoutMs })
  );
  return geocoded;
}

function pickPrimaryLatLng(locations) {
  if (!Array.isArray(locations)) return null;
  for (const loc of locations) {
    if (loc && typeof loc === "object" && loc.geocode_status === "ok") {
      const coords = extractLatLng(loc);
      if (coords) return coords;
    }
  }
  for (const loc of locations) {
    const coords = extractLatLng(loc);
    if (coords) return coords;
  }
  return null;
}

module.exports = {
  extractLatLng,
  normalizeLocationInput,
  getLocationAddress,
  geocodeAddress,
  geocodeLocationEntry,
  geocodeLocationArray,
  pickPrimaryLatLng,
};
