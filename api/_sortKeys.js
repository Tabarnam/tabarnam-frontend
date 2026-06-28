// _sortKeys.js
// Computes the two scalar fields the admin list needs for whole-DB ORDER BY:
//   - qq_score: sum of rating.star1..star6 values, clamped 0–5
//   - issues_count: number of issue tags that would render in the Issues column
//
// IMPORTANT — KEEP IN SYNC WITH:
//   src/pages/company-dashboard/dashboardUtils.js#getContractMissingFields
//
// The displayed issue tags are computed by getContractMissingFields on the
// frontend. For server-side ORDER BY on c.issues_count to rank consistently
// with what the admin sees, this function must produce the same set/count.
// Same cross-boundary copy pattern used for the search-scoring functions in
// admin-companies-v2/index.js. Update both files together when changing the
// issue logic; drift only affects sort tie-ordering (the displayed tags
// always come from the frontend function).

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function toFiniteNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toNonNegativeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.trunc(n));
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Mirror of PARTIAL_PRODUCTS_THRESHOLD / countProductKeywords in
// dashboardUtils.js — "thin products" = a populated-but-sparse product list.
const PARTIAL_PRODUCTS_THRESHOLD = 5;
function countProductKeywords(company) {
  if (!company || typeof company !== "object") return 0;
  const keywords = company.keywords;
  if (Array.isArray(keywords)) {
    return keywords.filter((k) => typeof k === "string" && k.trim()).length;
  }
  const pk = company.product_keywords;
  if (typeof pk === "string" && pk.trim()) {
    return pk.split(",").map((s) => s.trim()).filter(Boolean).length;
  }
  if (Array.isArray(pk)) {
    return pk.filter((k) => typeof k === "string" && k.trim()).length;
  }
  return 0;
}

// Mirror of getComputedReviewCount in dashboardUtils.js. Older records may
// have review_count missing/stale, so we pick the best available signal.
function getComputedReviewCount(company) {
  const canonical = toNonNegativeInt(company?.review_count, 0);
  const publicCount = toNonNegativeInt(company?.public_review_count, 0);
  const privateCount = toNonNegativeInt(company?.private_review_count, 0);
  const publicPrivateTotal = publicCount + privateCount;
  const curatedCount = Array.isArray(company?.curated_reviews) ? company.curated_reviews.length : 0;
  const embeddedReviewsCount = Array.isArray(company?.reviews) ? company.reviews.length : 0;
  const embeddedTotal = curatedCount + embeddedReviewsCount;
  const bestNumericFallback = Math.max(
    0,
    canonical,
    toNonNegativeInt(company?.reviews_count, 0),
    toNonNegativeInt(company?.review_count_approved, 0),
    toNonNegativeInt(company?.editorial_review_count, 0),
    toNonNegativeInt(company?.amazon_review_count, 0),
    toNonNegativeInt(company?.public_review_count, 0),
    toNonNegativeInt(company?.private_review_count, 0),
  );
  return Math.max(0, publicPrivateTotal, bestNumericFallback, embeddedTotal);
}

/**
 * Compute the QQ score (sum of star values) for a company doc. Pure function
 * of the `rating` object. Matches calculateTotalScore in search-companies and
 * qqRating.ts on the frontend.
 */
function computeQqScore(company) {
  const rating = company?.rating;
  if (!rating || typeof rating !== "object") return 0;
  const starKeys = ["star1", "star2", "star3", "star4", "star5", "star6"];
  let total = 0;
  for (const k of starKeys) {
    const v = rating[k];
    const n = typeof v === "object" ? toFiniteNumber(v?.value) : toFiniteNumber(v);
    total += n || 0;
  }
  return clamp(total, 0, 5);
}

/**
 * Compute the issue-tag list for a company doc. Port of
 * dashboardUtils.getContractMissingFields — keep in sync.
 */
function computeIssueTags(company) {
  const raw =
    company?.enrichment_health?.missing_fields
    ?? company?.enrichment_health?.missing
    ?? company?.enrichment_health?.missingFields;

  const list = Array.isArray(raw) ? raw : [];

  const fields = list
    .filter((v) => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);

  // Drop reviews variants when the company actually has review data.
  const hasAnyReviews = getComputedReviewCount(company) > 0;
  if (hasAnyReviews) {
    const reviewFieldSet = new Set(["reviews", "curated_reviews"]);
    for (let i = fields.length - 1; i >= 0; i--) {
      if (reviewFieldSet.has(fields[i])) fields.splice(i, 1);
    }
  }

  // Data-wins-over-flag: drop tagline when populated.
  if (asString(company?.tagline).trim()) {
    for (let i = fields.length - 1; i >= 0; i--) {
      if (fields[i] === "tagline") fields.splice(i, 1);
    }
  }

  // Drop industries when populated.
  const hasIndustries =
    (Array.isArray(company?.industries) && company.industries.some((v) => asString(v).trim())) ||
    (Array.isArray(company?.industry) && company.industry.some((v) => asString(v).trim())) ||
    Boolean(asString(company?.industry).trim());
  if (hasIndustries) {
    for (let i = fields.length - 1; i >= 0; i--) {
      if (fields[i] === "industries" || fields[i] === "industry") fields.splice(i, 1);
    }
  }

  // Drop keywords / product_keywords when populated. Prefer the backend's
  // cached _kwRelevantCount (real keywords after sanitization).
  const kwRelevantCount =
    typeof company?._kwRelevantCount === "number" ? company._kwRelevantCount : null;
  const hasKeywords = kwRelevantCount != null
    ? kwRelevantCount >= 1
    : (
        (Array.isArray(company?.keywords) && company.keywords.some((v) => asString(v).trim())) ||
        (Array.isArray(company?.product_keywords) && company.product_keywords.some((v) => asString(v).trim())) ||
        Boolean(asString(company?.product_keywords).trim()) ||
        Boolean(asString(company?.keywords).trim())
      );
  if (hasKeywords) {
    for (let i = fields.length - 1; i >= 0; i--) {
      if (fields[i] === "keywords" || fields[i] === "product_keywords") fields.splice(i, 1);
    }
  }

  // Drop HQ variants when location data exists.
  if (
    (Array.isArray(company?.headquarters_locations) && company.headquarters_locations.length > 0) ||
    (Array.isArray(company?.headquarters) && company.headquarters.length > 0) ||
    asString(company?.headquarters_location).trim()
  ) {
    for (let i = fields.length - 1; i >= 0; i--) {
      if (fields[i] === "headquarters" || fields[i] === "headquarters_location" || fields[i] === "headquarters_locations") {
        fields.splice(i, 1);
      }
    }
  }

  // Drop manufacturing variants when location data exists.
  if (
    (Array.isArray(company?.manufacturing_locations) && company.manufacturing_locations.length > 0) ||
    (Array.isArray(company?.manufacturing_geocodes) && company.manufacturing_geocodes.length > 0)
  ) {
    for (let i = fields.length - 1; i >= 0; i--) {
      if (fields[i] === "manufacturing" || fields[i] === "manufacturing_locations") fields.splice(i, 1);
    }
  }

  // Drop manufacturing if admin flagged limited / unknown.
  if (company?.limited_manufacturing || company?.unknown_manufacturing) {
    for (let i = fields.length - 1; i >= 0; i--) {
      if (fields[i] === "manufacturing") fields.splice(i, 1);
    }
  }

  // Drop HQ variants if admin flagged unknown_hq.
  const hqVariants = new Set(["headquarters", "headquarters_location", "headquarters_locations"]);
  if (company?.unknown_hq) {
    for (let i = fields.length - 1; i >= 0; i--) {
      if (hqVariants.has(fields[i])) fields.splice(i, 1);
    }
  }

  // Add HQ if missing client-side.
  if (!company?.unknown_hq) {
    const hasHqTag = fields.some((f) => hqVariants.has(f));
    const hasHq =
      (Array.isArray(company?.headquarters_locations) && company.headquarters_locations.length > 0) ||
      (Array.isArray(company?.headquarters) && company.headquarters.length > 0) ||
      Boolean(asString(company?.headquarters_location).trim());
    if (!hasHq && !hasHqTag) {
      fields.push("headquarters");
    }
  }

  // Add manufacturing if missing client-side.
  if (!company?.limited_manufacturing && !company?.unknown_manufacturing) {
    const mfgVariants = new Set(["manufacturing", "manufacturing_locations"]);
    const hasMfgTag = fields.some((f) => mfgVariants.has(f));
    const hasMfg =
      (Array.isArray(company?.manufacturing_locations) && company.manufacturing_locations.length > 0) ||
      (Array.isArray(company?.manufacturing_geocodes) && company.manufacturing_geocodes.length > 0);
    if (!hasMfg && !hasMfgTag) {
      fields.push("manufacturing");
    }
  }

  // Add tagline if missing.
  if (!asString(company?.tagline).trim() && !fields.includes("tagline")) {
    fields.push("tagline");
  }

  // Add industries if missing.
  const hasIndustriesData =
    (Array.isArray(company?.industries) && company.industries.some((v) => asString(v).trim())) ||
    (Array.isArray(company?.industry) && company.industry.some((v) => asString(v).trim())) ||
    Boolean(asString(company?.industry).trim());
  if (!hasIndustriesData && !fields.includes("industries") && !fields.includes("industry")) {
    fields.push("industries");
  }

  // Add keywords / products if missing.
  const kwRelevantCountForCheck =
    typeof company?._kwRelevantCount === "number" ? company._kwRelevantCount : null;
  const hasKeywordsData = kwRelevantCountForCheck != null
    ? kwRelevantCountForCheck >= 1
    : (
        (Array.isArray(company?.keywords) && company.keywords.some((v) => asString(v).trim())) ||
        (Array.isArray(company?.product_keywords) && company.product_keywords.some((v) => asString(v).trim())) ||
        Boolean(asString(company?.product_keywords).trim()) ||
        Boolean(asString(company?.keywords).trim())
      );
  if (!hasKeywordsData && !fields.includes("keywords") && !fields.includes("product_keywords")) {
    fields.push("keywords");
  }

  // Add homepage if missing (unless admin cleared).
  const hasHomepage = Boolean(asString(company?.homepage_image_url).trim());
  const homepageCleared = Boolean(company?.homepage_issue_cleared);
  if (!hasHomepage && !homepageCleared) {
    fields.push("homepage");
  }

  // +products if keywords flagged incomplete and not acknowledged.
  const kwIncomplete =
    asString(company?.keywords_completeness).trim().toLowerCase() === "incomplete";
  const kwAcknowledged = Boolean(company?.keywords_complete_acknowledged);
  if (kwIncomplete && !kwAcknowledged) {
    fields.push("+products");
  }

  // Amazon URL: missing or pending approval, unless flagged no_amazon_store.
  const hasAmazonUrl = Boolean(asString(company?.amazon_url).trim());
  const noAmazonStore = Boolean(company?.no_amazon_store);
  const approvalPending = company?.amazon_url_approved === false;
  if (!noAmazonStore && (!hasAmazonUrl || approvalPending)) {
    fields.push("amazon_url");
  }

  // Thin-products: products present but sparse (< PARTIAL_PRODUCTS_THRESHOLD) →
  // "products_partial". Suppressed once the admin acknowledges via
  // keywords_complete_acknowledged ("Products Complete"). Mirrors the frontend
  // toIssueTags so the stored issues_count matches the Issues column AND powers
  // the DB-wide Incomplete filter (issues_count > 0).
  const productsAlreadyMissing = fields.some(
    (t) => t === "product_keywords" || t === "products" || t === "keywords"
  );
  if (!productsAlreadyMissing && !company?.keywords_complete_acknowledged) {
    const productCount = countProductKeywords(company);
    if (productCount > 0 && productCount < PARTIAL_PRODUCTS_THRESHOLD) {
      fields.push("products_partial");
    }
  }

  // Reviews: filter out if no_reviews; add if zero reviews otherwise.
  const noReviews = Boolean(company?.no_reviews);
  if (noReviews) {
    const reviewFields = new Set(["reviews", "curated_reviews"]);
    return fields.filter((f) => !reviewFields.has(f));
  }
  if (getComputedReviewCount(company) === 0 && !fields.some((f) => f === "reviews" || f === "curated_reviews")) {
    fields.push("reviews");
  }

  return fields;
}

function computeIssuesCount(company) {
  return computeIssueTags(company).length;
}

// Tell company docs apart from control/job docs (resume_*, _import_*,
// refresh_job_*, stallRecord, tripDoc, etc.). We only want sort keys on
// real company rows — applying them to job docs would pollute Cosmos and
// be meaningless (a stall record has no rating, no enrichment_health).
function looksLikeCompanyDoc(doc) {
  if (!doc || typeof doc !== "object") return false;
  // Control/job IDs use known prefixes.
  const id = typeof doc.id === "string" ? doc.id : "";
  if (id.startsWith("_import_") || id.startsWith("refresh_job_") || id.startsWith("resume_")) return false;
  if (typeof doc.type === "string" && doc.type === "import_control") return false;
  // Positive markers: a company doc has company_id and/or normalized_domain.
  const hasCompanyId = typeof doc.company_id === "string" && doc.company_id.trim().length > 0;
  const hasDomain = typeof doc.normalized_domain === "string" && doc.normalized_domain.trim().length > 0;
  return hasCompanyId || hasDomain;
}

/**
 * Apply both sort keys to a company doc in place. Safe to call on non-company
 * docs (job/control docs) — it's a no-op for those. Use at every company
 * persist point so admin sorts stay accurate without a separate backfill run.
 */
function applySortKeys(doc) {
  if (!looksLikeCompanyDoc(doc)) return doc;
  doc.qq_score = computeQqScore(doc);
  doc.issues_count = computeIssuesCount(doc);
  return doc;
}

module.exports = {
  computeQqScore,
  computeIssueTags,
  computeIssuesCount,
  applySortKeys,
  looksLikeCompanyDoc,
};
