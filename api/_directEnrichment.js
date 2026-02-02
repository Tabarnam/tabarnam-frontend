/**
 * _directEnrichment.js
 *
 * Direct HTTP enrichment orchestrator - NO Azure Queue dependency.
 * Calls enrichment functions directly via HTTP, managing budget and retries.
 */

const {
  fetchTagline,
  fetchHeadquartersLocation,
  fetchManufacturingLocations,
  fetchIndustries,
  fetchProductKeywords,
  fetchCuratedReviews,
} = require("./_grokEnrichment");

const { getXAIEndpoint, getXAIKey } = require("./_shared");

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Enrichment field definitions with fetchers and configuration
 */
// minBudgetMs values MUST match XAI_STAGE_TIMEOUTS_MS.min + 1200ms safety margin
// in _grokEnrichment.js, or fields will be incorrectly deferred.
// See _grokEnrichment.js lines 35-40 for the source of truth.
const ENRICHMENT_FIELDS = [
  {
    key: "tagline",
    fetcher: fetchTagline,
    maxAttempts: 3,
    minBudgetMs: 17000, // light: min 15000 + 1200 + buffer
    priority: 1, // Higher priority = run first
  },
  {
    key: "industries",
    fetcher: fetchIndustries,
    maxAttempts: 3,
    minBudgetMs: 17000, // light: min 15000 + 1200 + buffer
    priority: 2,
  },
  {
    key: "headquarters_location",
    fetcher: fetchHeadquartersLocation,
    maxAttempts: 3,
    minBudgetMs: 22000, // location: min 20000 + 1200 + buffer
    priority: 3,
  },
  {
    key: "manufacturing_locations",
    fetcher: fetchManufacturingLocations,
    maxAttempts: 3,
    minBudgetMs: 22000, // location: min 20000 + 1200 + buffer
    priority: 4,
  },
  {
    key: "product_keywords",
    fetcher: fetchProductKeywords,
    maxAttempts: 3,
    minBudgetMs: 32000, // keywords: min 30000 + 1200 + buffer
    priority: 5,
  },
  {
    key: "reviews",
    fetcher: fetchCuratedReviews,
    maxAttempts: 3,
    minBudgetMs: 62000, // reviews: min 60000 + 1200 + buffer
    priority: 6,
  },
];

/**
 * Check if a field value is considered "complete"
 */
function isFieldComplete(fieldKey, value, status) {
  if (status === "ok" || status === "not_found" || status === "not_disclosed") {
    return true;
  }

  switch (fieldKey) {
    case "tagline":
      return typeof value === "string" && value.trim().length > 0;
    case "industries":
      return Array.isArray(value) && value.length > 0;
    case "headquarters_location":
      return typeof value === "string" && value.trim().length > 0;
    case "manufacturing_locations":
      return Array.isArray(value) && value.length > 0;
    case "product_keywords":
      return Array.isArray(value) && value.length > 0;
    case "reviews":
      return Array.isArray(value) && value.length >= 2; // At least 2 reviews
    default:
      return value != null;
  }
}

/**
 * Run direct enrichment for a single company (no queue)
 *
 * @param {Object} params
 * @param {Object} params.company - Company document with company_name, website_url, normalized_domain
 * @param {string} params.sessionId - Import session ID
 * @param {number} params.budgetMs - Total time budget in milliseconds (default: 5 minutes)
 * @param {string} params.xaiUrl - Optional xAI endpoint URL
 * @param {string} params.xaiKey - Optional xAI API key
 * @param {string[]} params.fieldsToEnrich - Optional list of specific fields to enrich
 * @param {Object} params.existingAttempts - Optional existing attempt counts per field
 *
 * @returns {Object} - { ok, enriched, errors, skipped, elapsed_ms, fields_completed, fields_failed }
 */
async function runDirectEnrichment({
  company,
  sessionId,
  budgetMs = 300000, // 5 minutes default
  xaiUrl,
  xaiKey,
  fieldsToEnrich,
  existingAttempts = {},
} = {}) {
  const startedAt = Date.now();
  const resolvedXaiUrl = asString(xaiUrl).trim() || getXAIEndpoint();
  const resolvedXaiKey = asString(xaiKey).trim() || getXAIKey();

  const companyName = asString(company?.company_name).trim();
  const websiteUrl = asString(company?.website_url).trim();
  const normalizedDomain = asString(company?.normalized_domain).trim();

  if (!companyName) {
    return {
      ok: false,
      error: "missing_company_name",
      enriched: {},
      errors: {},
      skipped: [],
      elapsed_ms: Date.now() - startedAt,
      fields_completed: [],
      fields_failed: [],
    };
  }

  const result = {
    ok: true,
    enriched: {},
    errors: {},
    skipped: [],
    deferred: [],
    attempts: { ...existingAttempts },
    elapsed_ms: 0,
    fields_completed: [],
    fields_failed: [],
    started_at: nowIso(),
    finished_at: null,
  };

  // Filter fields if specific ones requested
  const fieldsToProcess = fieldsToEnrich
    ? ENRICHMENT_FIELDS.filter((f) => fieldsToEnrich.includes(f.key))
    : ENRICHMENT_FIELDS;

  // Sort by priority
  const sortedFields = [...fieldsToProcess].sort((a, b) => a.priority - b.priority);

  for (const field of sortedFields) {
    const elapsed = Date.now() - startedAt;
    const remaining = budgetMs - elapsed;

    // Check if we have enough budget
    if (remaining < field.minBudgetMs) {
      result.deferred.push(field.key);
      continue;
    }

    // Check if max attempts reached
    const currentAttempts = result.attempts[field.key] || 0;
    if (currentAttempts >= field.maxAttempts) {
      result.skipped.push(field.key);
      continue;
    }

    // Increment attempt count
    result.attempts[field.key] = currentAttempts + 1;

    try {
      const fetchResult = await field.fetcher({
        companyName,
        websiteUrl,
        normalizedDomain,
        budgetMs: remaining,
        xaiUrl: resolvedXaiUrl,
        xaiKey: resolvedXaiKey,
      });

      // Store the result
      result.enriched[field.key] = fetchResult;

      // Check if complete
      const status = fetchResult?.[`${field.key}_status`] || fetchResult?.status;
      const value = fetchResult?.[field.key];

      if (isFieldComplete(field.key, value, status)) {
        result.fields_completed.push(field.key);
      } else if (status === "upstream_timeout" || status === "upstream_unreachable") {
        // Retryable error - don't count as failed yet
        result.errors[field.key] = status;
      } else {
        result.fields_failed.push(field.key);
      }
    } catch (err) {
      result.errors[field.key] = asString(err?.message || err) || "unknown_error";
      result.fields_failed.push(field.key);
    }
  }

  result.elapsed_ms = Date.now() - startedAt;
  result.finished_at = nowIso();
  result.ok = result.fields_failed.length === 0;

  return result;
}

/**
 * Apply enrichment results to a company document
 *
 * @param {Object} company - The company document to update
 * @param {Object} enrichmentResult - Result from runDirectEnrichment()
 * @returns {Object} - Updated company document
 */
function applyEnrichmentToCompany(company, enrichmentResult) {
  if (!company || !enrichmentResult?.enriched) return company;

  const updated = { ...company };
  const enriched = enrichmentResult.enriched;

  // Apply tagline
  if (enriched.tagline?.tagline) {
    updated.tagline = enriched.tagline.tagline;
    updated.tagline_status = enriched.tagline.tagline_status || "ok";
    updated.tagline_searched_at = enriched.tagline.searched_at;
  }

  // Apply industries
  if (enriched.industries?.industries) {
    updated.industries = enriched.industries.industries;
    updated.industries_status = enriched.industries.industries_status || "ok";
    updated.industries_searched_at = enriched.industries.searched_at;
  }

  // Apply headquarters_location
  if (enriched.headquarters_location?.headquarters_location) {
    updated.headquarters_location = enriched.headquarters_location.headquarters_location;
    updated.headquarters_location_status = enriched.headquarters_location.headquarters_location_status || "ok";
    updated.headquarters_location_searched_at = enriched.headquarters_location.searched_at;
    if (enriched.headquarters_location.location_source_urls?.hq_source_urls) {
      updated.hq_source_urls = enriched.headquarters_location.location_source_urls.hq_source_urls;
    }
  }

  // Apply manufacturing_locations
  if (enriched.manufacturing_locations?.manufacturing_locations) {
    updated.manufacturing_locations = enriched.manufacturing_locations.manufacturing_locations;
    updated.manufacturing_locations_status = enriched.manufacturing_locations.manufacturing_locations_status || "ok";
    updated.manufacturing_locations_searched_at = enriched.manufacturing_locations.searched_at;
    if (enriched.manufacturing_locations.location_source_urls?.mfg_source_urls) {
      updated.mfg_source_urls = enriched.manufacturing_locations.location_source_urls.mfg_source_urls;
    }
  }

  // Apply product_keywords
  if (enriched.product_keywords?.product_keywords) {
    updated.product_keywords = enriched.product_keywords.product_keywords;
    updated.product_keywords_status = enriched.product_keywords.product_keywords_status || "ok";
    updated.product_keywords_searched_at = enriched.product_keywords.searched_at;
  }

  // Apply reviews
  if (enriched.reviews?.reviews || enriched.reviews?.review_candidates) {
    const reviews = enriched.reviews.reviews || enriched.reviews.review_candidates || [];
    updated.reviews = reviews;
    updated.reviews_status = enriched.reviews.reviews_status || "ok";
    updated.reviews_searched_at = enriched.reviews.searched_at;
  }

  // Track enrichment metadata
  updated.enrichment_completed_at = enrichmentResult.finished_at;
  updated.enrichment_elapsed_ms = enrichmentResult.elapsed_ms;
  updated.enrichment_attempts = enrichmentResult.attempts;

  return updated;
}

/**
 * Get list of fields that still need enrichment
 *
 * @param {Object} company - Company document
 * @returns {string[]} - Array of field keys that need enrichment
 */
function getMissingFields(company) {
  const missing = [];

  if (!company?.tagline && company?.tagline_status !== "not_found" && company?.tagline_status !== "not_disclosed") {
    missing.push("tagline");
  }

  if (
    (!Array.isArray(company?.industries) || company.industries.length === 0) &&
    company?.industries_status !== "not_found" &&
    company?.industries_status !== "not_disclosed"
  ) {
    missing.push("industries");
  }

  if (
    !company?.headquarters_location &&
    company?.headquarters_location_status !== "not_found" &&
    company?.headquarters_location_status !== "not_disclosed" &&
    !company?.hq_unknown
  ) {
    missing.push("headquarters_location");
  }

  if (
    (!Array.isArray(company?.manufacturing_locations) || company.manufacturing_locations.length === 0) &&
    company?.manufacturing_locations_status !== "not_found" &&
    company?.manufacturing_locations_status !== "not_disclosed" &&
    !company?.mfg_unknown
  ) {
    missing.push("manufacturing_locations");
  }

  if (
    (!Array.isArray(company?.product_keywords) || company.product_keywords.length === 0) &&
    company?.product_keywords_status !== "not_found" &&
    company?.product_keywords_status !== "not_disclosed"
  ) {
    missing.push("product_keywords");
  }

  if (
    (!Array.isArray(company?.reviews) || company.reviews.length < 2) &&
    company?.reviews_status !== "not_found" &&
    company?.reviews_status !== "incomplete"
  ) {
    missing.push("reviews");
  }

  return missing;
}

module.exports = {
  ENRICHMENT_FIELDS,
  runDirectEnrichment,
  applyEnrichmentToCompany,
  getMissingFields,
  isFieldComplete,
};
