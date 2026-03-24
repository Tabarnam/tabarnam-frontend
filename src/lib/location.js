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

// ---- Country centroids (approximate geographic centers) ----
// Used as geocoding fallback when the Google API is unavailable.
const COUNTRY_CENTROIDS = {
  AF:[33,65],AL:[41,20],DZ:[28,3],AD:[42.5,1.5],AO:[-12.5,18.5],AG:[17.05,-61.8],
  AR:[-34,-64],AM:[40,45],AU:[-25,135],AT:[47.3,13.3],AZ:[40.5,47.5],BS:[24,-76],
  BH:[26,50.5],BD:[24,90],BB:[13.2,-59.5],BY:[53,28],BE:[50.8,4.5],BZ:[17.2,-88.7],
  BJ:[9.5,2.3],BT:[27.5,90.5],BO:[-17,-65],BA:[44,17.8],BW:[-22,24],BR:[-10,-55],
  BN:[4.5,114.7],BG:[43,25],BF:[13,-1.5],BI:[-3.5,30],KH:[13,105],CM:[6,12.5],
  CA:[60,-96],CV:[15,-23.5],CF:[7,21],TD:[15,19],CL:[-30,-71],CN:[35,105],
  CO:[4,-72],KM:[-12.2,44.2],CG:[-1,15.5],CD:[-2.5,23.5],CR:[10,-84],CI:[7.5,-5.5],
  HR:[45.2,15.5],CU:[22,-79.5],CY:[35,33],CZ:[49.8,15.5],DK:[56,10],DJ:[11.5,43],
  DM:[15.4,-61.4],DO:[19,-70.7],EC:[-1.5,-78.5],EG:[27,30],SV:[13.8,-88.9],
  GQ:[2,10],ER:[15,39],EE:[59,26],SZ:[-26.5,31.5],ET:[8,38],FJ:[-18,178],
  FI:[64,26],FR:[46,2],GA:[-1,11.8],GM:[13.5,-16.6],GE:[42,43.5],DE:[51,9],
  GH:[8,-1.2],GR:[39,22],GD:[12.1,-61.7],GT:[15.5,-90.3],GN:[11,-12],GW:[12,-15],
  GY:[5,-59],HT:[19,-72.3],HN:[15,-86.5],HU:[47,20],IS:[65,-18],IN:[22,79],
  ID:[-5,120],IR:[32,53],IQ:[33,44],IE:[53.5,-8],IL:[31.5,34.8],IT:[42.8,12.8],
  JM:[18.1,-77.3],JP:[36,138],JO:[31,36.5],KZ:[48,68],KE:[1,38],KI:[1.5,173],
  KP:[40,127],KR:[37,127.5],KW:[29.5,47.8],KG:[41,75],LA:[18,105],LV:[57,25],
  LB:[33.8,35.8],LS:[-29.5,28.5],LR:[6.5,-9.5],LY:[27,17],LI:[47.2,9.5],
  LT:[56,24],LU:[49.8,6.1],MG:[-20,47],MW:[-13.5,34],MY:[2.5,112.5],MV:[3.2,73],
  ML:[17,-4],MT:[35.9,14.4],MH:[7.1,171.2],MR:[20,-12],MU:[-20.2,57.5],
  MX:[23,-102],FM:[6.9,158.2],MD:[47,29],MC:[43.7,7.4],MN:[46,105],ME:[42.5,19.3],
  MA:[32,-5],MZ:[-18.3,35],MM:[22,96],NA:[-22,17],NR:[-0.5,166.9],NP:[28,84],
  NL:[52.5,5.8],NZ:[-42,174],NI:[13,-85],NE:[16,8],NG:[10,8],MK:[41.5,22],
  NO:[62,10],OM:[21,57],PK:[30,70],PW:[7.5,134.5],PA:[9,-80],PG:[-6,147],
  PY:[-23,-58],PE:[-10,-76],PH:[13,122],PL:[52,20],PT:[39.5,-8],QA:[25.5,51.3],
  RO:[46,25],RU:[60,100],RW:[-2,30],KN:[17.3,-62.7],LC:[13.9,-61],
  VC:[13.3,-61.2],WS:[-13.8,-172],SM:[43.9,12.4],ST:[0.3,6.6],SA:[24,45],
  SN:[14,-14],RS:[44,21],SC:[-4.7,55.5],SL:[8.5,-11.8],SG:[1.4,103.8],
  SK:[48.7,19.7],SI:[46.1,15],SB:[-8,159],SO:[5,46],ZA:[-29,24],SS:[7,30],
  ES:[40,-4],LK:[7.5,80.5],SD:[15,30],SR:[4,-56],SE:[62,15],CH:[47,8.2],
  SY:[35,38],TW:[23.5,121],TJ:[39,71],TZ:[-6,35],TH:[15,100],TL:[-8.8,126],
  TG:[8,1.2],TO:[-21.2,-175.2],TT:[10.5,-61.3],TN:[34,9],TR:[39,35],
  TM:[40,60],UG:[1,32],UA:[49,32],AE:[24,54],GB:[54,-2],US:[39.8,-98.6],
  UY:[-33,-56],UZ:[41,64],VU:[-16,167],VE:[8,-66],VN:[16,108],YE:[15,48],
  ZM:[-15,28],ZW:[-20,30],HK:[22.3,114.2],MO:[22.2,113.5],PS:[31.9,35.2],
  PR:[18.2,-66.5],XK:[42.6,20.9],
};

/**
 * Get approximate centroid coordinates for a country code.
 * Returns { lat, lng } or null if unknown.
 */
export function getCountryCentroid(code) {
  if (!code) return null;
  const c = COUNTRY_CENTROIDS[code.toUpperCase()];
  return c ? { lat: c[0], lng: c[1] } : null;
}

// ---- Aliases for fuzzy country matching ----
const COUNTRY_ALIASES = {
  GB: ['scotland', 'england', 'wales', 'northern ireland', 'great britain', 'britain', 'uk'],
  US: ['america', 'usa', 'united states of america', 'the united states'],
  CN: ['china', 'prc'],
  KR: ['south korea', 'korea'],
  KP: ['north korea'],
  RU: ['russia'],
  TW: ['taiwan'],
  AE: ['uae', 'emirates', 'dubai'],
  CZ: ['czech republic'],
  TR: ['turkey'],
  CI: ['ivory coast'],
  CD: ['drc', 'democratic republic of congo'],
  VN: ['vietnam'],
  IR: ['iran'],
  SY: ['syria'],
  LA: ['laos'],
  BO: ['bolivia'],
  VE: ['venezuela'],
  TZ: ['tanzania'],
  MD: ['moldova'],
  MK: ['macedonia'],
};

/**
 * Resolve free-text country input to { code, name } or null.
 * Case-insensitive. Matches names, codes, and common aliases.
 */
let _resolveCache = null;
export async function resolveCountryText(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;
  const lower = t.toLowerCase();

  const countries = await getCountries();

  // Build lookup cache once
  if (!_resolveCache) {
    _resolveCache = { byCode: new Map(), byName: new Map(), byAlias: new Map() };
    for (const c of countries) {
      _resolveCache.byCode.set(c.code.toLowerCase(), c);
      _resolveCache.byName.set(c.name.toLowerCase(), c);
    }
    for (const [code, aliases] of Object.entries(COUNTRY_ALIASES)) {
      const country = _resolveCache.byCode.get(code.toLowerCase());
      if (country) {
        for (const alias of aliases) _resolveCache.byAlias.set(alias, country);
      }
    }
  }

  // Exact code match (e.g. "CA", "GB")
  const byCode = _resolveCache.byCode.get(lower);
  if (byCode) return byCode;

  // Exact name match (e.g. "canada", "united kingdom")
  const byName = _resolveCache.byName.get(lower);
  if (byName) return byName;

  // Alias match (e.g. "scotland" → GB, "america" → US)
  const byAlias = _resolveCache.byAlias.get(lower);
  if (byAlias) return byAlias;

  // Partial match — input is a substring of a country name (e.g. "switz" → Switzerland)
  for (const c of countries) {
    if (c.name.toLowerCase().includes(lower)) return c;
  }

  // Partial match — country name is a substring of input (e.g. "the canada" → Canada)
  for (const c of countries) {
    if (lower.includes(c.name.toLowerCase())) return c;
  }

  return null;
}

// Back-compat names used by older components
export const loadCountries    = getCountries;
export const loadSubdivisions = getSubdivisions;

export default { getCountries, getSubdivisions, loadCountries, loadSubdivisions, normalizeCountryDisplay, normalizeLocationString, getCountryCentroid, resolveCountryText };
