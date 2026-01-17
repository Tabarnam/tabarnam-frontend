function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeKey(value) {
  return asString(value).trim().toLowerCase().replace(/\s+/g, " ");
}

const PLACEHOLDER_STRINGS = new Set([
  "unknown",
  "n/a",
  "na",
  "none",
  "not found",
  "not_found",
  "notfound",
  "n\\a",
]);

const SENTINEL_STRINGS = new Set([
  "not disclosed",
  "not_disclosed",
]);

function asMeaningfulString(value) {
  const s = asString(value).trim();
  if (!s) return "";

  const key = normalizeKey(s);
  if (PLACEHOLDER_STRINGS.has(key)) return "";
  return s;
}

function isMeaningfulString(value) {
  return Boolean(asMeaningfulString(value));
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => asString(v).trim()).filter(Boolean);
}

function looksLikeHqLocationString(value) {
  const s = asMeaningfulString(value);
  if (!s) return false;

  // Basic minimum: looks like "City, State/Country".
  // (We intentionally keep this simple + deterministic.)
  const parts = s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    const city = parts[0];
    const region = parts[1];
    if (city.length >= 2 && region.length >= 2) return true;
  }

  // Also accept structured-ish strings like "City State" when there are at least 2 words.
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && s.length <= 80) return true;

  return false;
}

function hasMeaningfulLocationEntry(list) {
  const arr = Array.isArray(list) ? list : [];
  for (const loc of arr) {
    if (typeof loc === "string") {
      if (asMeaningfulString(loc)) return true;
      continue;
    }

    if (loc && typeof loc === "object") {
      const candidate =
        asMeaningfulString(loc.formatted) ||
        asMeaningfulString(loc.full_address) ||
        asMeaningfulString(loc.address) ||
        asMeaningfulString(loc.location);

      if (candidate) return true;
    }
  }
  return false;
}

function isAcceptableSentinel(field, value, doc) {
  const f = normalizeKey(field);

  if (f === "manufacturing_locations" || f === "mfg") {
    const values = Array.isArray(value) ? value : [value];
    const hasSentinel = values.some((v) => SENTINEL_STRINGS.has(normalizeKey(v)));
    if (!hasSentinel) return false;

    const reason =
      normalizeKey(doc?.manufacturing_locations_reason) ||
      normalizeKey(doc?.mfg_unknown_reason) ||
      normalizeKey(doc?.import_missing_reason?.manufacturing_locations) ||
      normalizeKey(doc?.import_missing_reason?.mfg);

    // Require an explicit typed reason so "Not disclosed" is never a silent placeholder.
    return reason === "not_disclosed";
  }

  return false;
}

/**
 * Required-fields contract check.
 *
 * Returns true iff the field is either:
 * - a real meaningful value OR
 * - an explicit, typed sentinel that is acceptable for terminal completion.
 */
function isRealValue(field, value, doc) {
  const f = normalizeKey(field);

  if (f === "industries") {
    const list = normalizeStringArray(value).map(asMeaningfulString).filter(Boolean);
    return list.length >= 1;
  }

  if (f === "product_keywords") {
    const pk = asMeaningfulString(
      typeof value === "string"
        ? value
        : Array.isArray(value)
          ? value.join(", ")
          : ""
    );
    const keywords = normalizeStringArray(doc?.keywords).map(asMeaningfulString).filter(Boolean);
    return Boolean(pk) || keywords.length > 0;
  }

  if (f === "tagline") {
    return Boolean(asMeaningfulString(value));
  }

  if (f === "headquarters_location" || f === "hq") {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const formatted = asMeaningfulString(value.formatted || value.full_address || value.address || value.location);
      if (formatted && looksLikeHqLocationString(formatted)) return true;

      const city = asMeaningfulString(value.city || value.locality);
      const region = asMeaningfulString(value.state || value.region || value.province);
      const country = asMeaningfulString(value.country);
      return Boolean(city && (region || country));
    }

    return looksLikeHqLocationString(value);
  }

  if (f === "manufacturing_locations" || f === "mfg") {
    if (isAcceptableSentinel(f, value, doc)) return true;
    return hasMeaningfulLocationEntry(value);
  }

  if (f === "logo") {
    const logoUrl = asMeaningfulString(doc?.logo_url);
    if (logoUrl) return true;

    const stage = normalizeKey(doc?.logo_stage_status);
    const status = normalizeKey(doc?.logo_status);

    // Contract: explicitly recording "not found" is a valid terminal state.
    if (stage === "not_found_on_site" || stage === "not_found" || stage === "missing") return true;
    if (status === "not_found_on_site" || status === "not_found" || status === "missing") return true;

    return false;
  }

  if (f === "reviews" || f === "curated_reviews") {
    const curated = Array.isArray(doc?.curated_reviews)
      ? doc.curated_reviews.filter((r) => r && typeof r === "object")
      : [];
    if (curated.length > 0) return true;

    const reviewCount = Number.isFinite(Number(doc?.review_count)) ? Number(doc.review_count) : 0;
    const status = normalizeKey(doc?.reviews_stage_status || doc?.review_cursor?.reviews_stage_status);

    // Count-only is only acceptable once the stage is actually complete.
    if (reviewCount > 0 && status === "ok") return true;

    // Explicit terminal states: no reviews exist / exhausted.
    // These clear missing_fields while still allowing has_reviews=false.
    const exhausted = Boolean(doc?.review_cursor?.exhausted);
    if (status === "no_valid_reviews_found" || status === "exhausted" || status === "no_reviews_found") {
      return exhausted || status !== "no_reviews_found";
    }

    return false;
  }

  // default scalar/string check
  if (Array.isArray(value)) {
    return value.map(asMeaningfulString).filter(Boolean).length > 0;
  }
  return Boolean(asMeaningfulString(value));
}

function computeMissingFields(company, { includeReviews = true } = {}) {
  const c = company && typeof company === "object" ? company : {};
  const missing = [];

  if (!isRealValue("industries", c.industries, c)) missing.push("industries");
  if (!isRealValue("product_keywords", c.product_keywords, c)) missing.push("product_keywords");
  if (!isRealValue("headquarters_location", c.headquarters_location, c)) missing.push("headquarters_location");
  if (!isRealValue("manufacturing_locations", c.manufacturing_locations, c)) missing.push("manufacturing_locations");
  if (!isRealValue("logo", c.logo_url, c)) missing.push("logo");

  if (includeReviews && !isRealValue("reviews", c.curated_reviews, c)) missing.push("reviews");

  return missing;
}

function computeEnrichmentHealth(company) {
  const c = company && typeof company === "object" ? company : {};

  const missing_fields = computeMissingFields(c);

  const hasReviewCount = typeof c.review_count === "number" && Number.isFinite(c.review_count);
  const hasReviewCursorField = Boolean(c.review_cursor && typeof c.review_cursor === "object");
  const hasCuratedReviewsField = Array.isArray(c.curated_reviews);
  const hasReviewsField = hasReviewCount && hasCuratedReviewsField && hasReviewCursorField;

  const reviewsStageRaw = asString(
    c.reviews_stage_status || (c.review_cursor && typeof c.review_cursor === "object" ? c.review_cursor.reviews_stage_status : "") || ""
  ).trim();

  const curated = Array.isArray(c.curated_reviews) ? c.curated_reviews.filter((r) => r && typeof r === "object") : [];
  const reviewCount = Number.isFinite(Number(c.review_count)) ? Number(c.review_count) : curated.length;
  const reviewsStageNormalized = normalizeKey(reviewsStageRaw);

  const hasReviewsActual = curated.length > 0 || (reviewCount > 0 && reviewsStageNormalized === "ok");
  const reviewsSatisfied = isRealValue("reviews", c.curated_reviews, c);

  return {
    has_industries: isRealValue("industries", c.industries, c),
    has_keywords: isRealValue("product_keywords", c.product_keywords, c),
    has_tagline: isRealValue("tagline", c.tagline, c),
    has_hq: isRealValue("headquarters_location", c.headquarters_location, c),
    has_mfg: isRealValue("manufacturing_locations", c.manufacturing_locations, c),
    has_logo: isRealValue("logo", c.logo_url, c),
    has_reviews: hasReviewsActual,
    reviews_satisfied: reviewsSatisfied,
    has_reviews_field: hasReviewsField,
    reviews_stage_status: reviewsStageRaw || null,
    logo_stage_status: asString(c.logo_stage_status).trim() || null,
    missing_fields,
  };
}

module.exports = {
  PLACEHOLDER_STRINGS,
  SENTINEL_STRINGS,
  asMeaningfulString,
  isMeaningfulString,
  normalizeStringArray,
  looksLikeHqLocationString,
  isRealValue,
  computeMissingFields,
  computeEnrichmentHealth,
};
