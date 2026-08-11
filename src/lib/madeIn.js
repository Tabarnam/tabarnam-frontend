// "Made in ___" page data layer. Everything derives client-side from the
// whole-catalog pins index (/api/map-pins) — the search API's mfgCountry
// filter runs over a 500-doc recency pool and CANNOT produce accurate
// per-country counts or complete lists; the pins index can.
import { fetchPinsIndex } from "@/components/results/map/pinsIndexClient";
import { getCountries, normalizeCountryDisplay } from "@/lib/location";

// SEO-friendly slug overrides where the kebab-cased ISO name isn't the term
// people search for. Everything else: kebab-case of the countries.json name.
const SLUG_OVERRIDES = {
  US: "usa",
  GB: "uk",
  KR: "south-korea",
  RU: "russia",
  TW: "taiwan",
  VN: "vietnam",
  CZ: "czech-republic",
};

// H1/display overrides where the formal ISO name reads poorly on a page.
const NAME_OVERRIDES = {
  KR: "South Korea",
  TW: "Taiwan",
  VN: "Vietnam",
  CZ: "Czech Republic",
  RU: "Russia",
};

// Legacy/alias slugs that should still resolve (canonical points elsewhere).
const SLUG_ALIASES = {
  "united-states": "usa",
  "united-states-of-america": "usa",
  "america": "usa",
  "united-kingdom": "uk",
  "great-britain": "uk",
  "korea": "south-korea",
  "czechia": "czech-republic",
};

export function kebab(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function flagEmoji(cc) {
  const code = String(cc || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

let _registryPromise = null;

/**
 * Country registry: Map(slug → {cc, name, displayName, slug}) plus cc→entry.
 * Built from the ISO country list; alias slugs resolve to the same entry.
 */
export function getCountryRegistry() {
  if (_registryPromise) return _registryPromise;
  _registryPromise = getCountries().then((countries) => {
    const bySlug = new Map();
    const byCC = new Map();
    for (const { code, name } of countries || []) {
      const cc = String(code || "").toUpperCase();
      if (!/^[A-Z]{2}$/.test(cc) || !name) continue;
      const slug = SLUG_OVERRIDES[cc] || kebab(name);
      const displayName = NAME_OVERRIDES[cc] || normalizeCountryDisplay(name);
      const entry = { cc, name, displayName, slug };
      bySlug.set(slug, entry);
      byCC.set(cc, entry);
    }
    for (const [alias, primary] of Object.entries(SLUG_ALIASES)) {
      const entry = bySlug.get(primary);
      if (entry && !bySlug.has(alias)) bySlug.set(alias, entry);
    }
    return { bySlug, byCC };
  });
  return _registryPromise;
}

// US states, DC, and inhabited territories. Slug = kebab of the name; these
// are the only subdivisions with published pages today (the resolver also
// emits CA-/AU- codes, which aggregate fine but have no page yet).
export const US_REGIONS = [
  ["US-AL", "Alabama"], ["US-AK", "Alaska"], ["US-AZ", "Arizona"], ["US-AR", "Arkansas"],
  ["US-CA", "California"], ["US-CO", "Colorado"], ["US-CT", "Connecticut"], ["US-DE", "Delaware"],
  ["US-FL", "Florida"], ["US-GA", "Georgia"], ["US-HI", "Hawaii"], ["US-ID", "Idaho"],
  ["US-IL", "Illinois"], ["US-IN", "Indiana"], ["US-IA", "Iowa"], ["US-KS", "Kansas"],
  ["US-KY", "Kentucky"], ["US-LA", "Louisiana"], ["US-ME", "Maine"], ["US-MD", "Maryland"],
  ["US-MA", "Massachusetts"], ["US-MI", "Michigan"], ["US-MN", "Minnesota"], ["US-MS", "Mississippi"],
  ["US-MO", "Missouri"], ["US-MT", "Montana"], ["US-NE", "Nebraska"], ["US-NV", "Nevada"],
  ["US-NH", "New Hampshire"], ["US-NJ", "New Jersey"], ["US-NM", "New Mexico"], ["US-NY", "New York"],
  ["US-NC", "North Carolina"], ["US-ND", "North Dakota"], ["US-OH", "Ohio"], ["US-OK", "Oklahoma"],
  ["US-OR", "Oregon"], ["US-PA", "Pennsylvania"], ["US-RI", "Rhode Island"], ["US-SC", "South Carolina"],
  ["US-SD", "South Dakota"], ["US-TN", "Tennessee"], ["US-TX", "Texas"], ["US-UT", "Utah"],
  ["US-VT", "Vermont"], ["US-VA", "Virginia"], ["US-WA", "Washington"], ["US-WV", "West Virginia"],
  ["US-WI", "Wisconsin"], ["US-WY", "Wyoming"],
  ["US-DC", "District of Columbia"],
  ["US-PR", "Puerto Rico"], ["US-GU", "Guam"], ["US-VI", "U.S. Virgin Islands"],
  ["US-AS", "American Samoa"], ["US-MP", "Northern Mariana Islands"],
];

const REGION_SLUG_OVERRIDES = {
  "US-DC": "washington-dc",
  "US-VI": "us-virgin-islands",
};

/** Region registry for a country: Map(slug → {code, name, slug}) + code→entry. */
export function getRegionRegistry(cc = "US") {
  const bySlug = new Map();
  const byCode = new Map();
  if (cc !== "US") return { bySlug, byCode };
  for (const [code, name] of US_REGIONS) {
    const slug = REGION_SLUG_OVERRIDES[code] || kebab(name);
    const entry = { code, name, slug };
    bySlug.set(slug, entry);
    byCode.set(code, entry);
  }
  return { bySlug, byCode };
}

/**
 * Pure aggregation of a decoded pins Map by manufacturing subdivision, scoped
 * to one country (codes are prefixed, e.g. "US-CA").
 * @returns {{byRegion: Map<code, {companies, hqCount}>, withRegion: number}}
 */
export function aggregateByRegion(pins, cc = "US") {
  const byRegion = new Map();
  const prefix = `${cc}-`;
  const bucket = (code) => {
    let b = byRegion.get(code);
    if (!b) {
      b = { companies: [], hqCount: 0 };
      byRegion.set(code, b);
    }
    return b;
  };
  const values = pins instanceof Map ? pins.values() : [];
  let withRegion = 0;
  for (const entry of values) {
    const regions = (entry.mfgRegions || []).filter((r) => r.startsWith(prefix));
    if (regions.length) withRegion += 1;
    for (const code of regions) bucket(code).companies.push(entry);
    if (entry.hqRegion && entry.hqRegion.startsWith(prefix)) bucket(entry.hqRegion).hqCount += 1;
  }
  for (const b of byRegion.values()) {
    b.companies.sort((a, z) => a.name.localeCompare(z.name));
  }
  return { byRegion, withRegion };
}

/** Fetch the pins index and aggregate by subdivision (cached upstream). */
export async function getMadeInRegionAggregation(cc = "US") {
  return aggregateByRegion(await fetchPinsIndex(), cc);
}

/**
 * Pure aggregation of a decoded pins Map by manufacturing country.
 * @returns {{byCC: Map<cc, {companies: entry[], hqCount: number}>, total: number}}
 */
export function aggregateByCountry(pins) {
  const byCC = new Map();
  const bucket = (cc) => {
    let b = byCC.get(cc);
    if (!b) {
      b = { companies: [], hqCount: 0 };
      byCC.set(cc, b);
    }
    return b;
  };
  const values = pins instanceof Map ? pins.values() : [];
  for (const entry of values) {
    for (const cc of entry.mfgCCs || []) bucket(cc).companies.push(entry);
    if (entry.hqCC) bucket(entry.hqCC).hqCount += 1;
  }
  for (const b of byCC.values()) {
    b.companies.sort((a, z) => a.name.localeCompare(z.name));
  }
  return { byCC, total: pins instanceof Map ? pins.size : 0 };
}

/** Fetch the pins index and aggregate it (cached upstream). */
export async function getMadeInAggregation() {
  return aggregateByCountry(await fetchPinsIndex());
}

/** Click-through target for a company (same rule as the map cards). */
export function companyHref(entry) {
  if (entry.domain) return `/results?domain=${encodeURIComponent(entry.domain)}`;
  return `/results?q=${encodeURIComponent(entry.name)}&expand=${encodeURIComponent(entry.id)}`;
}
