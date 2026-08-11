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
