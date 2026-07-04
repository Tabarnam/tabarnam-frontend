/**
 * Shared "contract" enrichment-health computation.
 *
 * `computeContractEnrichmentHealth(company)` normalizes a company doc the way
 * the required-fields contract expects (resolve HQ/MFG locations, clear stale
 * hq/mfg_unknown flags, coalesce keyword shapes, industries fallback) and then
 * runs `computeEnrichmentHealth`. Its `missing_fields` output is the base the
 * admin Issues column and the stored `issues_count` (via _sortKeys) both read.
 *
 * This lived inside api/admin-companies-v2/index.js, but the import/enrichment
 * write path (api/import/resume-worker/handler.js) must compute it the SAME way
 * before persisting issues_count — otherwise the Incomplete badge (stored
 * issues_count) drifts from the live Issues column. Requiring the admin module
 * from the worker is unsafe (it registers an Azure Function via app.http), so
 * the pure logic lives here as the single source of truth.
 */
const { isRealValue, computeEnrichmentHealth } = require("./_requiredFields");

function toFiniteNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isValidLatLngPair(lat, lng) {
  const la = toFiniteNumber(lat);
  const ln = toFiniteNumber(lng);
  if (la == null || ln == null) return false;
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return false;
  if (Math.abs(la) < 1e-6 && Math.abs(ln) < 1e-6) return false;
  return true;
}

function toLocationArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function pickFirstRealHqCandidate(company) {
  const c = company && typeof company === "object" ? company : {};
  const checkDoc = { ...c, hq_unknown: false };

  const candidates = [];

  const primary = Array.isArray(c.headquarters_location) ? c.headquarters_location[0] : c.headquarters_location;
  candidates.push(primary);

  for (const entry of toLocationArray(c.headquarters_locations)) candidates.push(entry);
  for (const entry of toLocationArray(c.headquarters)) candidates.push(entry);

  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (isRealValue("headquarters_location", candidate, checkDoc)) return candidate;
  }

  // Last resort: if we have coordinates, pass them through as a minimal object.
  // (Required-fields contract treats coordinates as present.)
  if (isValidLatLngPair(c.hq_lat, c.hq_lng)) {
    return { lat: toFiniteNumber(c.hq_lat), lng: toFiniteNumber(c.hq_lng) };
  }

  return primary;
}

function resolveContractManufacturingLocations(company) {
  const c = company && typeof company === "object" ? company : {};
  const checkDoc = { ...c, mfg_unknown: false };

  const candidates = [c.manufacturing_locations, c.manufacturing_geocodes];

  for (const candidate of candidates) {
    if (isRealValue("manufacturing_locations", candidate, checkDoc)) return candidate;
  }

  if (Array.isArray(c.manufacturing_geocodes) && c.manufacturing_geocodes.length > 0) return c.manufacturing_geocodes;
  return c.manufacturing_locations;
}

function shouldClearHqUnknown(company) {
  const c = company && typeof company === "object" ? company : {};
  const checkDoc = { ...c, hq_unknown: false };

  const primary = Array.isArray(c.headquarters_location) ? c.headquarters_location[0] : c.headquarters_location;
  if (isRealValue("headquarters_location", primary, checkDoc)) return true;

  for (const entry of toLocationArray(c.headquarters_locations)) {
    if (isRealValue("headquarters_location", entry, checkDoc)) return true;
  }

  for (const entry of toLocationArray(c.headquarters)) {
    if (isRealValue("headquarters_location", entry, checkDoc)) return true;
  }

  return isValidLatLngPair(c.hq_lat, c.hq_lng);
}

function shouldClearMfgUnknown(company) {
  const c = company && typeof company === "object" ? company : {};
  const checkDoc = { ...c, mfg_unknown: false };

  // Check manufacturing_locations first (primary field)
  if (isRealValue("manufacturing_locations", c.manufacturing_locations, checkDoc)) return true;

  // Check manufacturing_geocodes (geocoded results from admin/import)
  if (isRealValue("manufacturing_locations", c.manufacturing_geocodes, checkDoc)) return true;

  // Also check if manufacturing_geocodes is a non-empty array with any entries
  // This ensures we recognize geocoded data even if some entries may have failed geocoding
  if (Array.isArray(c.manufacturing_geocodes) && c.manufacturing_geocodes.length > 0) {
    for (const entry of c.manufacturing_geocodes) {
      if (isRealValue("manufacturing_locations", entry, checkDoc)) return true;
    }
  }

  return false;
}

function normalizeKeywordList(value) {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim()))
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/\s*,\s*/g)
      .map((v) => v.trim())
      .filter(Boolean);
  }

  return [];
}

function getContractKeywordInputs(company) {
  const c = company && typeof company === "object" ? company : {};

  const keywordsDirect = normalizeKeywordList(c.keywords);
  const keywordsLegacy = normalizeKeywordList(c.keyword_list);
  const keywordsFromProductArray = Array.isArray(c.product_keywords) ? normalizeKeywordList(c.product_keywords) : [];

  const keywords = keywordsDirect.length > 0 ? keywordsDirect : keywordsLegacy.length > 0 ? keywordsLegacy : keywordsFromProductArray;

  let product_keywords = "";
  if (typeof c.product_keywords === "string") {
    product_keywords = c.product_keywords;
  } else if (Array.isArray(c.product_keywords)) {
    product_keywords = normalizeKeywordList(c.product_keywords).join(", ");
  } else if (typeof c.product_keywords_text === "string") {
    product_keywords = c.product_keywords_text;
  }

  if (!String(product_keywords || "").trim() && keywords.length > 0) {
    product_keywords = keywords.join(", ");
  }

  return { keywords, product_keywords };
}

function computeContractEnrichmentHealth(company) {
  const c = company && typeof company === "object" ? company : {};

  const { keywords: normalizedKeywords, product_keywords: normalizedProductKeywords } = getContractKeywordInputs(c);

  const industriesFallback =
    Array.isArray(c.industries) && c.industries.length > 0
      ? c.industries
      : Array.isArray(c.industry)
        ? c.industry
        : typeof c.industry === "string" && c.industry.trim()
          ? [c.industry.trim()]
          : [];

  // Some docs still carry stale `hq_unknown` / `mfg_unknown` flags from earlier enrichment passes.
  // The required-fields contract treats these flags as authoritative (missing), so we clear them
  // for contract evaluation when we can prove HQ/MFG exist via other fields.
  const clearHqUnknown = shouldClearHqUnknown(c);
  const clearMfgUnknown = shouldClearMfgUnknown(c);

  const contractInput = {
    ...c,
    ...(clearHqUnknown ? { hq_unknown: false } : {}),
    ...(clearMfgUnknown ? { mfg_unknown: false } : {}),

    headquarters_location: pickFirstRealHqCandidate(c),
    manufacturing_locations: resolveContractManufacturingLocations(c),
    industries: industriesFallback,

    // Ensure keywords are evaluated correctly even when older docs store them as arrays (or in keyword_list).
    keywords: normalizedKeywords,
    product_keywords: normalizedProductKeywords,
  };

  return computeEnrichmentHealth(contractInput);
}

module.exports = {
  toFiniteNumber,
  isValidLatLngPair,
  toLocationArray,
  normalizeKeywordList,
  getContractKeywordInputs,
  pickFirstRealHqCandidate,
  resolveContractManufacturingLocations,
  shouldClearHqUnknown,
  shouldClearMfgUnknown,
  computeContractEnrichmentHealth,
};
