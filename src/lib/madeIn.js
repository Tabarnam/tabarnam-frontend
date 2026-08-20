// "Made in ___" page data layer. Everything derives client-side from the
// whole-catalog pins index (/api/map-pins) — the search API's mfgCountry
// filter runs over a 500-doc recency pool and CANNOT produce accurate
// per-country counts or complete lists; the pins index can.
import { fetchPinsIndex } from "@/components/results/map/pinsIndexClient";
import { getCountries, normalizeCountryDisplay } from "@/lib/location";
// Slug vocabulary lives in a dependency-free module so scripts/generate-sitemap.mjs
// can import the SAME rules under Node — the sitemap must advertise exactly the
// URLs this app links to.
import {
  countrySlug,
  kebab,
  NAME_OVERRIDES,
  regionSlug,
  SLUG_ALIASES,
  US_REGIONS,
} from "@/lib/madeInSlugs";

export { kebab, US_REGIONS };

// How many companies a /made-in page names as visible text (the rest stay on
// the map). Keep in sync with LIST_LIMIT in api/_madeInRender.js, which
// renders the same slice server-side — the same cross-runtime constant pairing
// as PINS_PAYLOAD_VERSION in pinsIndexClient.js.
export const MADE_IN_LIST_LIMIT = 250;

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
      const slug = countrySlug(cc, name);
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

/** Region registry for a country: Map(slug → {code, name, slug}) + code→entry. */
export function getRegionRegistry(cc = "US") {
  const bySlug = new Map();
  const byCode = new Map();
  if (cc !== "US") return { bySlug, byCode };
  for (const [code, name] of US_REGIONS) {
    const slug = regionSlug(code, name);
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
      b = { companies: [], hqCompanies: [], hqCount: 0 };
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
    if (entry.hqRegion && entry.hqRegion.startsWith(prefix)) {
      const b = bucket(entry.hqRegion);
      b.hqCompanies.push(entry);
      b.hqCount += 1;
    }
  }
  for (const b of byRegion.values()) {
    b.companies.sort(byName);
    b.hqCompanies.sort(byName);
  }
  return { byRegion, withRegion };
}

const byName = (a, z) => a.name.localeCompare(z.name);

/**
 * Company list for a bucket under the selected view.
 * "mfg" (default) = manufactures here; "hq" = headquartered here;
 * "both" = the union, deduped by id.
 */
export function companiesForMode(bucket, mode = "mfg") {
  if (!bucket) return [];
  if (mode === "hq") return bucket.hqCompanies || [];
  if (mode !== "both") return bucket.companies || [];
  const byId = new Map();
  for (const c of bucket.companies || []) byId.set(c.id, c);
  for (const c of bucket.hqCompanies || []) byId.set(c.id, c);
  return [...byId.values()].sort(byName);
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
      b = { companies: [], hqCompanies: [], hqCount: 0 };
      byCC.set(cc, b);
    }
    return b;
  };
  const values = pins instanceof Map ? pins.values() : [];
  for (const entry of values) {
    for (const cc of entry.mfgCCs || []) bucket(cc).companies.push(entry);
    if (entry.hqCC) {
      const b = bucket(entry.hqCC);
      b.hqCompanies.push(entry);
      b.hqCount += 1;
    }
  }
  for (const b of byCC.values()) {
    b.companies.sort(byName);
    b.hqCompanies.sort(byName);
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
