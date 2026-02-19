/**
 * _directEnrichment.js
 *
 * Direct HTTP enrichment orchestrator - NO Azure Queue dependency.
 * Uses the unified enrichCompanyFields() orchestrator (single Grok prompt + verification + fallback).
 */

const {
  fetchTagline,
  fetchHeadquartersLocation,
  fetchManufacturingLocations,
  fetchIndustries,
  fetchProductKeywords,
  fetchCuratedReviews,
  enrichCompanyFields,
} = require("./_grokEnrichment");

const { getXAIEndpoint, getXAIKey } = require("./_shared");
const { sanitizeIndustries, sanitizeKeywords, isRealValue } = require("./_requiredFields");
const { geocodeLocationArray, pickPrimaryLatLng } = require("./_geocode");
const { resolveReviewsStarState } = require("./_reviewsStarState");

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
  if (status === "ok" || status === "not_found" || status === "not_disclosed" || status === "empty") {
    return true;
  }
  // "incomplete" means the field has partial data but didn't meet its target
  // (e.g. 2 of 5 reviews found). Treat as NOT complete so resume worker retries.
  if (status === "incomplete") {
    return false;
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
      return Array.isArray(value) && value.length >= 1; // At least 1 verified review
    default:
      return value != null;
  }
}

/**
 * Run direct enrichment for a single company (no queue).
 *
 * Primary path: enrichCompanyFields() (unified Grok prompt + verification + individual fallback).
 * The return shape is kept compatible with the legacy per-field format so callers
 * (import-start/index.js, applyEnrichmentToCompany) work unchanged.
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
  skipDedicatedDeepening = false,
  dedicatedFieldsOnly,            // NEW: when set, Phase 3 only deepens these fields
  onIntermediateSave,             // Optional: fires after Phase 2 with verified fields (survives DrainMode)
  phase3BudgetCapMs,              // Optional: cap Phase 3 budget (e.g. PASS1a uses 90s)
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
    enrichment_method: null,
    last_enrichment_raw_response: null,
    started_at: nowIso(),
    finished_at: null,
  };

  try {
    // ── Primary path: unified enrichCompanyFields() orchestrator ──
    const ecf = await enrichCompanyFields({
      companyName,
      websiteUrl,
      normalizedDomain,
      budgetMs: budgetMs - 5000, // reserve 5s for final bookkeeping
      xaiUrl: resolvedXaiUrl,
      xaiKey: resolvedXaiKey,
      fieldsToEnrich,
      skipDedicatedDeepening,
      dedicatedFieldsOnly,
      onIntermediateSave,
      phase3BudgetCapMs,
    });

    result.enrichment_method = ecf.method || "unified";
    result.last_enrichment_raw_response = ecf.raw_response || null;

    const proposed = ecf.proposed || {};
    const fieldStatuses = ecf.field_statuses || {};

    // All possible enrichment fields
    const ALL_FIELDS = ["tagline", "headquarters_location", "manufacturing_locations", "industries", "product_keywords", "reviews"];

    // Determine which fields we were asked to enrich
    const targetFields = fieldsToEnrich
      ? ALL_FIELDS.filter((f) => fieldsToEnrich.includes(f))
      : ALL_FIELDS;

    // Map unified output back to the legacy per-field enriched shape
    for (const fieldKey of targetFields) {
      const status = fieldStatuses[fieldKey] || "unknown";
      const value = proposed[fieldKey];

      // Build the per-field sub-object that applyEnrichmentToCompany expects
      const fieldResult = {
        [fieldKey]: value,
        [`${fieldKey}_status`]: status,
        searched_at: nowIso(),
      };

      // Attach source URLs for locations if present
      if (fieldKey === "headquarters_location" && proposed.hq_source_urls) {
        fieldResult.location_source_urls = { hq_source_urls: proposed.hq_source_urls };
      }
      if (fieldKey === "manufacturing_locations" && proposed.mfg_source_urls) {
        fieldResult.location_source_urls = { mfg_source_urls: proposed.mfg_source_urls };
      }

      // Attach attempted review URLs so applyEnrichmentToCompany can persist
      // them to review_cursor — prevents resume worker from re-trying dead URLs.
      if (fieldKey === "reviews" && Array.isArray(ecf.reviews_attempted_urls) && ecf.reviews_attempted_urls.length > 0) {
        fieldResult.attempted_urls = ecf.reviews_attempted_urls;
      }

      result.enriched[fieldKey] = fieldResult;
      result.attempts[fieldKey] = (existingAttempts[fieldKey] || 0) + 1;

      if (isFieldComplete(fieldKey, value, status)) {
        result.fields_completed.push(fieldKey);
      } else if (status === "upstream_timeout" || status === "upstream_unreachable") {
        result.errors[fieldKey] = status;
      } else {
        result.fields_failed.push(fieldKey);
      }
    }

    result.ok = ecf.ok !== false && result.fields_failed.length === 0;

  } catch (err) {
    // Catastrophic failure of unified orchestrator - record and mark all fields failed
    const errorMsg = asString(err?.message || err) || "enrichment_orchestrator_failed";
    console.error(`[runDirectEnrichment] enrichCompanyFields threw: ${errorMsg}`);

    const ALL_FIELDS = ["tagline", "headquarters_location", "manufacturing_locations", "industries", "product_keywords", "reviews"];
    const targetFields = fieldsToEnrich
      ? ALL_FIELDS.filter((f) => fieldsToEnrich.includes(f))
      : ALL_FIELDS;

    for (const fieldKey of targetFields) {
      result.errors[fieldKey] = errorMsg;
      result.fields_failed.push(fieldKey);
    }
    result.ok = false;
  }

  result.elapsed_ms = Date.now() - startedAt;
  result.finished_at = nowIso();

  return result;
}

/**
 * Apply enrichment results to a company document
 *
 * @param {Object} company - The company document to update
 * @param {Object} enrichmentResult - Result from runDirectEnrichment()
 * @returns {Object} - Updated company document
 */
async function applyEnrichmentToCompany(company, enrichmentResult) {
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
    // Clear stale _unknown flag — enrichment provided real data
    updated.hq_unknown = false;
    updated.hq_unknown_reason = null;

    // Geocode HQ location for distance calculations
    try {
      const hqString = updated.headquarters_location;
      if (hqString && typeof hqString === "string") {
        const geocoded = await geocodeLocationArray([{ address: hqString }], { timeoutMs: 5000, concurrency: 1 });
        if (geocoded?.[0]?.lat != null && geocoded?.[0]?.lng != null) {
          const geo = geocoded[0];
          updated.hq_lat = geo.lat;
          updated.hq_lng = geo.lng;
          updated.headquarters_locations = [{ address: hqString, ...geo }];
          updated.headquarters = updated.headquarters_locations;
        }
      }
    } catch { /* geocoding failure is non-fatal */ }
  }

  // Apply manufacturing_locations
  if (enriched.manufacturing_locations?.manufacturing_locations) {
    updated.manufacturing_locations = enriched.manufacturing_locations.manufacturing_locations;
    updated.manufacturing_locations_status = enriched.manufacturing_locations.manufacturing_locations_status || "ok";
    updated.manufacturing_locations_searched_at = enriched.manufacturing_locations.searched_at;
    if (enriched.manufacturing_locations.location_source_urls?.mfg_source_urls) {
      updated.mfg_source_urls = enriched.manufacturing_locations.location_source_urls.mfg_source_urls;
    }
    // Clear stale _unknown flag — enrichment provided real data
    updated.mfg_unknown = false;
    updated.mfg_unknown_reason = null;

    // Geocode manufacturing locations for distance calculations
    try {
      const mfgArr = updated.manufacturing_locations;
      if (Array.isArray(mfgArr) && mfgArr.length > 0) {
        const seeds = mfgArr.map((loc) =>
          typeof loc === "string" ? { location: loc, address: loc } : loc
        );
        const geocoded = await geocodeLocationArray(seeds, { timeoutMs: 5000, concurrency: 4 });
        if (geocoded && geocoded.length > 0) {
          updated.manufacturing_geocodes = geocoded;
        }
      }
    } catch { /* geocoding failure is non-fatal */ }
  }

  // Apply product_keywords
  if (enriched.product_keywords?.product_keywords) {
    updated.product_keywords = enriched.product_keywords.product_keywords;
    updated.product_keywords_status = enriched.product_keywords.product_keywords_status || "ok";
    updated.product_keywords_searched_at = enriched.product_keywords.searched_at;
    // Sync to keywords array — admin edit page reads keywords first (via buildCompanyDraft),
    // and an empty [] from seed time is truthy so it never falls through to product_keywords.
    if (Array.isArray(enriched.product_keywords.product_keywords) && enriched.product_keywords.product_keywords.length > 0) {
      updated.keywords = enriched.product_keywords.product_keywords;
    }
  }

  // Apply reviews — write to curated_reviews (the persisted schema field)
  if (enriched.reviews?.reviews || enriched.reviews?.review_candidates) {
    const reviews = enriched.reviews.reviews || enriched.reviews.review_candidates || [];
    updated.curated_reviews = reviews;
    updated.review_count = reviews.length;
    const rawReviewsStatus = enriched.reviews.reviews_status || "ok";
    // Signal "incomplete" when review count is below the quality threshold so the
    // resume-worker re-fetches with the stronger fetchCuratedReviews() prompt.
    // Threshold matches resume-worker success gate (line 2508: curated.length >= 3).
    const REVIEWS_QUALITY_THRESHOLD = 3;
    updated.reviews_stage_status =
      rawReviewsStatus === "ok" && reviews.length > 0 && reviews.length < REVIEWS_QUALITY_THRESHOLD
        ? "incomplete"
        : rawReviewsStatus;
    updated.reviews_searched_at = enriched.reviews.searched_at;
  }

  // Initialize review_cursor with attempted URLs from this enrichment pass.
  // The resume worker reads doc.review_cursor.attempted_urls to exclude
  // previously-tried (and failed) URLs from subsequent XAI calls.  Without
  // this, resume cycle 0 starts with priorAttemptedUrls=0 and wastes a full
  // cycle re-discovering the same dead URLs that PASS1a already tried.
  const attemptedUrls = Array.isArray(enriched.reviews?.attempted_urls)
    ? enriched.reviews.attempted_urls
    : [];
  const reviewStatus = updated.reviews_stage_status || enriched.reviews?.reviews_status;
  if (attemptedUrls.length > 0 || reviewStatus === "empty" || reviewStatus === "incomplete") {
    updated.review_cursor = {
      ...(updated.review_cursor || {}),
      exhausted: false,
      last_error: null,
      reviews_stage_status: reviewStatus || "incomplete",
      incomplete_reason: (updated.review_count || 0) === 0
        ? "no_verified_reviews"
        : "insufficient_verified_reviews",
      attempted_urls: [
        ...new Set([
          ...(Array.isArray(updated.review_cursor?.attempted_urls) ? updated.review_cursor.attempted_urls : []),
          ...attemptedUrls,
        ]),
      ],
    };
  }

  // Track enrichment metadata
  updated.enrichment_completed_at = enrichmentResult.finished_at;
  updated.enrichment_elapsed_ms = enrichmentResult.elapsed_ms;
  updated.enrichment_attempts = enrichmentResult.attempts;

  // Track unified enrichment metadata (from enrichCompanyFields)
  if (enrichmentResult.enrichment_method) {
    updated.enrichment_method = enrichmentResult.enrichment_method;
  }
  if (enrichmentResult.last_enrichment_raw_response) {
    updated.last_enrichment_raw_response = enrichmentResult.last_enrichment_raw_response;
  }
  updated.last_enrichment_at = enrichmentResult.finished_at || new Date().toISOString();

  // ── Recompute import_missing_fields based on actual field values ──
  // This is critical: saveCompaniesToCosmos sets import_missing_fields at seed time
  // (before enrichment runs).  Without this recomputation the import UI keeps showing
  // fields as "missing" even though they were successfully enriched.
  const refreshedMissing = [];
  const refreshedReasons = {};

  if (!updated.tagline && updated.tagline_status !== "not_found" && updated.tagline_status !== "not_disclosed") {
    refreshedMissing.push("tagline");
    refreshedReasons.tagline = updated.tagline_status || "missing";
  }
  // Industries: apply the same quality gate as saveCompaniesToCosmos
  if (Array.isArray(updated.industries) && updated.industries.length > 0) {
    try {
      const sanitized = sanitizeIndustries(updated.industries);
      if (sanitized.length === 0) {
        refreshedMissing.push("industries");
        refreshedReasons.industries = "low_quality";
      }
      // else: industries are valid after quality gate, don't add to missing
    } catch {
      // sanitizeIndustries unavailable — fall back to presence check (already has items)
    }
  } else if (updated.industries_status !== "not_found" && updated.industries_status !== "not_disclosed") {
    refreshedMissing.push("industries");
    refreshedReasons.industries = updated.industries_status || "missing";
  }
  if (
    !updated.headquarters_location &&
    updated.headquarters_location_status !== "not_found" &&
    updated.headquarters_location_status !== "not_disclosed"
  ) {
    refreshedMissing.push("headquarters_location");
    refreshedReasons.headquarters_location = updated.headquarters_location_status || "missing";
  }
  if (
    (!Array.isArray(updated.manufacturing_locations) || updated.manufacturing_locations.length === 0) &&
    updated.manufacturing_locations_status !== "not_found" &&
    updated.manufacturing_locations_status !== "not_disclosed"
  ) {
    refreshedMissing.push("manufacturing_locations");
    refreshedReasons.manufacturing_locations = updated.manufacturing_locations_status || "missing";
  }
  // Keywords: apply the same quality gate as saveCompaniesToCosmos
  {
    const kwArr = Array.isArray(updated.product_keywords)
      ? updated.product_keywords
      : typeof updated.product_keywords === "string" && updated.product_keywords.trim()
        ? updated.product_keywords.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
    const kwString = kwArr.join(", ");

    if (kwArr.length > 0) {
      try {
        const stats = sanitizeKeywords({ product_keywords: kwString, keywords: updated.keywords || [] });
        const meetsQuality = isRealValue("product_keywords", stats.sanitized.join(", "), { ...updated, keywords: stats.sanitized });
        if (!meetsQuality) {
          refreshedMissing.push("product_keywords");
          refreshedReasons.product_keywords = "low_quality";
        }
        // else: keywords are valid after quality gate, don't add to missing
      } catch {
        // quality gate unavailable — fall back to presence check (already has items)
      }
    } else if (updated.product_keywords_status !== "not_found" && updated.product_keywords_status !== "not_disclosed") {
      refreshedMissing.push("product_keywords");
      refreshedReasons.product_keywords = updated.product_keywords_status || "missing";
    }
  }
  if (
    (!Array.isArray(updated.curated_reviews) || updated.curated_reviews.length === 0) &&
    updated.reviews_stage_status !== "not_found" &&
    updated.reviews_stage_status !== "not_disclosed"
  ) {
    refreshedMissing.push("reviews");
    refreshedReasons.reviews = updated.reviews_stage_status || "missing";
  }
  if (!updated.logo_url && updated.logo_status !== "not_found_on_site") {
    refreshedMissing.push("logo");
    refreshedReasons.logo = updated.logo_status || "missing";
  }

  updated.import_missing_fields = refreshedMissing;
  // Replace (not merge) — drop stale reasons for fields that are now populated.
  updated.import_missing_reason = refreshedReasons;
  // Drop stale import_warnings for fields resolved by enrichment.
  if (Array.isArray(updated.import_warnings)) {
    updated.import_warnings = updated.import_warnings.filter(
      (w) => w && typeof w === "object" && refreshedMissing.includes(w.field)
    );
  }
  // Back-compat field used by some tooling / UI.
  updated.missing_fields = refreshedMissing.map((f) => {
    if (f === "headquarters_location") return "hq";
    if (f === "manufacturing_locations") return "mfg";
    return f;
  });

  // ── Auto-populate stars from enriched data ──
  // Star1 (MFG): 1.0 if manufacturing_locations present
  // Star2 (HQ): 1.0 if headquarters_location present
  // Star3 (Reviews): via resolveReviewsStarState (existing pattern)
  const hasManufacturing = Array.isArray(updated.manufacturing_locations) && updated.manufacturing_locations.length > 0;
  const hasHeadquarters = !!(updated.headquarters_location && String(updated.headquarters_location).trim());

  const existingRating = updated.rating && typeof updated.rating === "object" ? updated.rating : {};
  const existingStar1 = existingRating.star1 && typeof existingRating.star1 === "object" ? existingRating.star1 : { value: 0, notes: [] };
  const existingStar2 = existingRating.star2 && typeof existingRating.star2 === "object" ? existingRating.star2 : { value: 0, notes: [] };

  updated.rating = {
    ...existingRating,
    star1: { ...existingStar1, value: hasManufacturing ? 1.0 : existingStar1.value },
    star2: { ...existingStar2, value: hasHeadquarters ? 1.0 : existingStar2.value },
  };

  const reviewsStarState = resolveReviewsStarState(updated);
  updated.reviews_star_value = reviewsStarState.next_value;
  updated.reviews_star_source = reviewsStarState.next_source;
  updated.rating = reviewsStarState.next_rating;

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
