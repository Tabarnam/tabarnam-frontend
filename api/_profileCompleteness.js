function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((v) => asString(v).trim()).filter(Boolean);
  }

  const s = asString(value).trim();
  if (!s) return [];

  return s
    .split(/\s*[,;|]\s*/g)
    .map((v) => v.trim())
    .filter(Boolean);
}

function hasStructuredLocations(value) {
  if (Array.isArray(value)) return value.length > 0;
  const s = asString(value).trim();
  return Boolean(s);
}

function hasManufacturing(company) {
  const base = company && typeof company === "object" ? company : {};
  return (
    (Array.isArray(base.manufacturing_geocodes) && base.manufacturing_geocodes.length > 0) ||
    (Array.isArray(base.manufacturing_locations) && base.manufacturing_locations.length > 0)
  );
}

function hasHeadquarters(company) {
  const base = company && typeof company === "object" ? company : {};
  return (
    hasStructuredLocations(base.headquarters_locations) ||
    hasStructuredLocations(base.headquarters) ||
    Boolean(asString(base.headquarters_location).trim())
  );
}

function hasReviews(company) {
  const base = company && typeof company === "object" ? company : {};
  if (Array.isArray(base.curated_reviews) && base.curated_reviews.length > 0) return true;
  if (Array.isArray(base.reviews) && base.reviews.length > 0) return true;

  const n = Number(base.editorial_review_count || base.review_count || 0);
  return Number.isFinite(n) && n > 0;
}

function computeProfileCompleteness(company) {
  const base = company && typeof company === "object" ? company : {};

  const hasTagline = Boolean(asString(base.tagline).trim());
  const industries = Array.isArray(base.industries) ? base.industries.filter(Boolean) : [];
  const hasIndustries = industries.length > 0;

  const keywords = normalizeStringList(base.keywords && Array.isArray(base.keywords) ? base.keywords : base.product_keywords || base.keywords);
  const keywordCount = keywords.length;

  const hqOk = hasHeadquarters(base);
  const mfgOk = hasManufacturing(base);
  const reviewsOk = hasReviews(base);

  let score = 0;
  if (hasTagline) score += 20;
  if (hasIndustries) score += 15;

  if (keywordCount >= 15) score += 20;
  else if (keywordCount >= 8) score += 15;
  else if (keywordCount >= 3) score += 8;

  if (hqOk) score += 15;
  if (mfgOk) score += 15;
  if (reviewsOk) score += 15;

  const clamped = Math.max(0, Math.min(100, Math.round(score)));

  return {
    profile_completeness: clamped,
    profile_completeness_version: 1,
    profile_completeness_meta: {
      has_tagline: hasTagline,
      industries_count: industries.length,
      keywords_count: keywordCount,
      has_hq: hqOk,
      has_mfg: mfgOk,
      has_reviews: reviewsOk,
    },
  };
}

module.exports = {
  computeProfileCompleteness,
};
