// src/lib/location.js
// Lightweight loader for country/subdivision data with a tiny fallback.
// Keeps BOTH new names (get*) and legacy names (load*).

// ---- Tiny fallback so the UI still works even if JSON is missing ----
const FALLBACK_COUNTRIES = [
  { code: "US", name: "United States" },
  { code: "CA", name: "Canada" },
  { code: "GB", name: "United Kingdom" },
];

const FALLBACK_SUBDIVISIONS = {
  US: [
    { code: "CA", name: "California" },
    { code: "NY", name: "New York" },
    { code: "TX", name: "Texas" },
  ],
  CA: [
    { code: "ON", name: "Ontario" },
    { code: "QC", name: "Québec" },
    { code: "BC", name: "British Columbia" },
  ],
  GB: [
    { code: "ENG", name: "England" },
    { code: "SCT", name: "Scotland" },
    { code: "WLS", name: "Wales" },
  ],
};

// ---- Caches ----
let countriesCache = null;           // [{ code, name }]
let subdivisionsCache = null;        // { [countryCode]: [{code, name}] }
let countriesLoad;                   // inflight promise
let subdivisionsLoad;                // inflight promise

async function fetchJson(url) {
  const r = await fetch(url, { method: "GET", headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

/**
 * Load countries from /geo/countries.json with fallback.
 * Put your full list in:  public/geo/countries.json
 *   Shape: [{ "code": "US", "name": "United States" }, ...]
 */
export async function getCountries() {
  if (countriesCache) return countriesCache;
  if (!countriesLoad) {
    countriesLoad = (async () => {
      try {
        // served from /public in both dev and prod builds
        const data = await fetchJson("/geo/countries.json");
        if (!Array.isArray(data)) throw new Error("countries: not an array");
        countriesCache = data;
      } catch {
        countriesCache = FALLBACK_COUNTRIES;
      }
      return countriesCache;
    })();
  }
  return countriesLoad;
}

/**
 * Load subdivisions from /geo/subdivisions.json with fallback.
 * Put your full map in:  public/geo/subdivisions.json
 *   Shape: { "US":[{"code":"CA","name":"California"},...], "CA":[...], ... }
 *
 * If countryCode is empty/null/undefined, returns the entire subdivisions map.
 */
export async function getSubdivisions(countryCode) {
  const cc = String(countryCode || "").toUpperCase();

  if (!subdivisionsLoad) {
    subdivisionsLoad = (async () => {
      try {
        const data = await fetchJson("/geo/subdivisions.json");
        if (!data || typeof data !== "object") throw new Error("subdivisions: not an object");
        subdivisionsCache = data;
      } catch {
        subdivisionsCache = FALLBACK_SUBDIVISIONS;
      }
      return subdivisionsCache;
    })();
  }

  const m = await subdivisionsLoad;

  // If no country code provided, return the entire map
  if (!cc) return m;

  // Otherwise return subdivisions for the specific country
  return m[cc] || [];
}

// ---- Country display normalization ----
// Maps verbose country names to compact display forms.
const COUNTRY_DISPLAY_MAP = {
  "UNITED STATES": "USA",
  "UNITED STATES OF AMERICA": "USA",
  "UNITED KINGDOM": "UK",
  "UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND": "UK",
  "PEOPLE'S REPUBLIC OF CHINA": "China",
};

/**
 * Normalize verbose country names to compact display forms.
 * "United States" → "USA", "United Kingdom" → "UK", etc.
 */
export function normalizeCountryDisplay(name) {
  if (!name || typeof name !== "string") return name;
  const n = name.trim();
  return COUNTRY_DISPLAY_MAP[n.toUpperCase()] || n;
}

/**
 * Replace trailing country names in free-text location strings.
 * "Stamford, CT, United States" → "Stamford, CT, USA"
 */
export function normalizeLocationString(s) {
  if (!s || typeof s !== "string") return s;
  return s
    .replace(/,\s*United States of America\s*$/i, ", USA")
    .replace(/,\s*United States\s*$/i, ", USA")
    .replace(/,\s*United Kingdom of Great Britain and Northern Ireland\s*$/i, ", UK")
    .replace(/,\s*United Kingdom\s*$/i, ", UK");
}

// Back-compat names used by older components
export const loadCountries    = getCountries;
export const loadSubdivisions = getSubdivisions;

export default { getCountries, getSubdivisions, loadCountries, loadSubdivisions, normalizeCountryDisplay, normalizeLocationString };
