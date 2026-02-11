// Feature flag: Reviews are excluded from import workflow
// Set to true to re-enable reviews in the UI
export const REVIEWS_ENABLED = false;

export function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function importMissingReasonLabel(raw) {
  const key = asString(raw).trim();
  if (!key) return "missing";

  const normalized = key.toLowerCase();

  const map = {
    not_disclosed: "Not disclosed",
    "not-disclosed": "Not disclosed",
    exhausted: "Exhausted",
    low_quality_terminal: "Low quality (terminal)",
    not_found_terminal: "Not found (terminal)",
    conflicting_sources_terminal: "Conflicting sources (terminal)",
    upstream_unreachable: "Upstream unreachable",
  };

  return map[normalized] || key;
}

export function looksLikeUrlOrDomain(raw) {
  const s = asString(raw).trim();
  if (!s) return false;
  if (/\s/.test(s)) return false;

  try {
    const u = s.includes("://") ? new URL(s) : new URL(`https://${s}`);
    const host = (u.hostname || "").toLowerCase();
    if (!host || !host.includes(".")) return false;
    const parts = host.split(".").filter(Boolean);
    if (parts.length < 2) return false;
    const tld = parts[parts.length - 1];
    if (!tld || tld.length < 2) return false;
    return true;
  } catch {
    return false;
  }
}

export function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((it) => it && typeof it === "object");
}

export function isMeaningfulString(raw) {
  const s = asString(raw).trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  if (lower === "unknown" || lower === "n/a" || lower === "na" || lower === "none") return false;
  return true;
}

export function normalizeStringList(value) {
  if (value == null) return [];

  if (Array.isArray(value)) {
    return value
      .map((v) => asString(v).trim())
      .filter(Boolean)
      .map((v) => v.replace(/\s+/g, " "));
  }

  const raw = asString(value).trim();
  if (!raw) return [];

  return raw
    .split(/\s*,\s*/g)
    .map((v) => asString(v).trim())
    .filter(Boolean)
    .map((v) => v.replace(/\s+/g, " "));
}

export function hasMeaningfulSeedEnrichment(item) {
  if (!item || typeof item !== "object") return false;

  const industries = Array.isArray(item.industries) ? item.industries.filter(Boolean) : [];
  const keywordsRaw = item.keywords ?? item.product_keywords ?? item.keyword_list;
  const keywords = typeof keywordsRaw === "string" ? keywordsRaw.split(/\s*,\s*/g).filter(Boolean) : Array.isArray(keywordsRaw) ? keywordsRaw.filter(Boolean) : [];

  const manufacturingLocations = Array.isArray(item.manufacturing_locations)
    ? item.manufacturing_locations
        .map((loc) => {
          if (typeof loc === "string") return loc.trim();
          if (loc && typeof loc === "object") return asString(loc.formatted || loc.address || loc.location).trim();
          return "";
        })
        .filter(Boolean)
    : [];

  const curatedReviews = Array.isArray(item.curated_reviews) ? item.curated_reviews.filter((r) => r && typeof r === "object") : [];
  const reviewCount = Number.isFinite(Number(item.review_count)) ? Number(item.review_count) : curatedReviews.length;

  return (
    industries.length > 0 ||
    keywords.length > 0 ||
    isMeaningfulString(item.headquarters_location) ||
    manufacturingLocations.length > 0 ||
    curatedReviews.length > 0 ||
    reviewCount > 0
  );
}

export function isValidSeedCompany(item) {
  if (!item || typeof item !== "object") return false;

  const companyName = asString(item.company_name || item.name).trim();
  const websiteUrl = asString(item.website_url || item.url || item.canonical_url).trim();

  if (!companyName || !websiteUrl) return false;

  const id = asString(item.id || item.company_id).trim();

  // Rule: if a company doc is already persisted (id exists), it is always eligible for resume.
  if (id && !id.startsWith("_import_")) return true;

  const source = asString(item.source).trim();

  // Critical: company_url_shortcut is NEVER a valid resume seed unless it already contains meaningful enrichment
  // (keywords/industries/HQ/MFG/reviews) or carries an explicit seed_ready marker.
  if (source === "company_url_shortcut") {
    if (item.seed_ready === true) return true;
    return hasMeaningfulSeedEnrichment(item);
  }

  // For any other source, accept.
  if (source) return true;

  // Fallback: accept explicit markers that the seed is known-good for resume.
  if (item.primary_candidate === true) return true;
  if (item.seed === true) return true;
  if (asString(item.source_stage).trim() === "primary") return true;

  return false;
}

export function filterValidSeedCompanies(items) {
  const list = normalizeItems(items);
  return list.filter(isValidSeedCompany);
}

export function mergeById(prev, next) {
  const map = new Map();
  for (const item of prev) {
    const id = asString(item?.id || item?.company_id).trim();
    if (!id) continue;
    map.set(id, item);
  }
  for (const item of next) {
    const id = asString(item?.id || item?.company_id).trim();
    if (!id) continue;
    map.set(id, item);
  }
  return Array.from(map.values());
}

export function mergeUniqueStrings(prev, next) {
  const left = Array.isArray(prev) ? prev : [];
  const right = Array.isArray(next) ? next : [];

  const out = [];
  const seen = new Set();

  for (const item of [...left, ...right]) {
    const value = asString(item).trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }

  return out;
}

export function safeJsonParse(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function toPrettyJsonText(value) {
  if (typeof value === "string") {
    const parsed = safeJsonParse(value);
    if (parsed && typeof parsed === "object") return JSON.stringify(parsed, null, 2);
    return value;
  }

  try {
    const text = JSON.stringify(value, null, 2);
    return typeof text === "string" ? text : JSON.stringify({ value: asString(value) }, null, 2);
  } catch {
    return JSON.stringify({ value: asString(value) }, null, 2);
  }
}

export function toDisplayText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value, null, 2);
    return typeof text === "string" ? text : String(value);
  } catch {
    return String(value);
  }
}

export function toAbsoluteUrlForRepro(rawUrl) {
  const s = asString(rawUrl).trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  const origin = typeof window !== "undefined" && window.location?.origin ? window.location.origin : "";
  if (!origin) return s;
  if (s.startsWith("/")) return `${origin}${s}`;
  return `${origin}/${s}`;
}

export function sanitizeFilename(value) {
  return asString(value)
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
}

export function downloadTextFile({ filename, text, mime = "application/json" }) {
  const safeName = sanitizeFilename(filename) || "download.json";
  const content = typeof text === "string" ? text : "";

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = safeName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 2500);
}

export function downloadJsonFile({ filename, value }) {
  downloadTextFile({ filename, text: toPrettyJsonText(value), mime: "application/json" });
}

export function buildWindowsSafeCurlOutFileScript({ url, method, jsonBody }) {
  const safeUrl = toAbsoluteUrlForRepro(url);
  const safeMethod = asString(method).trim().toUpperCase() || "POST";
  const body = typeof jsonBody === "string" ? jsonBody : "";

  if (!safeUrl || !body) return "";

  return `@'\n${body}\n'@ | Out-File -Encoding ascii body.json\ncurl.exe -i -X ${safeMethod} "${safeUrl}" -H "Content-Type: application/json" --data-binary "@body.json"`;
}

export function buildWindowsSafeInvokeRestMethodScript({ url, method, jsonBody }) {
  const safeUrl = toAbsoluteUrlForRepro(url);
  const safeMethod = asString(method).trim().toUpperCase() || "POST";
  const body = typeof jsonBody === "string" ? jsonBody : "";

  if (!safeUrl || !body) return "";

  return `$body = @'\n${body}\n'@\nInvoke-RestMethod -Method ${safeMethod} -Uri "${safeUrl}" -ContentType "application/json" -Body $body`;
}

export function extractSessionId(value) {
  if (!value) return "";
  if (typeof value === "object") {
    return typeof value?.session_id === "string" ? value.session_id.trim() : "";
  }
  if (typeof value === "string") {
    const parsed = safeJsonParse(value);
    return typeof parsed?.session_id === "string" ? parsed.session_id.trim() : "";
  }
  return "";
}

export const IMPORT_LIMIT_MIN = 1;
export const IMPORT_LIMIT_MAX = 25;
export const IMPORT_LIMIT_DEFAULT = 1;

export const SUCCESSION_MIN = 1;
export const SUCCESSION_MAX = 50;
export const SUCCESSION_DEFAULT = 1;

export const IMPORT_STAGE_BEACON_TO_ENGLISH = Object.freeze({
  primary_enqueued: "Queued primary search",
  primary_search_started: "Searching for matching companies",
  primary_candidate_found: "Company candidate found",
  primary_expanding_candidates: "Expanding search for better matches",
  primary_early_exit: "Single match found. Finalizing import",
  primary_complete: "Primary search complete",
  primary_timeout: "Primary search timed out",
  primary_skipped_company_url: "URL import detected — primary search skipped",
  no_candidates_found: "No matching companies found",
  duplicate_detected: "Company already exists in database",
});

// Stage beacons that indicate the import is still progressing or completed successfully.
// When the banner says "no company saved" but the stage is one of these early/mid stages,
// display green (normal progression) instead of amber (warning). Amber is reserved for
// genuinely terminal states where the import completed with no result.
export const STAGE_BEACON_PROGRESS_OR_SUCCESS = new Set([
  "create_session",
  "primary_enqueued",
  "primary_search_started",
  "xai_primary_fetch_start",
  "primary_candidate_found",
  "primary_expanding_candidates",
  "primary_early_exit",
  "primary_complete",
  "primary_skipped_company_url",
  "company_url_seed_fallback",
  "enrichment_resume_blocked",
  "enrichment_incomplete_retryable",
  "complete",
]);

export const IMPORT_ERROR_CODE_TO_REASON = Object.freeze({
  primary_timeout: "Primary search timed out",
  no_candidates_found: "No matching companies found",
  DUPLICATE_DETECTED: "Company already exists in the database",
  MISSING_XAI_ENDPOINT: "Missing XAI endpoint configuration",
  MISSING_XAI_KEY: "Missing XAI API key configuration",
  MISSING_OUTBOUND_BODY: "Missing outbound body (import request payload)",
  stalled_worker: "Import worker stalled (heartbeat stale)",
});

// Enrichment field display labels for real-time status
export const ENRICH_FIELD_TO_DISPLAY = Object.freeze({
  tagline: "Fetching tagline",
  headquarters_location: "Finding headquarters",
  manufacturing_locations: "Finding manufacturing locations",
  industries: "Analyzing industries",
  product_keywords: "Extracting keywords",
  logo: "Finding logo",
  reviews: "Searching for reviews",
});

export function humanizeImportCode(raw) {
  const input = asString(raw).trim();
  if (!input) return "";

  const cleaned = input.replace(/[_-]+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function toEnglishImportStage(stageBeacon) {
  const key = asString(stageBeacon).trim();
  if (!key) return "";
  if (Object.prototype.hasOwnProperty.call(IMPORT_STAGE_BEACON_TO_ENGLISH, key)) return IMPORT_STAGE_BEACON_TO_ENGLISH[key];
  return humanizeImportCode(key);
}

export function toEnglishImportStopReason(lastErrorCode) {
  const key = asString(lastErrorCode).trim();
  if (!key) return "Import stopped.";
  if (Object.prototype.hasOwnProperty.call(IMPORT_ERROR_CODE_TO_REASON, key)) return IMPORT_ERROR_CODE_TO_REASON[key];
  return humanizeImportCode(key);
}

export function extractAcceptReason(body) {
  const obj = body && typeof body === "object" ? body : null;
  return asString(
    obj?.accept?.reason ??
      obj?.accept_reason ??
      obj?.reason ??
      obj?.root_cause ??
      obj?.error?.root_cause ??
      obj?.error?.reason
  ).trim();
}

export function isExpectedAsyncAcceptReason(reason) {
  const r = asString(reason).trim();
  if (!r) return false;
  return r === "upstream_timeout_returning_202" || r === "deadline_exceeded_returning_202";
}

export function isNonErrorAcceptedOutcome(body) {
  const obj = body && typeof body === "object" ? body : null;
  if (!obj) return false;

  if (obj.accepted === true) return true;

  const reason = extractAcceptReason(obj);
  if (isExpectedAsyncAcceptReason(reason)) return true;

  return false;
}

export function isPrimarySkippedCompanyUrl(stageBeacon) {
  return asString(stageBeacon).trim() === "primary_skipped_company_url";
}

export function formatDurationShort(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n >= 60_000) {
    const minutes = Math.round(n / 60_000);
    return `${minutes}m`;
  }
  const seconds = Math.round(n / 1000);
  return `${seconds}s`;
}

export function normalizeImportLimit(raw, fallback = IMPORT_LIMIT_DEFAULT) {
  const s = String(raw ?? "").trim();
  if (!s) return fallback;

  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;

  const truncated = Math.trunc(n);
  return Math.max(IMPORT_LIMIT_MIN, Math.min(IMPORT_LIMIT_MAX, truncated));
}

export function normalizeSuccessionCount(raw, fallback = SUCCESSION_DEFAULT) {
  const s = String(raw ?? "").trim();
  if (!s) return fallback;

  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;

  const truncated = Math.trunc(n);
  return Math.max(SUCCESSION_MIN, Math.min(SUCCESSION_MAX, truncated));
}
