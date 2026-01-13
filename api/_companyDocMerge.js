function isMeaningfulString(value) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return false;
  const lower = s.toLowerCase();
  if (lower === "unknown" || lower === "n/a" || lower === "na" || lower === "none") return false;
  return true;
}

function preferString(incoming, existing) {
  if (isMeaningfulString(incoming)) return String(incoming).trim();
  if (isMeaningfulString(existing)) return String(existing).trim();
  const inc = typeof incoming === "string" ? incoming.trim() : "";
  if (inc) return inc;
  return typeof existing === "string" ? existing.trim() : "";
}

function preferArray(incoming, existing) {
  const inc = Array.isArray(incoming) ? incoming : null;
  const ex = Array.isArray(existing) ? existing : null;
  if (inc && inc.length > 0) return inc;
  if (ex && ex.length > 0) return ex;
  return inc || ex || [];
}

function preferNonZeroNumber(incoming, existing) {
  const inc = Number(incoming);
  const ex = Number(existing);
  const incOk = Number.isFinite(inc);
  const exOk = Number.isFinite(ex);
  if (incOk && inc > 0) return inc;
  if (exOk && ex > 0) return ex;
  if (incOk) return inc;
  if (exOk) return ex;
  return 0;
}

function preferFinite(incoming, existing) {
  const inc = Number(incoming);
  if (Number.isFinite(inc)) return inc;
  const ex = Number(existing);
  if (Number.isFinite(ex)) return ex;
  return undefined;
}

function preferObjectByRecency(incoming, existing) {
  const inc = incoming && typeof incoming === "object" ? incoming : null;
  const ex = existing && typeof existing === "object" ? existing : null;
  if (!inc) return ex;
  if (!ex) return inc;

  const incTs =
    Date.parse(String(inc.last_attempt_at || inc.last_success_at || "")) ||
    Date.parse(String(inc.updated_at || "")) ||
    0;
  const exTs =
    Date.parse(String(ex.last_attempt_at || ex.last_success_at || "")) ||
    Date.parse(String(ex.updated_at || "")) ||
    0;

  return incTs >= exTs ? inc : ex;
}

const { normalizeReviewsStarSource } = require("./_reviewsStarState");

function mergeCompanyDocsForSession({ existingDoc, incomingDoc, finalNormalizedDomain }) {
  const merged = {
    ...existingDoc,
    ...incomingDoc,
    id: String(existingDoc.id),
    normalized_domain: String(existingDoc.normalized_domain || incomingDoc.normalized_domain || finalNormalizedDomain),
  };

  merged.company_name = preferString(incomingDoc.company_name, existingDoc.company_name);
  merged.name = preferString(incomingDoc.name, existingDoc.name);

  merged.url = preferString(incomingDoc.url, existingDoc.url);
  merged.website_url = preferString(incomingDoc.website_url, existingDoc.website_url);

  merged.industries = preferArray(incomingDoc.industries, existingDoc.industries);
  merged.keywords = preferArray(incomingDoc.keywords, existingDoc.keywords);
  merged.product_keywords = preferString(incomingDoc.product_keywords, existingDoc.product_keywords);

  merged.tagline = preferString(incomingDoc.tagline, existingDoc.tagline);

  merged.logo_url = preferString(incomingDoc.logo_url, existingDoc.logo_url) || null;
  merged.logo_source_url = preferString(incomingDoc.logo_source_url, existingDoc.logo_source_url) || null;
  merged.logo_source_location = preferString(incomingDoc.logo_source_location, existingDoc.logo_source_location) || null;
  merged.logo_source_domain = preferString(incomingDoc.logo_source_domain, existingDoc.logo_source_domain) || null;
  merged.logo_source_type = preferString(incomingDoc.logo_source_type, existingDoc.logo_source_type) || null;
  merged.logo_status = preferString(incomingDoc.logo_status, existingDoc.logo_status) || "";
  merged.logo_import_status = preferString(incomingDoc.logo_import_status, existingDoc.logo_import_status) || "";
  merged.logo_error = preferString(incomingDoc.logo_error, existingDoc.logo_error) || "";

  merged.location_sources = preferArray(incomingDoc.location_sources, existingDoc.location_sources);
  merged.show_location_sources_to_users =
    typeof incomingDoc.show_location_sources_to_users === "boolean"
      ? incomingDoc.show_location_sources_to_users
      : Boolean(existingDoc.show_location_sources_to_users);

  const incomingHq = preferString(incomingDoc.headquarters_location, "");
  const existingHq = preferString(existingDoc.headquarters_location, "");
  merged.headquarters_location = incomingHq || existingHq;

  const mergedHqHasValue = Boolean(merged.headquarters_location && merged.headquarters_location.trim());
  merged.hq_unknown = mergedHqHasValue ? false : Boolean(existingDoc.hq_unknown) || Boolean(incomingDoc.hq_unknown);
  merged.hq_unknown_reason = mergedHqHasValue ? "" : preferString(incomingDoc.hq_unknown_reason, existingDoc.hq_unknown_reason);

  merged.headquarters_locations = preferArray(incomingDoc.headquarters_locations, existingDoc.headquarters_locations);
  merged.headquarters = preferArray(incomingDoc.headquarters, existingDoc.headquarters);

  merged.hq_lat = preferFinite(incomingDoc.hq_lat, existingDoc.hq_lat);
  merged.hq_lng = preferFinite(incomingDoc.hq_lng, existingDoc.hq_lng);

  merged.manufacturing_locations = preferArray(incomingDoc.manufacturing_locations, existingDoc.manufacturing_locations);
  const mergedMfgHasValue = Array.isArray(merged.manufacturing_locations) && merged.manufacturing_locations.length > 0;

  merged.mfg_unknown = mergedMfgHasValue ? false : Boolean(existingDoc.mfg_unknown) || Boolean(incomingDoc.mfg_unknown);
  merged.mfg_unknown_reason = mergedMfgHasValue ? "" : preferString(incomingDoc.mfg_unknown_reason, existingDoc.mfg_unknown_reason);

  merged.manufacturing_geocodes = preferArray(incomingDoc.manufacturing_geocodes, existingDoc.manufacturing_geocodes);

  // Reviews should be treated as authoritative by recency.
  // Previous behavior used preferArray(), which meant an import/refresh that found 0 valid reviews
  // would *not* clear older, stale/broken reviews ("clog").
  const incomingReviewsTs = Date.parse(String(incomingDoc.reviews_last_updated_at || "")) || 0;
  const existingReviewsTs = Date.parse(String(existingDoc.reviews_last_updated_at || "")) || 0;
  const incomingHasReviewsField = Object.prototype.hasOwnProperty.call(incomingDoc || {}, "curated_reviews");

  if (incomingHasReviewsField && incomingReviewsTs > 0 && incomingReviewsTs >= existingReviewsTs) {
    merged.curated_reviews = Array.isArray(incomingDoc.curated_reviews)
      ? incomingDoc.curated_reviews
      : [];

    const incomingCount = Number(incomingDoc.review_count);
    merged.review_count = Number.isFinite(incomingCount) ? incomingCount : merged.curated_reviews.length;
    merged.reviews_last_updated_at = preferString(incomingDoc.reviews_last_updated_at, existingDoc.reviews_last_updated_at);
  } else {
    merged.curated_reviews = preferArray(incomingDoc.curated_reviews, existingDoc.curated_reviews);
    merged.review_count = preferNonZeroNumber(incomingDoc.review_count, existingDoc.review_count);
    merged.reviews_last_updated_at = preferString(incomingDoc.reviews_last_updated_at, existingDoc.reviews_last_updated_at);
  }

  merged.review_cursor = preferObjectByRecency(incomingDoc.review_cursor, existingDoc.review_cursor);

  merged.red_flag = typeof incomingDoc.red_flag === "boolean" ? incomingDoc.red_flag : Boolean(existingDoc.red_flag);
  merged.red_flag_reason = preferString(incomingDoc.red_flag_reason, existingDoc.red_flag_reason);
  merged.location_confidence = preferString(incomingDoc.location_confidence, existingDoc.location_confidence) || "medium";

  merged.social =
    incomingDoc.social && typeof incomingDoc.social === "object"
      ? incomingDoc.social
      : existingDoc.social && typeof existingDoc.social === "object"
        ? existingDoc.social
        : {};
  merged.amazon_url = preferString(incomingDoc.amazon_url, existingDoc.amazon_url);

  const incomingReviewsStarSource = normalizeReviewsStarSource(incomingDoc.reviews_star_source);
  const existingReviewsStarSource = normalizeReviewsStarSource(existingDoc.reviews_star_source);

  merged.reviews_star_source =
    existingReviewsStarSource === "manual" ? "manual" : incomingReviewsStarSource || existingReviewsStarSource || null;

  merged.reviews_star_value = (() => {
    const pick = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const incomingVal = pick(incomingDoc.reviews_star_value);
    const existingVal = pick(existingDoc.reviews_star_value);

    if (merged.reviews_star_source === "manual") {
      if (existingVal != null) return existingVal;
      const existingStar3 =
        existingDoc?.rating?.star3 && typeof existingDoc.rating.star3 === "object" ? pick(existingDoc.rating.star3.value) : null;
      return existingStar3 != null ? existingStar3 : 0;
    }

    if (incomingVal != null) return incomingVal;
    if (existingVal != null) return existingVal;
    return null;
  })();

  merged.rating_icon_type = preferString(incomingDoc.rating_icon_type, existingDoc.rating_icon_type) || "star";

  const existingRating = existingDoc.rating && typeof existingDoc.rating === "object" ? existingDoc.rating : null;
  const incomingRating = incomingDoc.rating && typeof incomingDoc.rating === "object" ? incomingDoc.rating : null;

  if (existingRating && incomingRating) {
    const next = { ...existingRating, ...incomingRating };

    // Preserve manual admin stars from existing doc (imports should never wipe admin adjustments).
    if (existingRating.star4 && typeof existingRating.star4 === "object") next.star4 = existingRating.star4;
    if (existingRating.star5 && typeof existingRating.star5 === "object") next.star5 = existingRating.star5;

    // Preserve manual override of review star3.
    if (existingReviewsStarSource === "manual" && existingRating.star3 && typeof existingRating.star3 === "object") {
      next.star3 = existingRating.star3;
    }

    merged.rating = next;
  } else if (existingRating) {
    merged.rating = existingRating;
  } else {
    merged.rating = incomingRating;
  }

  // Always preserve original created_at for the company doc.
  merged.created_at =
    typeof existingDoc.created_at === "string" && existingDoc.created_at.trim() ? existingDoc.created_at.trim() : incomingDoc.created_at;

  // updated_at should reflect this write.
  merged.updated_at = incomingDoc.updated_at;

  // Preserve any computed completeness when we have it.
  merged.profile_completeness =
    typeof incomingDoc.profile_completeness === "number" ? incomingDoc.profile_completeness : existingDoc.profile_completeness;
  merged.profile_completeness_version = incomingDoc.profile_completeness_version || existingDoc.profile_completeness_version;
  merged.profile_completeness_meta = incomingDoc.profile_completeness_meta || existingDoc.profile_completeness_meta;

  return merged;
}

module.exports = {
  mergeCompanyDocsForSession,
  _test: {
    isMeaningfulString,
    preferString,
    preferArray,
    preferNonZeroNumber,
    preferFinite,
    preferObjectByRecency,
    mergeCompanyDocsForSession,
  },
};
