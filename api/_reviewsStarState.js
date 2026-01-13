function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function toNonNegativeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.trunc(n));
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normalizeReviewsStarSource(value) {
  const v = asString(value).trim().toLowerCase();
  if (v === "manual") return "manual";
  if (v === "auto") return "auto";
  return null;
}

function getCuratedReviewCount(doc) {
  return Array.isArray(doc?.curated_reviews) ? doc.curated_reviews.filter((r) => r && typeof r === "object").length : 0;
}

function computeHasAnyReviews(doc) {
  if (!doc || typeof doc !== "object") return false;

  const curatedCount = getCuratedReviewCount(doc);
  if (curatedCount >= 1) return true;

  // Fallback for legacy or alternate sources.
  const embeddedCount = Array.isArray(doc.reviews) ? doc.reviews.length : 0;
  if (embeddedCount >= 1) return true;

  const canonicalTotal = toNonNegativeInt(doc.review_count, 0);
  if (canonicalTotal >= 1) return true;

  const approved = toNonNegativeInt(doc.review_count_approved, 0);
  if (approved >= 1) return true;

  const editorial = toNonNegativeInt(doc.editorial_review_count, 0);
  if (editorial >= 1) return true;

  const amazon = toNonNegativeInt(doc.amazon_review_count, 0);
  if (amazon >= 1) return true;

  const pub = toNonNegativeInt(doc.public_review_count, 0);
  const priv = toNonNegativeInt(doc.private_review_count, 0);
  if (pub + priv >= 1) return true;

  return false;
}

function computeAutoReviewsStarValue(doc) {
  return computeHasAnyReviews(doc) ? 1.0 : 0.0;
}

function buildNextRatingWithReviewStar(doc, nextReviewStarValue) {
  const base = doc?.rating && typeof doc.rating === "object" ? doc.rating : {};
  const star3 = base.star3 && typeof base.star3 === "object" ? base.star3 : {};

  // Preserve existing notes + icon type.
  return {
    ...base,
    star3: {
      ...star3,
      value: clamp01(nextReviewStarValue),
    },
  };
}

/**
 * Deterministic precedence:
 * 1) Manual override: reviews_star_source === "manual"
 * 2) Auto-derived from reviews presence
 * 3) Default: 0.0 (and null source) when no reviews exist
 */
function resolveReviewsStarState(doc) {
  const source = normalizeReviewsStarSource(doc?.reviews_star_source);

  const autoValue = computeAutoReviewsStarValue(doc);

  const existingStarValue =
    doc?.reviews_star_value != null
      ? clamp01(doc.reviews_star_value)
      : doc?.rating?.star3 && typeof doc.rating.star3 === "object" && doc.rating.star3.value != null
        ? clamp01(doc.rating.star3.value)
        : 0.0;

  if (source === "manual") {
    return {
      auto_value: autoValue,
      next_source: "manual",
      next_value: existingStarValue,
      next_rating: buildNextRatingWithReviewStar(doc, existingStarValue),
    };
  }

  if (autoValue > 0) {
    return {
      auto_value: autoValue,
      next_source: "auto",
      next_value: autoValue,
      next_rating: buildNextRatingWithReviewStar(doc, autoValue),
    };
  }

  return {
    auto_value: autoValue,
    next_source: null,
    next_value: 0.0,
    next_rating: buildNextRatingWithReviewStar(doc, 0.0),
  };
}

module.exports = {
  normalizeReviewsStarSource,
  computeHasAnyReviews,
  computeAutoReviewsStarValue,
  resolveReviewsStarState,
};
