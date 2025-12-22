// src/lib/google.js
// Client helpers for /google/* via API_BASE

import { apiFetch } from "@/lib/api";

const GEO_TTL = 10 * 60 * 1000; // 10m
const GEO_MAX = 200;
const _geoCache = new Map();
const _now = () => Date.now();
const _get = (k) => {
  const v = _geoCache.get(k);
  if (!v) return null;
  if (_now() - v.t > GEO_TTL) { _geoCache.delete(k); return null; }
  return v.d;
};
const _set = (k, d) => {
  if (_geoCache.size >= GEO_MAX) _geoCache.delete(_geoCache.keys().next().value);
  _geoCache.set(k, { t: _now(), d });
};

export async function geocode({ address, lat, lng, ipLookup = true } = {}) {
  const key = JSON.stringify({ address, lat, lng, ipLookup });
  const hit = _get(key);
  if (hit) return hit;

  try {
    const r = await apiFetch("/google/geocode", {
      method: "POST",
      body: { address, lat, lng, ipLookup },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error || r.statusText || "geocode failed");
    _set(key, data);
    return data;
  } catch (e) {
    console.warn("Geocoding failed (using fallback):", e?.message);
    const fallback = {
      best: {
        location: { lat: 34.0983, lng: -117.8076 },
        components: [{ types: ["country"], short_name: "US" }]
      }
    };
    _set(key, fallback);
    return fallback;
  }
}

// Pass-through stub kept for compatibility
export async function translate({ text, target = "en" }) {
  try {
    const r = await apiFetch("/google/translate", {
      method: "POST",
      body: { text, target },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error || r.statusText || "translate failed");
    return data;
  } catch (e) {
    console.warn("Translation failed (returning original text):", e?.message);
    return { text, target, translatedText: text };
  }
}

export async function placesAutocomplete({ input, country = "" } = {}) {
  const query = String(input || "").trim();
  if (!query) return [];

  try {
    const params = new URLSearchParams();
    params.set("input", query);
    if (country) params.set("country", country);

    const r = await apiFetch(`/google/places?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!r.ok) {
      console.warn(`Places autocomplete returned ${r.status}`);
      return [];
    }

    const data = await r.json().catch(() => ({}));
    if (!Array.isArray(data?.predictions)) return [];

    return data.predictions.map((p) => ({
      placeId: p.place_id,
      description: p.description,
      mainText: p.main_text,
      secondaryText: p.secondary_text,
    }));
  } catch (e) {
    console.warn("Places autocomplete failed:", e?.message);
    return [];
  }
}

export async function placeDetails({ placeId } = {}) {
  const id = String(placeId || "").trim();
  if (!id) return null;

  try {
    const params = new URLSearchParams();
    params.set("place_id", id);

    const r = await apiFetch(`/google/places?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!r.ok) {
      console.warn(`Place details returned ${r.status}`);
      return null;
    }

    const data = await r.json().catch(() => ({}));
    if (!data?.components) return null;

    const components = data.components || [];

    // Find country component and extract ISO code (short_name)
    const countryComponent = components.find((c) => Array.isArray(c.types) && c.types.includes("country"));
    const countryCode = countryComponent?.short_name || ""; // ISO country code like "US"
    const countryName = countryComponent?.long_name || "";

    // Find state/province component and extract code (short_name for state codes)
    const stateComponent = components.find((c) => Array.isArray(c.types) && c.types.includes("administrative_area_level_1"));
    const stateCode = stateComponent?.short_name || ""; // State code like "CA"
    const stateName = stateComponent?.long_name || "";

    // Find city/locality
    const cityComponent = components.find((c) => Array.isArray(c.types) && (c.types.includes("locality") || c.types.includes("postal_town")));
    const city = cityComponent?.long_name || "";

    // Find postal code
    const postalComponent = components.find((c) => Array.isArray(c.types) && c.types.includes("postal_code"));
    const postalCode = postalComponent?.short_name || "";

    return {
      geometry: data.geometry,
      country: countryName,
      countryCode: countryCode,
      state: stateName,
      stateCode: stateCode,
      city: city,
      postalCode: postalCode,
      components: components,
    };
  } catch (e) {
    console.warn("Place details failed:", e?.message);
    return null;
  }
}
