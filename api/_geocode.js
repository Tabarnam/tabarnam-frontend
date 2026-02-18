const axios = require("axios");
const { tryGetStateCenterCoords, isStateOnlyLocation } = require("./_stateCenters");

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

// Country center coordinates (embedded for API reliability)
const COUNTRY_CENTERS_DATA = [
  { "code": "US", "name": "United States", "lat": 37.0902, "lng": -95.7129 },
  { "code": "CA", "name": "Canada", "lat": 56.1304, "lng": -106.3468 },
  { "code": "CN", "name": "China", "lat": 35.8617, "lng": 104.1954 },
  { "code": "IN", "name": "India", "lat": 20.5937, "lng": 78.9629 },
  { "code": "GB", "name": "United Kingdom", "lat": 55.3781, "lng": -3.4360 },
  { "code": "DE", "name": "Germany", "lat": 51.1657, "lng": 10.4515 },
  { "code": "FR", "name": "France", "lat": 46.2276, "lng": 2.2137 },
  { "code": "JP", "name": "Japan", "lat": 36.2048, "lng": 138.2529 },
  { "code": "MX", "name": "Mexico", "lat": 23.6345, "lng": -102.5528 },
  { "code": "BR", "name": "Brazil", "lat": -14.2350, "lng": -51.9253 },
  { "code": "IT", "name": "Italy", "lat": 41.8719, "lng": 12.5674 },
  { "code": "AU", "name": "Australia", "lat": -25.2744, "lng": 133.7751 },
  { "code": "KR", "name": "South Korea", "lat": 35.9078, "lng": 127.7669 },
  { "code": "NL", "name": "Netherlands", "lat": 52.1326, "lng": 5.2913 },
  { "code": "ES", "name": "Spain", "lat": 40.4637, "lng": -3.7492 },
  { "code": "SE", "name": "Sweden", "lat": 60.1282, "lng": 18.6435 },
  { "code": "RU", "name": "Russia", "lat": 61.5240, "lng": 105.3188 },
  { "code": "TW", "name": "Taiwan", "lat": 23.6978, "lng": 120.9605 },
  { "code": "SG", "name": "Singapore", "lat": 1.3521, "lng": 103.8198 },
  { "code": "HK", "name": "Hong Kong", "lat": 22.3193, "lng": 114.1694 },
  { "code": "TH", "name": "Thailand", "lat": 15.8700, "lng": 100.9925 },
  { "code": "MY", "name": "Malaysia", "lat": 4.2105, "lng": 101.6964 },
  { "code": "ID", "name": "Indonesia", "lat": -0.7893, "lng": 113.9213 },
  { "code": "PH", "name": "Philippines", "lat": 12.8797, "lng": 121.7740 },
  { "code": "VN", "name": "Vietnam", "lat": 14.0583, "lng": 108.2772 },
  { "code": "PK", "name": "Pakistan", "lat": 30.3753, "lng": 69.3451 },
  { "code": "BD", "name": "Bangladesh", "lat": 23.685, "lng": 90.3563 },
  { "code": "CH", "name": "Switzerland", "lat": 46.8182, "lng": 8.2275 },
  { "code": "BE", "name": "Belgium", "lat": 50.5039, "lng": 4.4699 },
  { "code": "AT", "name": "Austria", "lat": 47.5162, "lng": 14.5501 },
  { "code": "PL", "name": "Poland", "lat": 51.9194, "lng": 19.1451 },
  { "code": "TR", "name": "Turkey", "lat": 38.9637, "lng": 35.2433 },
  { "code": "SA", "name": "Saudi Arabia", "lat": 23.8859, "lng": 45.0792 },
  { "code": "AE", "name": "United Arab Emirates", "lat": 23.4241, "lng": 53.8478 },
  { "code": "IL", "name": "Israel", "lat": 31.0461, "lng": 34.8516 },
  { "code": "ZA", "name": "South Africa", "lat": -30.5595, "lng": 22.9375 },
  { "code": "NG", "name": "Nigeria", "lat": 9.0820, "lng": 8.6753 },
  { "code": "EG", "name": "Egypt", "lat": 26.8206, "lng": 30.8025 },
  { "code": "CO", "name": "Colombia", "lat": 4.5709, "lng": -74.2973 },
  { "code": "AR", "name": "Argentina", "lat": -38.4161, "lng": -63.6167 },
  { "code": "CL", "name": "Chile", "lat": -35.6751, "lng": -71.5430 },
  { "code": "PE", "name": "Peru", "lat": -9.1900, "lng": -75.0152 },
  { "code": "NZ", "name": "New Zealand", "lat": -40.9006, "lng": 174.8860 },
  { "code": "PT", "name": "Portugal", "lat": 39.3999, "lng": -8.2245 },
  { "code": "IE", "name": "Ireland", "lat": 53.1424, "lng": -7.6921 },
  { "code": "DK", "name": "Denmark", "lat": 56.2639, "lng": 9.5018 },
  { "code": "NO", "name": "Norway", "lat": 60.4720, "lng": 8.4689 },
  { "code": "FI", "name": "Finland", "lat": 61.9241, "lng": 25.7482 },
  { "code": "GR", "name": "Greece", "lat": 39.0742, "lng": 21.8243 },
  { "code": "CZ", "name": "Czech Republic", "lat": 49.8175, "lng": 15.4730 },
  { "code": "RO", "name": "Romania", "lat": 45.9432, "lng": 24.9668 },
  { "code": "HU", "name": "Hungary", "lat": 47.1625, "lng": 19.5033 },
  { "code": "UA", "name": "Ukraine", "lat": 48.3794, "lng": 31.1656 },
  { "code": "KE", "name": "Kenya", "lat": -0.0236, "lng": 37.9062 },
  { "code": "MA", "name": "Morocco", "lat": 31.7917, "lng": -7.0926 },
  { "code": "LK", "name": "Sri Lanka", "lat": 7.8731, "lng": 80.7718 },
  { "code": "MM", "name": "Myanmar", "lat": 21.9162, "lng": 95.9560 },
  { "code": "KH", "name": "Cambodia", "lat": 12.5657, "lng": 104.9910 },
  { "code": "NP", "name": "Nepal", "lat": 28.3949, "lng": 84.1240 },
  { "code": "ET", "name": "Ethiopia", "lat": 9.1450, "lng": 40.4897 },
];

// Common country name aliases and abbreviations
const COUNTRY_ALIASES = {
  "USA": "US",
  "UK": "GB",
  "REPUBLIC OF KOREA": "KR",
  "SOUTH KOREA": "KR",
  "KOREA": "KR",
  "COLOMBIA": "CO",
  "CZECHIA": "CZ",
  "CZECH": "CZ",
  "BURMA": "MM",
};

let countryCentersCache = null;
function getCountryCenters() {
  if (countryCentersCache) return countryCentersCache;
  // Create maps for fast lookup by code and name
  const byCode = {};
  const byName = {};
  for (const item of COUNTRY_CENTERS_DATA) {
    byCode[item.code.toUpperCase()] = { lat: item.lat, lng: item.lng };
    byName[item.name.toUpperCase()] = { lat: item.lat, lng: item.lng };
  }

  // Add aliases
  for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) {
    if (byCode[code]) {
      byCode[alias] = byCode[code];
      byName[alias] = byCode[code];
    }
  }

  countryCentersCache = { byCode, byName };
  return countryCentersCache;
}

// Check if a location string appears to be just a country name or code
function isCountryOnlyLocation(address, existingCountry = null) {
  if (!address || typeof address !== "string") return false;
  const normalized = address.trim().toUpperCase();

  // Already have country info, don't treat as country-only
  if (existingCountry) return false;

  // Check if it matches a country code or name
  const centers = getCountryCenters();
  if (centers.byCode[normalized] || centers.byName[normalized]) {
    return true;
  }

  return false;
}

// Try to get country center coordinates if location is country-only
function tryGetCountryCenterCoords(address) {
  if (!address || typeof address !== "string") return null;
  const normalized = address.trim().toUpperCase();
  const centers = getCountryCenters();

  return centers.byCode[normalized] || centers.byName[normalized] || null;
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
  const stateOrRegion = typeof loc.state === "string" ? loc.state.trim()
    : typeof loc.region === "string" ? loc.region.trim()
    : "";
  const candidates = [
    loc.address,
    loc.full_address,
    loc.formatted,
    loc.location,
    loc.city && loc.state && loc.country ? `${loc.city}, ${loc.state}, ${loc.country}` : "",
    loc.city && loc.country ? `${loc.city}, ${loc.country}` : "",
    loc.city || "",
    stateOrRegion && loc.country ? `${stateOrRegion}, ${loc.country}` : "",
    loc.country || "",
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

  // Check if this is a country-only location and use country center if available
  const countryCoords = tryGetCountryCenterCoords(normalized);
  if (countryCoords) {
    const out = {
      ok: true,
      lat: countryCoords.lat,
      lng: countryCoords.lng,
      geocode_status: "ok",
      geocode_source: "country_center",
      geocoded_at: now,
      geocode_confidence: "low",
      geocode_precision: "country",
      geocode_partial_match: false,
      geocode_formatted_address: normalized,
      geocode_result_types: ["country"],
    };
    _geocodeCache.set(cacheKey, out);
    return { ...out };
  }

  // Check if this is a state/province-only location and use state center if available
  const stateCoords = tryGetStateCenterCoords(normalized);
  if (stateCoords) {
    const out = {
      ok: true,
      lat: stateCoords.lat,
      lng: stateCoords.lng,
      geocode_status: "ok",
      geocode_source: stateCoords.geocode_source || "state_center",
      geocoded_at: now,
      geocode_confidence: "low",
      geocode_precision: stateCoords.geocode_precision || "administrative_area_level_1",
      geocode_partial_match: false,
      geocode_formatted_address: stateCoords.name || normalized,
      geocode_result_types: ["administrative_area_level_1"],
    };
    _geocodeCache.set(cacheKey, out);
    return { ...out };
  }

  const key = env("GOOGLE_MAPS_KEY", "") || env("GOOGLE_GEOCODE_KEY", "") || env("GOOGLE_GEOCODING_API_KEY", "") || env("GOOGLE_MAPS_API_KEY", "");
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

  // Check if this is a country-only location (has country field but no city/state)
  const countryOnly = loc.country && !loc.city && !loc.state && !loc.address && !loc.location;
  if (countryOnly) {
    const countryCoords = tryGetCountryCenterCoords(loc.country);
    if (countryCoords) {
      return {
        ...loc,
        lat: countryCoords.lat,
        lng: countryCoords.lng,
        geocode_status: "ok",
        geocode_source: "country_center",
        geocoded_at: now,
        geocode_confidence: "low",
        geocode_precision: "country",
        geocode_formatted_address: loc.country,
        geocode_result_types: ["country"],
      };
    }
  }

  // Check if this is a state/region + country location (no city)
  const stateOrRegion = loc.state || loc.region;
  const stateCountryOnly = stateOrRegion && loc.country && !loc.city && !loc.address && !loc.location;
  if (stateCountryOnly) {
    const stateStr = typeof stateOrRegion === "string" ? stateOrRegion.trim() : "";
    const countryStr = typeof loc.country === "string" ? loc.country.trim() : "";
    if (stateStr && countryStr) {
      const compositeAddress = `${stateStr}, ${countryStr}`;
      const stateCoords = tryGetStateCenterCoords(compositeAddress);
      if (stateCoords) {
        return {
          ...loc,
          lat: stateCoords.lat,
          lng: stateCoords.lng,
          geocode_status: "ok",
          geocode_source: stateCoords.geocode_source || "state_center",
          geocoded_at: now,
          geocode_confidence: "low",
          geocode_precision: stateCoords.geocode_precision || "administrative_area_level_1",
          geocode_formatted_address: stateCoords.name || compositeAddress,
          geocode_result_types: ["administrative_area_level_1"],
        };
      }
    }
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

/**
 * Geocode a plain location string like "Kansas City, MO, United States"
 * Returns { lat, lng } or null if geocoding fails
 */
async function geocodeLocationString(location, { timeoutMs = 5000 } = {}) {
  if (!location || typeof location !== "string") return null;
  const trimmed = location.trim();
  if (!trimmed) return null;

  const result = await geocodeLocationEntry({ city: trimmed }, { timeoutMs });
  if (result?.lat && result?.lng && result?.geocode_status === "ok") {
    return {
      lat: result.lat,
      lng: result.lng,
      geocode_source: result.geocode_source || "google",
      geocode_confidence: result.geocode_confidence || null,
      geocode_precision: result.geocode_precision || null,
    };
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
  geocodeLocationString,
  pickPrimaryLatLng,
};
