function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

// Feature flag: Set to true to include reviews in required field checks during import
const REVIEWS_ENABLED = true;

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
  "shop by",
  "bestsellers",
  "best sellers",
  "featured",
  "new arrivals",
  "new",
  "collections",
  "collection",
  "categories",
  "category",
  "accessories",
  "bundles",
  "bundle",
  "kits",
  "kit",
  "gift cards",
  "gift card",
  "kids",
  "kid",
  "children",
  "adults",
  "men",
  "women",
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
  "bath & body",
  "bath and body",
  "soap",
  "skincare",
  "cosmetics",
  "home fragrance",
  "fragrance",
  "candle",
  "candles",
  "consumer goods",
  "manufacturing",
  "supplements",
  "healthcare",
  "medical",
  "pharmaceutical",
  "biotech",
  // Broader industries (tech, food, auto, etc.)
  "technology",
  "computer hardware",
  "consumer electronics",
  "confectionery",
  "chocolate",
  "automotive",
  "industrial",
  "education",
  "toys & games",
];

function toTitleCase(input) {
  const s = asString(input).trim();
  if (!s) return "";
  return s
    .toLowerCase()
    .split(/\s+/g)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const INDUSTRY_CANONICAL_MAP = [
  { match: ["supplement", "vitamin", "nutrition", "nutraceutical", "wellness"], canonical: "Supplements" },
  { match: ["oral care", "dental", "tooth", "teeth", "whitening", "mouth"], canonical: "Oral Care" },
  { match: ["skin", "skincare", "cosmetic", "beauty", "dermat"], canonical: "Skincare" },
  { match: ["personal care", "hygiene", "groom"], canonical: "Personal Care" },

  // Prefer these for brands like Pachasoap (avoid mapping "soap" into household cleaning).
  { match: ["soap", "bar soap", "hand soap", "handmade soap"], canonical: "Soap" },
  { match: ["bath", "bath & body", "bath and body", "body", "body wash", "shower", "shampoo", "conditioner"], canonical: "Bath & Body" },
  { match: ["home fragrance", "fragrance", "candle", "candles", "diffuser", "aromatherapy", "essential oil"], canonical: "Home Fragrance" },

  { match: ["household", "clean", "laundry", "disinfect", "detergent"], canonical: "Household Cleaning" },
  { match: ["pet", "veterinary", "dog", "cat"], canonical: "Pet Care" },
  { match: ["medical", "healthcare", "health care", "clinic", "pharma", "pharmaceutical"], canonical: "Healthcare" },
  { match: ["apparel", "clothing", "fashion"], canonical: "Apparel" },
  { match: ["furniture", "home decor", "homegoods", "home goods"], canonical: "Home Goods" },
  { match: ["outdoor", "sports", "fitness"], canonical: "Sports & Fitness" },
  { match: ["food", "beverage", "snack"], canonical: "Food & Beverage" },

  // Broader industries (tech, electronics, confectionery, auto, etc.)
  { match: ["technology", "tech", "software", "saas", "cloud"], canonical: "Technology" },
  { match: ["computer", "hardware", "peripheral", "accessory", "accessories"], canonical: "Computer Hardware" },
  { match: ["electronics", "consumer electronics", "audio", "video", "av"], canonical: "Consumer Electronics" },
  { match: ["chocolate", "confection", "candy", "sweets", "cocoa"], canonical: "Confectionery" },
  { match: ["automotive", "auto", "vehicle", "car"], canonical: "Automotive" },
  { match: ["industrial", "machinery", "equipment", "tools"], canonical: "Industrial Equipment" },
  { match: ["education", "edtech", "learning", "training"], canonical: "Education" },
  { match: ["toy", "toys", "games", "gaming"], canonical: "Toys & Games" },
];

function isPlausibleIndustryCandidate(key, raw) {
  const k = normalizeKey(key);
  const s = asString(raw).trim();
  if (!k) return false;
  if (!s) return false;

  if (PLACEHOLDER_STRINGS.has(k)) return false;
  if (SENTINEL_STRINGS.has(k)) return false;

  // Avoid UI crumbs / weird tokens.
  if (/https?:\/\//i.test(s)) return false;
  if (/[<>|{}]/.test(s)) return false;

  const words = k.split(/\s+/g).filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;

  // Keep reasonable length.
  if (k.length < 3 || k.length > 50) return false;

  // Must contain letters.
  if (!/[a-z]/i.test(k)) return false;

  // Reject pure numbers / heavy digits.
  const digitCount = (k.match(/\d/g) || []).length;
  if (digitCount > 2) return false;

  return true;
}

function sanitizeIndustries(value) {
  const raw = normalizeStringArray(value)
    .map(asMeaningfulString)
    .filter(Boolean);

  const seen = new Set();
  const valid = [];

  for (const item of raw) {
    const key = normalizeKey(item);
    if (!key) continue;

    // "Baby" alone is too ambiguous and has caused bad defaults; require a more specific label.
    if (key === "baby" || key === "babies") continue;

    if (INDUSTRY_MARKETPLACE_BUCKETS.has(key)) continue;

    // Reject obvious navigation labels.
    if (INDUSTRY_NAV_TERMS.some((t) => key.includes(t))) continue;

    // Map to a short, controlled vocabulary when possible.
    const mapped = INDUSTRY_CANONICAL_MAP.find((m) => m.match.some((tok) => key.includes(normalizeKey(tok))));
    const candidate = mapped ? mapped.canonical : toTitleCase(item);

    // As a fallback, accept values that match the allowlist keywords OR are plausible "industry-like" terms.
    const allow =
      Boolean(mapped) ||
      INDUSTRY_ALLOWLIST.some((t) => key.includes(normalizeKey(t))) ||
      isPlausibleIndustryCandidate(key, item);

    if (!allow) continue;

    const candidateKey = normalizeKey(candidate);
    if (!candidateKey) continue;
    if (seen.has(candidateKey)) continue;

    seen.add(candidateKey);
    valid.push(candidate);
  }

  return valid;
}

function isValidIndustries(value) {
  return sanitizeIndustries(value).length > 0;
}

// Product keywords quality gate
const KEYWORD_DISALLOW_TERMS = [
  // Legal / policy
  "unknown",
  "privacy",
  "terms",
  "policy",
  "cookie",
  "cookies",

  // Store UX / navigation
  "shop",
  "shop all",
  "all products",
  "collections",
  "collection",
  "new",
  "new arrivals",
  "best sellers",
  "bestsellers",
  "featured",
  "sale",
  "clearance",
  "promotions",
  "promo",
  "gift",
  "gifts",
  "gift card",
  "gift cards",
  "bundles",
  "bundle",
  "subscription",
  "subscribe",
  "rewards",
  "loyalty",
  "store locator",
  "locator",
  "track order",
  "wishlist",
  "favorites",

  // Customer support
  "shipping",
  "returns",
  "refund",
  "faq",
  "contact",
  "about",
  "careers",

  // Account / commerce
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

  // Social / external profiles
  "instagram",
  "facebook",
  "tiktok",
  "pinterest",
  "youtube",
  "twitter",

  // Not products
  "blog",
  "press",
  "wholesale",

  // Generic glue words / content scaffolding
  "free",
  "matters",
  "product",
  "products",
  "why",
  "because",
  "what",
  "leave",

  // HTML/CSS/JS junk
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

// Known product / tech acronyms that should NOT be rejected by the ALL CAPS heuristic.
// These commonly appear as ALL CAPS in keyword lists but are real product terms.
const PRODUCT_CAPS_ALLOWLIST = new Set([
  "USB", "HDMI", "LED", "LCD", "SSD", "HDD", "NVMe", "RGB",
  "AC", "DC", "HD", "4K", "VGA", "DVI", "AV", "PC", "TV",
  "IOT", "GPS", "CPU", "GPU", "RAM", "LAN", "WAN", "POE",
  "OLED", "AMOLED", "UHD", "HDR", "DAC", "AMP",
]);

function isKeywordJunk(keyword) {
  const raw = asString(keyword).trim();
  const key = normalizeKey(raw);
  if (!key) return true;

  if (PLACEHOLDER_STRINGS.has(key)) return true;

  // Code-ish / class names / CSS tokens
  if (/^(w|h|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr)-\d+/i.test(key)) return true;
  if (/stroke-\d+/i.test(key)) return true;
  if (/^text-[a-z0-9-]+$/i.test(key)) return true;

  // Common UI control tokens
  if (/^icon[-_]/i.test(key)) return true;
  if (key === "close" || key === "view" || key === "order") return true;

  // URLs / fragments
  if (key.includes("http://") || key.includes("https://")) return true;

  // Legal/nav terms
  if (KEYWORD_DISALLOW_TERMS.some((t) => key.includes(normalizeKey(t)))) return true;

  // Heuristic: ALL CAPS labels ("SHOP ALL", "BEST SELLERS") are rarely real product names.
  // Keep anything with digits (SKUs), known product acronyms, or longer descriptive phrases.
  const hasDigits = /\d/.test(raw);
  const isAllCaps = raw.length > 0 && raw === raw.toUpperCase() && /[A-Z]/.test(raw);
  if (isAllCaps && !hasDigits) {
    const words = raw.split(/\s+/).filter(Boolean);
    // Bypass rejection when any word is a known product/tech acronym
    const hasProductAcronym = words.some((w) => PRODUCT_CAPS_ALLOWLIST.has(w));
    if (!hasProductAcronym && words.length > 0 && words.length <= 4 && raw.length <= 30) return true;
  }

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

function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
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
        asString(loc.location).trim() ||
        asString(loc.country).trim();  // Also accept country-only locations (e.g., "USA", "China")

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

    // Quality gate: require at least 1 meaningful keyword after sanitization.
    if (stats.product_relevant_count < 1) return false;
    return true;
  }

  if (f === "tagline") {
    return Boolean(asMeaningfulString(value));
  }

  if (f === "headquarters_location" || f === "hq") {
    // Data-wins-over-flag: check actual values first, then consult _unknown flag
    // only when there is no real data.  Enrichment may populate the field without
    // clearing the stale hq_unknown flag (race condition / partial write).
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const formattedRaw = asString(value.formatted || value.full_address || value.address || value.location).trim();
      if (isSentinelString(formattedRaw)) return false;

      const formatted = asMeaningfulString(formattedRaw);
      if (formatted && looksLikeHqLocationString(formatted)) return true;

      const city = asMeaningfulString(value.city || value.locality);
      const region = asMeaningfulString(value.state || value.region || value.province);
      const country = asMeaningfulString(value.country);
      if (city && (region || country)) return true;

      if (isTrueish(doc?.hq_unknown)) return false;
      return false;
    }

    if (isSentinelString(value)) return false;
    if (looksLikeHqLocationString(value)) return true;

    // No real data — respect the unknown flag
    if (isTrueish(doc?.hq_unknown)) return false;
    return false;
  }

  if (f === "manufacturing_locations" || f === "mfg") {
    // Data-wins-over-flag: real location entries trump a stale mfg_unknown flag
    if (hasNonPlaceholderLocationEntry(value)) return true;
    if (isTrueish(doc?.mfg_unknown)) return false;
    return false;
  }

  if (f === "logo") {
    const logoUrl = asMeaningfulString(doc?.logo_url);
    if (logoUrl) return true;  // Has actual logo URL - field is present

    // Logo is missing if no URL, regardless of stage status
    // "not_found_on_site" should show as a missing field in Issues column
    return false;
  }

  if (f === "reviews" || f === "curated_reviews") {
    const curated = Array.isArray(doc?.curated_reviews)
      ? doc.curated_reviews.filter((r) => r && typeof r === "object")
      : [];

    const reviewCount = Number.isFinite(Number(doc?.review_count)) ? Number(doc.review_count) : 0;

    // If reviews_stage_status is "incomplete", the resume-worker has signaled that more
    // reviews are needed (e.g. verified count < REVIEWS_MIN_VIABLE).  Keep the field
    // unsatisfied so import-status won't finalize before a queued retry cycle can run.
    // Data-wins-over-flag: if curated reviews exist (admin-added or pipeline-found),
    // they satisfy the field regardless of the "incomplete" pipeline signal.
    // "incomplete" only blocks when there are truly no curated reviews yet.
    const stageStatus = (doc?.reviews_stage_status || doc?.review_cursor?.reviews_stage_status || "")
      .toString().toLowerCase().trim();
    if (stageStatus === "incomplete" && curated.length === 0) return false;

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

function computeMissingFields(company, { includeReviews = REVIEWS_ENABLED } = {}) {
  const c = company && typeof company === "object" ? company : {};
  const missing = [];

  if (!isRealValue("industries", c.industries, c)) missing.push("industries");
  if (!isRealValue("tagline", c.tagline, c)) missing.push("tagline");
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
  // Data-wins-over-flag: "incomplete" only blocks satisfaction when there are no
  // curated reviews. If reviews exist (admin-added or pipeline-found), the data
  // requirement is met regardless of the pipeline stage signal.
  const reviewsSatisfied = has_reviews_data && !(reviewsStageNormalized === "incomplete" && curated.length === 0);

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
  // NOTE: "low_quality" stays retryable; status/resume-worker convert it to "low_quality_terminal" via attempt caps.
  return new Set([
    "not_disclosed",
    "exhausted",
    "low_quality_terminal",
    "not_found_terminal",
    "not_found_on_site",
  ]).has(normalizeKey(reason));
}

function deriveMissingReason(doc, field) {
  const d = doc && typeof doc === "object" ? doc : {};
  const f = String(field || "").trim();

  // IMPORTANT: "Not disclosed" should only be treated as terminal when it is explicitly confirmed.
  // Otherwise, it can be a premature placeholder that would incorrectly stop Grok retries.
  if (f === "headquarters_location") {
    const reason =
      normalizeKey(d?.import_missing_reason?.headquarters_location) ||
      normalizeKey(d?.hq_unknown_reason) ||
      "";

    if (reason === "not_disclosed") return "not_disclosed";
  }

  if (f === "manufacturing_locations") {
    const reason =
      normalizeKey(d?.import_missing_reason?.manufacturing_locations) ||
      normalizeKey(d?.mfg_unknown_reason) ||
      normalizeKey(d?.manufacturing_locations_reason) ||
      "";

    if (reason === "not_disclosed") return "not_disclosed";
  }

  if (f === "reviews") {
    const stage = normalizeKey(d.reviews_stage_status || d.review_cursor?.reviews_stage_status);
    const cursorExhausted = Boolean(d.review_cursor && typeof d.review_cursor === "object" && d.review_cursor.exhausted === true);
    if (stage === "exhausted" || cursorExhausted) {
      // Below the minimum viable count (2), keep retryable — a fresh XAI call may
      // discover different URLs.  A single verified review is below the quality bar.
      const REVIEWS_MIN_VIABLE = 2;
      const verifiedCount = Array.isArray(d.curated_reviews)
        ? d.curated_reviews.filter(r => r && typeof r === "object").length
        : 0;
      if (verifiedCount < REVIEWS_MIN_VIABLE) return "exhausted_retryable";
      return "exhausted";
    }
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
