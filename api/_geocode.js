const axios = require("axios");

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

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

function inferPrecisionFromGoogleResult(result) {
  const types = Array.isArray(result?.types) ? result.types : [];
  const comps = Array.isArray(result?.address_components) ? result.address_components : [];
  const hasType = (t) => types.includes(t) || comps.some((c) => Array.isArray(c?.types) && c.types.includes(t));

  if (hasType("street_address") || hasType("premise") || hasType("subpremise") || hasType("route")) {
    return "address";
  }
  if (hasType("postal_code")) return "postal_code";
  if (hasType("locality") || hasType("postal_town")) return "locality";
  if (hasType("administrative_area_level_1")) return "administrative_area";
  if (hasType("country")) return "country";
  return "unknown";
}

function confidenceFromPrecision(precision, { partialMatch } = {}) {
  const p = String(precision || "").toLowerCase();
  let base = "medium";
  if (p === "address" || p === "postal_code" || p === "locality") base = "high";
  else if (p === "administrative_area") base = "medium";
  else if (p === "country") base = "low";

  if (partialMatch && base === "high") return "medium";
  if (partialMatch && base === "medium") return "low";
  return base;
}

const _geocodeCache = new Map();

async function geocodeAddress(address, { timeoutMs = 5000, strict = true } = {}) {
  const normalized = String(address || "").trim();
  const now = new Date().toISOString();

  if (!normalized) {
    return { ok: false, geocode_status: "failed", geocoded_at: now, geocode_source: "empty" };
  }

  const cacheKey = normalized.toLowerCase();
  const hit = _geocodeCache.get(cacheKey);
  if (hit) return { ...hit };

  const key = env("GOOGLE_MAPS_KEY", "") || env("GOOGLE_GEOCODE_KEY", "");
  if (!key) {
    const out = {
      ok: false,
      geocode_status: "failed",
      geocode_source: "missing_key",
      geocoded_at: now,
      geocode_confidence: "low",
    };
    _geocodeCache.set(cacheKey, out);
    return { ...out };
  }

  try {
    const res = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: {
        address: normalized,
        key,
      },
      timeout: timeoutMs,
      validateStatus: () => true,
    });

    const status = String(res?.data?.status || "").toUpperCase();
    const results = Array.isArray(res?.data?.results) ? res.data.results : [];

    if (status !== "OK" || results.length === 0) {
      const out = {
        ok: false,
        geocode_status: "failed",
        geocode_source: "google",
        geocoded_at: now,
        geocode_confidence: "low",
        geocode_error: strict ? "geocode_failed" : "geocode_failed_non_strict",
        geocode_google_status: status || "UNKNOWN",
      };
      _geocodeCache.set(cacheKey, out);
      return { ...out };
    }

    const first = results[0];
    const loc = first?.geometry?.location;
    const lat = toFiniteNumber(loc?.lat);
    const lng = toFiniteNumber(loc?.lng);

    if (lat == null || lng == null) {
      const out = {
        ok: false,
        geocode_status: "failed",
        geocode_source: "google",
        geocoded_at: now,
        geocode_confidence: "low",
        geocode_error: "missing_lat_lng",
        geocode_google_status: status || "UNKNOWN",
      };
      _geocodeCache.set(cacheKey, out);
      return { ...out };
    }

    const precision = inferPrecisionFromGoogleResult(first);
    const partialMatch = Boolean(first?.partial_match);

    const out = {
      ok: true,
      lat,
      lng,
      geocode_status: "ok",
      geocode_source: "google",
      geocoded_at: now,
      geocode_confidence: confidenceFromPrecision(precision, { partialMatch }),
      geocode_precision: precision,
      geocode_partial_match: partialMatch,
      geocode_formatted_address: typeof first?.formatted_address === "string" ? first.formatted_address : undefined,
      geocode_result_types: Array.isArray(first?.types) ? first.types : undefined,
    };

    _geocodeCache.set(cacheKey, out);
    return { ...out };
  } catch (e) {
    const out = {
      ok: false,
      geocode_status: "failed",
      geocode_source: "error",
      geocoded_at: now,
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
      geocode_precision: res.geocode_precision,
      geocode_partial_match: res.geocode_partial_match,
      geocode_formatted_address: res.geocode_formatted_address,
      geocode_result_types: res.geocode_result_types,
      geocode_google_status: res.geocode_google_status,
      geocode_error: res.geocode_error,
    };
  }

  return {
    ...loc,
    address: loc.address || address,
    geocode_status: "failed",
    geocode_source: res.geocode_source,
    geocoded_at: res.geocoded_at,
    geocode_confidence: res.geocode_confidence,
    geocode_precision: res.geocode_precision,
    geocode_partial_match: res.geocode_partial_match,
    geocode_formatted_address: res.geocode_formatted_address,
    geocode_result_types: res.geocode_result_types,
    geocode_google_status: res.geocode_google_status,
    geocode_error: res.geocode_error,
    error: res.error,
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
