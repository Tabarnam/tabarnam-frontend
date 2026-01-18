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

// Industries quality gate
const INDUSTRY_MARKETPLACE_BUCKETS = new Set([
  "home goods",
  "home",
  "food",
  "electronics",
  "shopping",
  "retail",
  "marketplace",
]);

const INDUSTRY_NAV_TERMS = [
  "shop",
  "sale",
  "new arrivals",
  "collections",
  "gift cards",
  "customer service",
  "support",
  "contact",
  "about",
  "blog",
  "careers",
  "privacy",
  "terms",
  "shipping",
  "returns",
  "faq",
];

// Minimal allowlist/classifier for accepting industry values.
// Keep this list short + deterministic; it can be expanded as we learn.
const INDUSTRY_ALLOWLIST = [
  "oral care",
  "dental",
  "dental hygiene",
  "personal care",
  "healthcare",
  "medical",
  "pharmaceutical",
  "biotech",
  "cosmetics",
  "skincare",
  "consumer goods",
  "manufacturing",
  "supplements",
];

function sanitizeIndustries(value) {
  const raw = normalizeStringArray(value)
    .map(asMeaningfulString)
    .filter(Boolean);

  const seen = new Set();
  const valid = [];

  for (const item of raw) {
    const key = normalizeKey(item);
    if (!key) continue;

    if (INDUSTRY_MARKETPLACE_BUCKETS.has(key)) continue;

    // Reject obvious navigation labels.
    if (INDUSTRY_NAV_TERMS.some((t) => key.includes(t))) continue;

    // Require at least one classifier/allowlist signal.
    const allow = INDUSTRY_ALLOWLIST.some((t) => key.includes(t));
    if (!allow) continue;

    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(item);
  }

  return valid;
}

function isValidIndustries(value) {
  return sanitizeIndustries(value).length > 0;
}

// Product keywords quality gate
const KEYWORD_DISALLOW_TERMS = [
  "unknown",
  "privacy",
  "terms",
  "policy",
  "cookie",
  "cookies",
  "shipping",
  "returns",
  "refund",
  "faq",
  "contact",
  "about",
  "careers",
  "login",
  "sign in",
  "signup",
  "sign up",
  "account",
  "cart",
  "checkout",
  "search",
  "menu",
  "sitemap",
  "svg",
  "path",
  "stroke",
  "fill",
  "viewbox",
  "css",
  "tailwind",
  "javascript",
  "react",
];

function splitKeywordString(value) {
  const s = asString(value).trim();
  if (!s) return [];
  return s
    .split(/\s*,\s*/g)
    .map((v) => asString(v).trim())
    .filter(Boolean);
}

function normalizeKeyword(value) {
  const s = asMeaningfulString(value);
  if (!s) return "";
  return s.replace(/\s+/g, " ").trim();
}

function isKeywordJunk(keyword) {
  const key = normalizeKey(keyword);
  if (!key) return true;

  if (PLACEHOLDER_STRINGS.has(key)) return true;

  // Code-ish / class names / CSS tokens
  if (/^(w|h|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr)-\d+/i.test(key)) return true;
  if (/stroke-\d+/i.test(key)) return true;
  if (/^text-[a-z0-9-]+$/i.test(key)) return true;

  // URLs / fragments
  if (key.includes("http://") || key.includes("https://")) return true;

  // Legal/nav terms
  if (KEYWORD_DISALLOW_TERMS.some((t) => key.includes(normalizeKey(t)))) return true;

  // Too short or just symbols
  if (key.length < 3) return true;
  if (!/[a-z]/i.test(key)) return true;

  return false;
}

function sanitizeKeywords({ product_keywords, keywords }) {
  const rawFromProductKeywords = splitKeywordString(product_keywords);
  const rawFromKeywords = Array.isArray(keywords) ? keywords : [];

  const raw = [...rawFromProductKeywords, ...rawFromKeywords]
    .map(normalizeKeyword)
    .filter(Boolean);

  const total_raw = raw.length;

  const seen = new Set();
  const sanitized = [];

  for (const k of raw) {
    if (isKeywordJunk(k)) continue;
    const key = normalizeKey(k);
    if (seen.has(key)) continue;
    seen.add(key);
    sanitized.push(k);
  }

  return {
    total_raw,
    sanitized,
    sanitized_count: sanitized.length,
    product_relevant_count: sanitized.length,
  };
}

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

  // Treat explicit sentinels like "Not disclosed" as missing for HQ.
  if (SENTINEL_STRINGS.has(normalizeKey(s))) return false;

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

function isSentinelString(value) {
  const key = normalizeKey(value);
  return Boolean(key && SENTINEL_STRINGS.has(key));
}

function isTrueish(value) {
  if (value === true) return true;
  if (value === false) return false;
  const s = asString(value).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

function hasNonPlaceholderLocationEntry(list) {
  const arr = Array.isArray(list) ? list : list == null ? [] : [list];
  for (const loc of arr) {
    if (typeof loc === "string") {
      const key = normalizeKey(loc);
      if (!key) continue;
      if (PLACEHOLDER_STRINGS.has(key)) continue;
      if (SENTINEL_STRINGS.has(key)) continue;
      return true;
    }

    if (loc && typeof loc === "object") {
      const raw =
        asString(loc.formatted).trim() ||
        asString(loc.full_address).trim() ||
        asString(loc.address).trim() ||
        asString(loc.location).trim();

      const key = normalizeKey(raw);
      if (!key) continue;
      if (PLACEHOLDER_STRINGS.has(key)) continue;
      if (SENTINEL_STRINGS.has(key)) continue;
      return true;
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
    return isValidIndustries(value);
  }

  if (f === "product_keywords") {
    const stats = sanitizeKeywords({
      product_keywords: typeof value === "string" ? value : Array.isArray(value) ? value.join(", ") : "",
      keywords: doc?.keywords,
    });

    // Quality gate:
    // - must have at least 20 total raw keywords
    // - must have at least 10 product-relevant keywords after sanitization
    if (stats.total_raw < 20) return false;
    if (stats.product_relevant_count < 10) return false;

    return true;
  }

  if (f === "tagline") {
    return Boolean(asMeaningfulString(value));
  }

  if (f === "headquarters_location" || f === "hq") {
    if (isTrueish(doc?.hq_unknown)) return false;

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const formattedRaw = asString(value.formatted || value.full_address || value.address || value.location).trim();
      if (isSentinelString(formattedRaw)) return false;

      const formatted = asMeaningfulString(formattedRaw);
      if (formatted && looksLikeHqLocationString(formatted)) return true;

      const city = asMeaningfulString(value.city || value.locality);
      const region = asMeaningfulString(value.state || value.region || value.province);
      const country = asMeaningfulString(value.country);
      return Boolean(city && (region || country));
    }

    if (isSentinelString(value)) return false;
    return looksLikeHqLocationString(value);
  }

  if (f === "manufacturing_locations" || f === "mfg") {
    if (isTrueish(doc?.mfg_unknown)) return false;
    return hasNonPlaceholderLocationEntry(value);
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

    const reviewCount = Number.isFinite(Number(doc?.review_count)) ? Number(doc.review_count) : 0;

    // Data completeness (separate from retry/terminal state): we only treat reviews as present
    // when we actually have review data.
    return curated.length > 0 || reviewCount > 0;
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
  const reviewCount = Number.isFinite(Number(c.review_count)) ? Number(c.review_count) : 0;
  const reviewsStageNormalized = normalizeKey(reviewsStageRaw);

  const reviews_terminal = reviewsStageNormalized === "exhausted";
  const has_reviews_data = curated.length > 0 || reviewCount > 0;
  const reviewsSatisfied = has_reviews_data;

  return {
    has_industries: isRealValue("industries", c.industries, c),
    has_keywords: isRealValue("product_keywords", c.product_keywords, c),
    has_tagline: isRealValue("tagline", c.tagline, c),
    has_hq: isRealValue("headquarters_location", c.headquarters_location, c),
    has_mfg: isRealValue("manufacturing_locations", c.manufacturing_locations, c),
    has_logo: isRealValue("logo", c.logo_url, c),
    has_reviews: has_reviews_data,
    has_reviews_data,
    reviews_terminal,
    reviews_satisfied: reviewsSatisfied,
    has_reviews_field: hasReviewsField,
    reviews_stage_status: reviewsStageRaw || null,
    logo_stage_status: asString(c.logo_stage_status).trim() || null,
    missing_fields,
  };
}

function isTerminalMissingReason(reason) {
  // Terminal reasons are non-retryable, even if the field still counts as "missing" under the required-fields contract.
  return new Set(["not_disclosed", "exhausted", "low_quality_terminal", "not_found_terminal"]).has(normalizeKey(reason));
}

function deriveMissingReason(doc, field) {
  const d = doc && typeof doc === "object" ? doc : {};
  const f = String(field || "").trim();

  // IMPORTANT: terminal sentinel values MUST override any stale stored reasons.
  // This is required to prevent resume-needed from staying true forever when we already
  // concluded a field is terminal (e.g. "Not disclosed" or reviews exhausted).
  if (f === "headquarters_location") {
    const val = normalizeKey(d.headquarters_location);
    if (val === "not disclosed" || val === "not_disclosed") return "not_disclosed";
  }

  if (f === "manufacturing_locations") {
    const rawList = Array.isArray(d.manufacturing_locations)
      ? d.manufacturing_locations
      : d.manufacturing_locations == null
        ? []
        : [d.manufacturing_locations];

    const normalized = rawList
      .map((loc) => {
        if (typeof loc === "string") return normalizeKey(loc);
        if (loc && typeof loc === "object") {
          return normalizeKey(loc.formatted || loc.full_address || loc.address || loc.location);
        }
        return "";
      })
      .filter(Boolean);

    if (normalized.length > 0 && normalized.every((v) => v === "not disclosed" || v === "not_disclosed")) {
      return "not_disclosed";
    }
  }

  if (f === "reviews") {
    const stage = normalizeKey(d.reviews_stage_status || d.review_cursor?.reviews_stage_status);
    if (stage === "exhausted") return "exhausted";
    if (Boolean(d.review_cursor && typeof d.review_cursor === "object" && d.review_cursor.exhausted === true)) return "exhausted";
  }

  const reasons =
    d.import_missing_reason && typeof d.import_missing_reason === "object" && !Array.isArray(d.import_missing_reason)
      ? d.import_missing_reason
      : {};

  const direct = normalizeKey(reasons[f] || "");
  if (direct) return direct;

  if (f === "logo") {
    const stage = normalizeKey(d.logo_stage_status || d.logo_status);
    if (stage === "not_found_on_site") return "not_found_on_site";
  }

  return "";
}

function isTerminalMissingField(doc, field) {
  return isTerminalMissingReason(deriveMissingReason(doc, field));
}

module.exports = {
  PLACEHOLDER_STRINGS,
  SENTINEL_STRINGS,
  asMeaningfulString,
  isMeaningfulString,
  normalizeStringArray,
  looksLikeHqLocationString,
  sanitizeIndustries,
  isValidIndustries,
  sanitizeKeywords,
  isRealValue,
  computeMissingFields,
  computeEnrichmentHealth,
  isTerminalMissingReason,
  deriveMissingReason,
  isTerminalMissingField,
};
