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

    // Some deployments don't ship the optional google helpers. In dev, we provide
    // a Vite-only server middleware fallback at /__dev/google/*.
    if (r.status === 404) {
      // 1) Local dev helper (Vite middleware)
      const devRes = await fetch("/__dev/google/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, lat, lng, ipLookup }),
      }).catch(() => null);

      if (devRes && devRes.ok) {
        const devData = await devRes.json().catch(() => null);
        if (devData) {
          _set(key, devData);
          return devData;
        }
      }

      // 2) Production SWA endpoint fallback (works cross-origin; the function sets CORS)
      const prodRes = await fetch("https://tabarnam.com/api/google/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, lat, lng, ipLookup }),
      }).catch(() => null);

      if (prodRes && prodRes.ok) {
        const prodData = await prodRes.json().catch(() => null);
        if (prodData) {
          _set(key, prodData);
          return prodData;
        }
      }
    }

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

    if (r.status === 404) {
      const tryMap = async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!Array.isArray(data?.predictions)) return [];
        return data.predictions.map((p) => ({
          placeId: p.place_id,
          description: p.description,
          mainText: p.main_text,
          secondaryText: p.secondary_text,
        }));
      };

      // 1) Local dev helper (Vite middleware)
      const devRes = await fetch(`/__dev/google/places?${params.toString()}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      }).catch(() => null);

      if (devRes && devRes.ok) return await tryMap(devRes);

      // 2) Production SWA endpoint fallback
      const prodRes = await fetch(`https://tabarnam.com/api/google/places?${params.toString()}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      }).catch(() => null);

      if (prodRes && prodRes.ok) return await tryMap(prodRes);

      return [];
    }

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

    if (r.status === 404) {
      const mapDetails = (data) => {
        if (!data?.components) return null;
        const components = data.components || [];

        const countryComponent = components.find((c) => Array.isArray(c.types) && c.types.includes("country"));
        const countryCode = countryComponent?.short_name || "";
        const countryName = countryComponent?.long_name || "";

        const stateComponent = components.find((c) => Array.isArray(c.types) && c.types.includes("administrative_area_level_1"));
        const stateCode = stateComponent?.short_name || "";
        const stateName = stateComponent?.long_name || "";

        const cityComponent = components.find(
          (c) => Array.isArray(c.types) && (c.types.includes("locality") || c.types.includes("postal_town"))
        );
        const city = cityComponent?.long_name || "";

        const postalComponent = components.find((c) => Array.isArray(c.types) && c.types.includes("postal_code"));
        const postalCode = postalComponent?.short_name || "";

        return {
          geometry: data.geometry,
          country: countryName,
          countryCode,
          state: stateName,
          stateCode,
          city,
          postalCode,
          components,
        };
      };

      const tryFetch = async (url) => {
        const rr = await fetch(url, { method: "GET", headers: { Accept: "application/json" } }).catch(() => null);
        if (!rr || !rr.ok) return null;
        const d = await rr.json().catch(() => ({}));
        return mapDetails(d);
      };

      const dev = await tryFetch(`/__dev/google/places?${params.toString()}`);
      if (dev) return dev;

      const prod = await tryFetch(`https://tabarnam.com/api/google/places?${params.toString()}`);
      if (prod) return prod;

      return null;
    }

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
