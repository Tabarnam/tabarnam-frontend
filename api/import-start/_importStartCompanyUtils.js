/**
 * Pure company data normalization and review utilities extracted from import-start/index.js.
 * No I/O, no Cosmos DB, no network calls — only deterministic data transforms.
 */

let createHash;
try {
  ({ createHash } = require("crypto"));
} catch {
  createHash = null;
}

// ── Country Normalization ─────────────────────────────────────────────────────
/** Normalize trailing country variants to "USA" in location strings. */
function normalizeCountryInLocation(location) {
  if (!location || typeof location !== "string") return location;
  return location.replace(
    /,\s*(United States of America|United States|U\.S\.A\.?|U\.S\.?)\s*$/i,
    ", USA"
  );
}

// ── Industry & Keyword Normalization ───────────────────────────────────────────

function normalizeIndustries(input) {
  if (Array.isArray(input))
    return [...new Set(input.map((s) => String(s).trim()).filter(Boolean))];
  if (typeof input === "string")
    return [
      ...new Set(
        input
          .split(/[,;|]/)
          .map((s) => s.trim())
          .filter(Boolean)
      ),
    ];
  return [];
}

function toBrandTokenFromWebsiteUrl(websiteUrl) {
  try {
    const raw = String(websiteUrl || "").trim();
    if (!raw) return "";
    const u = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    let h = u.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    const parts = h.split(".").filter(Boolean);
    return parts[0] || "";
  } catch {
    return "";
  }
}

function normalizeKeywordList(value) {
  const raw = value;
  const items = [];

  if (Array.isArray(raw)) {
    for (const v of raw) items.push(String(v));
  } else if (typeof raw === "string") {
    items.push(raw);
  }

  const split = items
    .flatMap((s) => String(s).split(/[,;|\n]/))
    .map((s) => s.trim())
    .filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const k of split) {
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

function normalizeProductKeywords(value, { companyName, websiteUrl } = {}) {
  const list = normalizeKeywordList(value);
  const name = String(companyName || "").trim();
  const nameNorm = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const brandToken = toBrandTokenFromWebsiteUrl(websiteUrl);

  return list
    .map((k) => k.trim())
    .filter(Boolean)
    .filter((k) => {
      const kl = k.toLowerCase();
      if (nameNorm && kl.includes(nameNorm)) return false;
      if (brandToken && (kl === brandToken || kl.includes(brandToken))) return false;
      return true;
    })
    .slice(0, 25);
}

function keywordListToString(list) {
  return (Array.isArray(list) ? list : []).join(", ");
}

// ── Number & Coordinate Helpers ────────────────────────────────────────────────

const safeNum = (n) => (Number.isFinite(Number(n)) ? Number(n) : undefined);

function safeCenter(c) {
  const lat = safeNum(c?.lat),
    lng = safeNum(c?.lng);
  return lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
}

function toFiniteNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// ── Domain Normalization ───────────────────────────────────────────────────────

const toNormalizedDomain = (s = "") => {
  try {
    const u = s.startsWith("http") ? new URL(s) : new URL(`https://${s}`);
    let h = u.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h || "unknown";
  } catch {
    return "unknown";
  }
};

// ── Company Enrichment ─────────────────────────────────────────────────────────

function enrichCompany(company, center) {
  const c = { ...(company || {}) };

  const industriesSource = String(c.industries_source || "").trim().toLowerCase();
  c.industries = industriesSource === "grok" ? normalizeIndustries(c.industries) : [];

  const websiteUrl = c.website_url || c.canonical_url || c.url || c.amazon_url || "";
  const companyName = c.company_name || c.name || "";

  const productKeywords = normalizeProductKeywords(c.product_keywords, {
    companyName,
    websiteUrl,
  });

  c.keywords = productKeywords;

  const keywordsSource = String(c.product_keywords_source || c.keywords_source || "").trim().toLowerCase();
  if (keywordsSource === "grok") {
    c.product_keywords = keywordListToString(productKeywords);
  } else {
    c.product_keywords = "";
  }

  const urlForDomain = c.canonical_url || c.website_url || c.url || c.amazon_url || "";
  c.normalized_domain = toNormalizedDomain(urlForDomain);

  c.headquarters_location = normalizeCountryInLocation(String(c.headquarters_location || "").trim());

  if (Array.isArray(c.manufacturing_locations)) {
    c.manufacturing_locations = c.manufacturing_locations
      .map(l => normalizeCountryInLocation(String(l).trim()))
      .filter(l => l.length > 0);
  } else if (typeof c.manufacturing_locations === 'string') {
    const trimmed = normalizeCountryInLocation(String(c.manufacturing_locations || "").trim());
    c.manufacturing_locations = trimmed ? [trimmed] : [];
  } else {
    c.manufacturing_locations = [];
  }

  if (!Array.isArray(c.location_sources)) {
    c.location_sources = [];
  }

  c.location_sources = c.location_sources
    .filter((s) => s && s.location)
    .map((s) => {
      const locationTypeRaw = String(s.location_type || s.locationType || "other").trim() || "other";
      const location_type = locationTypeRaw === "hq"
        ? "headquarters"
        : locationTypeRaw === "mfg"
          ? "manufacturing"
          : locationTypeRaw;

      const sourceMethod = String(s.source_method || s.sourceMethod || "").trim();

      return {
        location: String(s.location || "").trim(),
        source_url: String(s.source_url || "").trim(),
        source_type: s.source_type || "other",
        location_type,
        ...(sourceMethod ? { source_method: sourceMethod } : {}),
      };
    });

  c.tagline = String(c.tagline || "").trim();

  c.red_flag = Boolean(c.red_flag);
  c.red_flag_reason = String(c.red_flag_reason || "").trim();
  c.location_confidence = (c.location_confidence || "medium").toString().toLowerCase();

  return c;
}

// ── Location Normalization ─────────────────────────────────────────────────────

function normalizeLocationEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      if (typeof entry === "string") {
        const address = entry.trim();
        return address ? { address } : null;
      }
      if (entry && typeof entry === "object") return entry;
      return null;
    })
    .filter(Boolean);
}

/**
 * Deduplicate location entries by building a key from city|region|country (structured)
 * or the full address string (unstructured).  Keeps the FIRST occurrence (which is
 * typically the geocoded one with lat/lng) and drops later duplicates.
 */
function deduplicateLocationEntries(entries) {
  if (!Array.isArray(entries) || entries.length <= 1) return entries;
  const seen = new Set();
  return entries.filter((item) => {
    if (!item) return false;
    const key = locationDedupeKey(item);
    if (!key) return true; // keep items we can't key
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function locationDedupeKey(item) {
  if (typeof item === "string") return item.trim().toLowerCase();
  if (!item || typeof item !== "object") return "";
  const city = String(item.city || "").trim().toLowerCase();
  const region = String(item.region || item.state || item.state_code || "").trim().toLowerCase();
  const country = String(item.country || item.country_code || "").trim().toLowerCase();
  // If we have structured fields, use them
  if (city || country) return [city, region, country].filter(Boolean).join("|");
  // Fall back to address/formatted string
  const addr = String(item.address || item.formatted || item.full_address || item.location || "").trim().toLowerCase();
  if (addr) return addr;
  return "";
}

function buildImportLocations(company) {
  const headquartersBase =
    Array.isArray(company.headquarters) && company.headquarters.length > 0
      ? company.headquarters
      : Array.isArray(company.headquarters_locations) && company.headquarters_locations.length > 0
        ? company.headquarters_locations
        : company.headquarters_location && String(company.headquarters_location).trim()
          ? [{ address: String(company.headquarters_location).trim() }]
          : [];

  const manufacturingBase =
    Array.isArray(company.manufacturing_geocodes) && company.manufacturing_geocodes.length > 0
      ? company.manufacturing_geocodes
      : Array.isArray(company.manufacturing_locations) && company.manufacturing_locations.length > 0
        ? company.manufacturing_locations
        : [];

  return {
    headquartersBase: normalizeLocationEntries(headquartersBase),
    manufacturingBase: normalizeLocationEntries(manufacturingBase),
  };
}

// ── Review Utilities ───────────────────────────────────────────────────────────

function normalizeUrlForCompare(s) {
  const raw = typeof s === "string" ? s.trim() : s == null ? "" : String(s).trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.hash = "";
    const host = String(u.hostname || "").toLowerCase().replace(/^www\./, "");
    const path = String(u.pathname || "").replace(/\/+$/, "");
    const search = u.searchParams.toString();
    return `${u.protocol}//${host}${path}${search ? `?${search}` : ""}`;
  } catch {
    return raw.toLowerCase();
  }
}

function computeReviewDedupeKey(review) {
  const r = review && typeof review === "object" ? review : {};
  const normUrl = normalizeUrlForCompare(r.source_url || r.url || "");
  const title = String(r.title || "").trim().toLowerCase();
  const author = String(r.author || "").trim().toLowerCase();
  const date = String(r.date || "").trim();
  const rating = r.rating == null ? "" : String(r.rating);
  const excerpt = String(r.excerpt || r.abstract || "").trim().toLowerCase().slice(0, 160);

  const base = [normUrl, title, author, date, rating, excerpt].filter(Boolean).join("|");
  if (!base) return "";

  try {
    return createHash("sha1").update(base).digest("hex");
  } catch {
    return base;
  }
}

function dedupeCuratedReviews(reviews) {
  const list = Array.isArray(reviews) ? reviews : [];
  const out = [];
  const seen = new Set();

  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const k = String(r._dedupe_key || "").trim() || computeReviewDedupeKey(r);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...r, _dedupe_key: k });
  }

  return out;
}

function buildReviewCursor({ nowIso, count, exhausted, last_error, prev_cursor }) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  const exhaustedBool = typeof exhausted === "boolean" ? exhausted : false;
  const errObj =
    last_error && typeof last_error === "object" ? last_error : last_error ? { message: String(last_error) } : null;

  const prev = prev_cursor && typeof prev_cursor === "object" ? prev_cursor : null;
  const prevSuccessAt =
    typeof prev?.last_success_at === "string" && prev.last_success_at.trim() ? prev.last_success_at.trim() : null;

  const last_success_at = errObj == null && n > 0 ? nowIso : prevSuccessAt;

  return {
    source: "xai_reviews",
    last_offset: n,
    total_fetched: n,
    exhausted: exhaustedBool,
    last_attempt_at: nowIso,
    last_success_at,
    last_error: errObj,
  };
}

// ── Seed Validation ──────────────────────────────────────────────────────────

function isMeaningfulString(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  if (lower === "unknown" || lower === "n/a" || lower === "na" || lower === "none") return false;
  return true;
}

function hasMeaningfulSeedEnrichment(c) {
  if (!c || typeof c !== "object") return false;

  const industries = Array.isArray(c.industries) ? c.industries.filter(Boolean) : [];

  const keywordsRaw = c.keywords ?? c.product_keywords ?? c.keyword_list;
  const keywords =
    typeof keywordsRaw === "string"
      ? keywordsRaw.split(/\s*,\s*/g).filter(Boolean)
      : Array.isArray(keywordsRaw)
        ? keywordsRaw.filter(Boolean)
        : [];

  const manufacturingLocations = Array.isArray(c.manufacturing_locations)
    ? c.manufacturing_locations
        .map((loc) => {
          if (typeof loc === "string") return loc.trim();
          if (loc && typeof loc === "object") return String(loc.formatted || loc.address || loc.location || "").trim();
          return "";
        })
        .filter(Boolean)
    : [];

  const curatedReviews = Array.isArray(c.curated_reviews) ? c.curated_reviews.filter((r) => r && typeof r === "object") : [];
  const reviewCount = Number.isFinite(Number(c.review_count)) ? Number(c.review_count) : curatedReviews.length;

  return (
    industries.length > 0 ||
    keywords.length > 0 ||
    isMeaningfulString(c.headquarters_location) ||
    manufacturingLocations.length > 0 ||
    curatedReviews.length > 0 ||
    reviewCount > 0
  );
}

function isValidSeedCompany(c) {
  if (!c || typeof c !== "object") return false;

  const companyName = String(c.company_name || c.name || "").trim();
  const websiteUrl = String(c.website_url || c.url || c.canonical_url || "").trim();
  if (!companyName || !websiteUrl) return false;

  const id = String(c.id || c.company_id || c.companyId || "").trim();

  // Rule: if we already persisted a company doc (id exists), we can resume enrichment for it.
  if (id && !id.startsWith("_import_")) return true;

  const source = String(c.source || "").trim();

  // Critical: company_url_shortcut is NEVER a valid resume seed unless it already contains meaningful enrichment
  // (keywords/industries/HQ/MFG/reviews) or carries an explicit seed_ready marker.
  if (source === "company_url_shortcut") {
    if (c.seed_ready === true) return true;
    return hasMeaningfulSeedEnrichment(c);
  }

  if (source) return true;

  // Fallback: allow explicit markers that the seed came from primary.
  if (c.primary_candidate === true) return true;
  if (c.seed === true) return true;
  if (String(c.source_stage || "").trim() === "primary") return true;

  return false;
}

module.exports = {
  // Industry & Keywords
  normalizeIndustries,
  toBrandTokenFromWebsiteUrl,
  normalizeKeywordList,
  normalizeProductKeywords,
  keywordListToString,

  // Number/Coordinate helpers
  safeNum,
  safeCenter,
  toFiniteNumber,

  // Domain
  toNormalizedDomain,

  // Company enrichment
  enrichCompany,

  // Location
  normalizeCountryInLocation,
  normalizeLocationEntries,
  deduplicateLocationEntries,
  buildImportLocations,

  // Reviews
  normalizeUrlForCompare,
  computeReviewDedupeKey,
  dedupeCuratedReviews,
  buildReviewCursor,

  // Seed validation
  isMeaningfulString,
  hasMeaningfulSeedEnrichment,
  isValidSeedCompany,

  // Enrichment verification
  computeEnrichmentMissingFields,

  // Import quality policy
  applyLowQualityPolicy,
  pushMissingFieldEntry,
};

/**
 * Computes which minimal verification fields are missing from a company doc.
 * Only checks company_name and a working website_url — all other fields are
 * enrichment goals and do not gate persistence/verification.
 *
 * @param {object} company
 * @returns {string[]} Array of missing field names
 */
function computeEnrichmentMissingFields(company) {
  const c = company && typeof company === "object" ? company : {};
  const missing = [];

  const name = String(c.company_name || c.name || "").trim();
  if (!name) missing.push("company_name");

  const websiteUrlRaw = String(c.website_url || c.url || c.canonical_url || "").trim();
  const hasWorkingWebsite = (() => {
    if (!websiteUrlRaw) return false;
    const lowered = websiteUrlRaw.toLowerCase();
    if (lowered === "unknown" || lowered === "n/a" || lowered === "na") return false;
    try {
      const u = websiteUrlRaw.includes("://") ? new URL(websiteUrlRaw) : new URL(`https://${websiteUrlRaw}`);
      const host = String(u.hostname || "").toLowerCase();
      return Boolean(host && host.includes("."));
    } catch {
      return false;
    }
  })();

  if (!hasWorkingWebsite) missing.push("website_url");

  return missing;
}

// ── Import Quality Policy ─────────────────────────────────────────────────────

const DEFAULT_LOW_QUALITY_MAX_ATTEMPTS = 3;

/**
 * Evaluate low-quality / not-found retry policy for a single field.
 *
 * Tracks per-field attempt counts on the doc and returns whether the field
 * should be terminalized (retryable: false) or remain retryable.
 *
 * Mutates: doc.import_low_quality_attempts, doc.import_low_quality_attempts_meta,
 *          doc.import_request_id (when requestId is provided).
 *
 * @param {string} field
 * @param {string} reason
 * @param {{ doc: object, importMissingReason: object, requestId?: string, maxAttempts?: number }} opts
 * @returns {{ missing_reason: string, retryable: boolean, attemptCount: number }}
 */
function applyLowQualityPolicy(field, reason, { doc, importMissingReason, requestId, maxAttempts } = {}) {
  const MAX = typeof maxAttempts === "number" && maxAttempts > 0 ? maxAttempts : DEFAULT_LOW_QUALITY_MAX_ATTEMPTS;
  const f = String(field || "").trim();
  const r = String(reason || "").trim();
  if (!f) return { missing_reason: r || "missing", retryable: true, attemptCount: 0 };

  const supportsTerminalization = r === "low_quality" || r === "not_found";
  if (!supportsTerminalization) return { missing_reason: r || "missing", retryable: true, attemptCount: 0 };

  const terminalReason = r === "low_quality" ? "low_quality_terminal" : "not_found_terminal";

  const missingReasonMap = importMissingReason && typeof importMissingReason === "object" ? importMissingReason : {};
  const prev = String(missingReasonMap[f] || doc?.import_missing_reason?.[f] || "").trim();
  if (prev === "low_quality_terminal" || prev === "not_found_terminal") {
    return { missing_reason: prev, retryable: false, attemptCount: MAX };
  }

  const attemptsObj =
    doc.import_low_quality_attempts &&
    typeof doc.import_low_quality_attempts === "object" &&
    !Array.isArray(doc.import_low_quality_attempts)
      ? { ...doc.import_low_quality_attempts }
      : {};

  const metaObj =
    doc.import_low_quality_attempts_meta &&
    typeof doc.import_low_quality_attempts_meta === "object" &&
    !Array.isArray(doc.import_low_quality_attempts_meta)
      ? { ...doc.import_low_quality_attempts_meta }
      : {};

  const currentRequestId = String(requestId || "").trim();
  if (currentRequestId) doc.import_request_id = currentRequestId;
  const lastRequestId = String(metaObj[f] || "").trim();

  if (currentRequestId && lastRequestId !== currentRequestId) {
    attemptsObj[f] = (Number(attemptsObj[f]) || 0) + 1;
    metaObj[f] = currentRequestId;
  }

  doc.import_low_quality_attempts = attemptsObj;
  doc.import_low_quality_attempts_meta = metaObj;

  const attemptCount = Number(attemptsObj[f]) || 0;

  if (attemptCount >= MAX) {
    return { missing_reason: terminalReason, retryable: false, attemptCount };
  }

  return { missing_reason: r, retryable: true, attemptCount };
}

/**
 * Record a missing-field entry in the per-company import diagnostics arrays.
 *
 * Shared core logic for both index.js and _importStartSaveCompanies.js
 * ensureMissing wrappers. Callers add their own side-effects (e.g. addWarning).
 *
 * Mutates: importMissingFields (push), importMissingReason (set), importWarnings (push/replace).
 *
 * @param {string} field
 * @param {string} reason
 * @param {{ stage?: string, message?: string, retryable?: boolean, source_attempted?: string, root_cause?: string, importMissingFields: string[], importMissingReason: object, importWarnings: object[] }} opts
 * @returns {{ field: string, missing_reason: string, retryable: boolean, terminal: boolean, message: string, [key: string]: any }} The entry object
 */
function pushMissingFieldEntry(field, reason, opts = {}) {
  const {
    stage,
    message,
    retryable = true,
    source_attempted,
    root_cause,
    importMissingFields,
    importMissingReason,
    importWarnings,
  } = opts;

  const f = String(field || "").trim();
  if (!f) return null;

  const missing_reason = String(reason || "missing");
  const terminal =
    missing_reason === "not_disclosed" ||
    missing_reason === "low_quality_terminal" ||
    missing_reason === "not_found_terminal";

  if (Array.isArray(importMissingFields) && !importMissingFields.includes(f)) {
    importMissingFields.push(f);
  }

  // Prefer final, terminal decisions over earlier seed placeholders.
  if (importMissingReason && typeof importMissingReason === "object") {
    const prevReason = String(importMissingReason[f] || "").trim();
    if (!prevReason || terminal || prevReason === "seed_from_company_url") {
      importMissingReason[f] = missing_reason;
    }
  }

  const entry = {
    field: f,
    missing_reason,
    retryable: Boolean(retryable),
    terminal,
    message: String(message || "missing"),
  };

  if (root_cause !== undefined) entry.root_cause = root_cause;
  if (stage !== undefined) entry.stage = String(stage || "unknown");
  if (source_attempted !== undefined) entry.source_attempted = String(source_attempted || "");

  if (Array.isArray(importWarnings)) {
    const existingIndex = importWarnings.findIndex((w) => w && typeof w === "object" && w.field === f);
    if (existingIndex >= 0) importWarnings[existingIndex] = entry;
    else importWarnings.push(entry);
  }

  return entry;
}
