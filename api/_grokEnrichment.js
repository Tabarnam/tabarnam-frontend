// api/_grokEnrichment.js
// Overwrite file

const { xaiLiveSearch, extractTextFromXaiResponse } = require("./_xaiLiveSearch");
const { extractJsonFromText } = require("./_curatedReviewsXai");
const { buildSearchParameters } = require("./_buildSearchParameters");
const { FIELD_GUIDANCE, FIELD_SUMMARIES, QUALITY_RULES, SEARCH_PREAMBLE } = require("./_xaiPromptGuidance");
const { SENTINEL_STRINGS, PLACEHOLDER_STRINGS, isCountryOnlyLocation } = require("./_requiredFields");
const { discoverLogoSourceUrl } = require("./_logoImport");

// ============================================================================
// Module-level bypass flag for admin refresh
// Used to skip per-function budget validation when called from admin refresh,
// which manages its own overall deadline.
// ============================================================================
let _adminRefreshBypass = false;

function setAdminRefreshBypass(value) {
  _adminRefreshBypass = Boolean(value);
}

function isAdminRefreshBypass() {
  return _adminRefreshBypass;
}

// Promise.race-based timeout — rejects if the promise doesn't settle within `ms`.
// Used to cap fillMissingFieldsIndividually so it never exceeds its budget.
function raceTimeout(promise, ms, label = "operation") {
  let tid;
  const tp = new Promise((_, reject) => {
    tid = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), Math.max(1000, ms));
  });
  return Promise.race([promise, tp]).finally(() => clearTimeout(tid));
}

const DEFAULT_REVIEW_EXCLUDE_DOMAINS = [
  "amazon.",
  "amzn.to",
  "google.",
  "g.co",
  "goo.gl",
  "yelp.",
];

// US state abbreviations for country inference from "City, ST" format
const US_STATE_ABBREVIATIONS = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas",
  CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
  KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia"
};

// Canadian province abbreviations
const CA_PROVINCE_ABBREVIATIONS = {
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick",
  NL: "Newfoundland and Labrador", NS: "Nova Scotia", NT: "Northwest Territories",
  NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island", QC: "Quebec",
  SK: "Saskatchewan", YT: "Yukon"
};

// Reverse lookup: full name → abbreviation (for normalizing "Texas" → "TX")
const US_STATE_NAME_TO_ABBREV = Object.fromEntries(
  Object.entries(US_STATE_ABBREVIATIONS).map(([abbr, full]) => [full.toLowerCase(), abbr])
);
const CA_PROVINCE_NAME_TO_ABBREV = Object.fromEntries(
  Object.entries(CA_PROVINCE_ABBREVIATIONS).map(([abbr, full]) => [full.toLowerCase(), abbr])
);

/**
 * Infer country from "City, ST" format where ST is a US state or Canadian province abbreviation.
 * Returns null if the format doesn't match or the abbreviation is not recognized.
 */
function inferCountryFromStateAbbreviation(location) {
  if (!location || typeof location !== "string") return null;
  const trimmed = location.trim();

  // Match "City, ST" pattern (2-letter state/province code)
  const match = trimmed.match(/^(.+?),\s*([A-Z]{2})$/i);
  if (!match) return null;

  const [, city, stateCode] = match;
  const codeUpper = stateCode.toUpperCase();

  // Check US states first
  if (US_STATE_ABBREVIATIONS[codeUpper]) {
    return {
      city: city.trim(),
      state: US_STATE_ABBREVIATIONS[codeUpper],
      state_code: codeUpper,
      country: "USA",
      country_code: "US",
      // Use abbreviation (MO) in formatted string for display, not full name (Missouri)
      formatted: `${city.trim()}, ${codeUpper}, USA`
    };
  }

  // Check Canadian provinces
  if (CA_PROVINCE_ABBREVIATIONS[codeUpper]) {
    return {
      city: city.trim(),
      state: CA_PROVINCE_ABBREVIATIONS[codeUpper],
      state_code: codeUpper,
      country: "Canada",
      country_code: "CA",
      // Use abbreviation (ON) in formatted string for display, not full name (Ontario)
      formatted: `${city.trim()}, ${codeUpper}, Canada`
    };
  }

  return null;
}

/**
 * Normalize a location string to use state/province abbreviations.
 * Converts "Austin, Texas" → "Austin, TX" and "Toronto, Ontario" → "Toronto, ON".
 * Returns the original string if no state/province is recognized.
 */
function normalizeLocationWithStateAbbrev(location) {
  if (!location || typeof location !== "string") return location;
  const trimmed = location.trim();

  // Already in abbreviated format (City, ST) - validate and return normalized
  const abbrevMatch = trimmed.match(/^(.+?),\s*([A-Z]{2})$/i);
  if (abbrevMatch) {
    const codeUpper = abbrevMatch[2].toUpperCase();
    if (US_STATE_ABBREVIATIONS[codeUpper] || CA_PROVINCE_ABBREVIATIONS[codeUpper]) {
      return `${abbrevMatch[1].trim()}, ${codeUpper}`;
    }
  }

  // Try to match "City, StateName" or "City, StateName, Country"
  const fullMatch = trimmed.match(/^(.+?),\s*([A-Za-z\s]+?)(?:,\s*(.+))?$/);
  if (fullMatch) {
    const [, city, potentialState, country] = fullMatch;
    const stateNorm = potentialState.trim().toLowerCase();
    const abbrev = US_STATE_NAME_TO_ABBREV[stateNorm] || CA_PROVINCE_NAME_TO_ABBREV[stateNorm];
    if (abbrev) {
      return country
        ? `${city.trim()}, ${abbrev}, ${country.trim()}`
        : `${city.trim()}, ${abbrev}`;
    }
  }

  return trimmed;
}

/**
 * Normalize country name variants to a canonical short form.
 * "United States", "United States of America", "U.S.A.", "U.S.", "US" → "USA"
 * Applied to location strings after XAI response parsing.
 */
function normalizeCountryInLocation(location) {
  if (!location || typeof location !== "string") return location;
  // Replace country-part variants at the end of a location string
  return location.replace(
    /,\s*(United States of America|United States|U\.S\.A\.?|U\.S\.?)\s*$/i,
    ", USA"
  );
}

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return Math.max(min, Math.min(max, i));
}

// XAI stage timeout max: generous to allow deep, accurate XAI searches (3-5+ minutes per field).
function resolveXaiStageTimeoutMaxMs(fallback = 330_000) {
  const raw = Number(process.env.XAI_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return fallback;
  // Extended upper bound to allow thorough XAI research.
  return clampInt(raw, { min: 2_500, max: 600_000, fallback });
}

// Stage timeouts - increased to give xAI web search more time for complex queries.
// xAI performs real-time internet searches which can take 60-120+ seconds for thorough research.
// Previous values were too aggressive and caused upstream_timeout errors.
// With non-blocking import-one (no 4-min SWA gateway timeout), we can allow longer searches.
const XAI_STAGE_TIMEOUTS_MS = Object.freeze({
  reviews: { min: 150_000, max: 240_000 },     // 2.5-4 minutes for reviews (candidate generation + URL verification)
  keywords: { min: 90_000, max: 150_000 },     // 1.5-2.5 minutes for exhaustive keyword search
  location: { min: 90_000, max: 150_000 },     // 1.5-2.5 minutes for thorough location research
  light: { min: 30_000, max: 60_000 },         // 30s-1 min for simpler fields (tagline, industries)
});

// Five-Call Split timeouts (v5.0) — used by enrichCompanyFields() pipeline.
// Each field group gets a dedicated xAI call so the model can focus on thorough research.
// v5.0: Locations split into separate HQ + MFG calls (~60s each) instead of combined (240s timeout).
// xAI web search typically takes 30-90s for focused single-field queries.
const CALL_TIMEOUTS_MS = Object.freeze({
  locations:  { min: 45_000,  max: 120_000 },   // 0.75-2 min per standalone HQ or MFG call
  keywords:   { min: 90_000,  max: 180_000 },   // 1.5-3 min for product keywords (was 240s; 180s prevents keyword call from being parallel bottleneck)
  light:      { min: 45_000,  max: 90_000 },    // 0.75-1.5 min for tagline + industries (was 180s; if Grok can't find these in 90s, it won't)
  reviews:    { min: 90_000,  max: 120_000 },    // 1.5-2 min — fail fast so browseAboutPage fallback gets more budget
  structured: { min: 90_000,  max: 330_000 },    // Legacy — kept for retryMissingStructuredFields
});
// Backward compat alias
const TWO_CALL_TIMEOUTS_MS = CALL_TIMEOUTS_MS;

// Absolute minimum budget to attempt an xAI call at all.
// Resume cycles from import-status have only 15s budget. The ideal stage timeouts above are
// for fresh seeds with generous budgets. On resume cycles, we should still attempt xAI calls
// with whatever time is available, as long as it exceeds this floor. xAI often responds in
// 5-15 seconds for simple location/tagline queries.
const RESUME_MIN_BUDGET_MS = 10_000;

// Short-TTL cache to avoid re-paying the same Grok searches on resume cycles.
// This is best-effort (in-memory) and only caches non-transient outcomes.
const GROK_STAGE_CACHE = new Map();
const GROK_STAGE_CACHE_TTL_MS = 10 * 60 * 1000;

const IS_NODE_TEST_RUNNER =
  (Array.isArray(process.execArgv) && process.execArgv.includes("--test")) ||
  (Array.isArray(process.argv) && process.argv.includes("--test"));

function readStageCache(key) {
  const hasStub = globalThis && typeof globalThis.__xaiLiveSearchStub === "function";
  if (IS_NODE_TEST_RUNNER || hasStub) return null;
  const entry = GROK_STAGE_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > (entry.expires_at || 0)) {
    GROK_STAGE_CACHE.delete(key);
    return null;
  }
  return entry.value;
}

function writeStageCache(key, value, ttlMs = GROK_STAGE_CACHE_TTL_MS) {
  const hasStub = globalThis && typeof globalThis.__xaiLiveSearchStub === "function";
  if (IS_NODE_TEST_RUNNER || hasStub) return;
  const ttl = Math.max(1_000, Math.trunc(Number(ttlMs) || GROK_STAGE_CACHE_TTL_MS));
  GROK_STAGE_CACHE.set(key, { value, expires_at: Date.now() + ttl });
}

function sleepMs(ms) {
  const wait = Math.max(0, Math.trunc(Number(ms) || 0));
  if (wait <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, wait));
}

function isRetryableUpstreamFailure(result) {
  const r = result && typeof result === "object" ? result : {};
  const code = String(r.error_code || "").trim().toLowerCase();
  if (code === "upstream_timeout") return true;

  const http = Number(r?.diagnostics?.upstream_http_status || 0) || 0;
  if (http === 429) return true;
  if (http >= 500 && http <= 599) return true;

  const msg = String(r.error || "").toLowerCase();
  if (msg.includes("upstream_http_429") || msg.includes("upstream_http_5")) return true;

  return false;
}

/**
 * Check if a failure is specifically a 429 rate limit (not a timeout or 5xx).
 * 429s are instant rejections (<200ms) — retrying with a short backoff is cheap
 * and usually sufficient, unlike timeouts which burn 2-4 minutes each.
 */
function is429RateLimit(result) {
  if (!result || typeof result !== "object") return false;
  const http = Number(result?.diagnostics?.upstream_http_status || 0) || 0;
  if (http === 429) return true;
  const err = String(result.error || "").toLowerCase();
  return err === "upstream_http_429";
}

/**
 * Extract Retry-After value from xaiLiveSearch diagnostics (set by _xaiLiveSearch.js).
 * Returns milliseconds to wait, or 0 if not available.
 */
function extractRetryAfterMs(result) {
  if (!result || typeof result !== "object") return 0;
  const ms = Number(result?.diagnostics?.retry_after_ms || 0) || 0;
  return ms > 0 ? Math.min(ms, 120_000) : 0;
}

// ── Global 429 rate-limit cooldown ──────────────────────────────────────────
// When one call detects persistent 429s, it sets a cooldown timestamp.
// Subsequent calls in the same enrichment pipeline (running concurrently or
// sequentially) will wait until the cooldown expires before making their first
// xAI call. This prevents N independent calls from each burning through 4
// retries when the API is globally rate-limited.
let _rateLimitCooldownUntil = 0;

function setRateLimitCooldown(durationMs) {
  const until = Date.now() + Math.max(0, Math.trunc(Number(durationMs) || 0));
  if (until > _rateLimitCooldownUntil) {
    _rateLimitCooldownUntil = until;
  }
}

function getRateLimitCooldownRemaining() {
  const remaining = _rateLimitCooldownUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

/**
 * xAI live search with retry logic.
 *
 * Three retry mechanisms:
 *
 * 1. **Normal retries** (controlled by `maxAttempts`): For general retryable failures
 *    (timeouts, 5xx). Callers set maxAttempts=1 to avoid doubling multi-minute waits.
 *
 * 2. **429 rate-limit retries** (controlled by `max429Retries`): Automatic retries
 *    with exponential backoff specifically for HTTP 429. These are independent of
 *    maxAttempts because 429s are instant rejections (<200ms) — waiting 10-30s and
 *    retrying is cheap and almost always succeeds. Without this, a single rate-limit
 *    spike causes complete enrichment failure ("No fields could be enriched").
 *
 * 3. **Global cooldown**: When a call exhausts its 429 retries, it sets a global
 *    cooldown timestamp. Subsequent calls will wait for the cooldown before their
 *    first attempt, avoiding N independent calls each wasting retry budget on a
 *    known rate-limited API.
 */
async function xaiLiveSearchWithRetry({
  maxAttempts = 2,
  baseBackoffMs = 350,
  max429Retries = 5,
  base429BackoffMs = 10000,
  ...args
} = {}) {
  const attempts = Math.max(1, Math.min(3, Math.trunc(Number(maxAttempts) || 2)));
  const maxRlRetries = Math.max(0, Math.min(8, Math.trunc(Number(max429Retries) || 5)));

  let last = null;
  let rlRetriesUsed = 0;

  // ── Honor global cooldown from previous 429 exhaustion ──
  const cooldownRemaining = getRateLimitCooldownRemaining();
  if (cooldownRemaining > 0) {
    console.log(
      `[xaiLiveSearchWithRetry] Global 429 cooldown active — waiting ${cooldownRemaining}ms before first attempt`
    );
    await sleepMs(cooldownRemaining);
  }

  for (let i = 0; i < attempts; i += 1) {
    last = await xaiLiveSearch({ ...args, attempt: i });
    if (last && last.ok) return last;

    // ── 429 rate-limit: automatically retry with exponential backoff ──
    // Unlike timeouts (which burn 2-4 min each), 429s are instant rejections.
    // Backoff schedule: 10s → 15s → 22.5s → 33.75s → 50.6s ≈ 132s total wait.
    while (is429RateLimit(last) && rlRetriesUsed < maxRlRetries) {
      rlRetriesUsed += 1;
      const retryAfter = extractRetryAfterMs(last);
      const backoff = retryAfter || Math.round(base429BackoffMs * Math.pow(1.5, rlRetriesUsed - 1));
      console.log(
        `[xaiLiveSearchWithRetry] 429 rate limit — waiting ${backoff}ms ` +
        `(429-retry ${rlRetriesUsed}/${maxRlRetries})`
      );
      await sleepMs(backoff);
      last = await xaiLiveSearch({ ...args, attempt: i });
      if (last && last.ok) {
        // Rate limit cleared — reset global cooldown
        _rateLimitCooldownUntil = 0;
        return last;
      }
    }

    // If we exhausted 429 retries, set a global cooldown so concurrent/subsequent
    // calls don't each burn through their own retry budget on a known-rate-limited API.
    if (is429RateLimit(last) && rlRetriesUsed >= maxRlRetries) {
      setRateLimitCooldown(30_000); // 30s cooldown for the next caller
      console.log(
        `[xaiLiveSearchWithRetry] 429 retries exhausted (${rlRetriesUsed}/${maxRlRetries}) — ` +
        `set 30s global cooldown for subsequent calls`
      );
    }

    // Normal retry logic (for non-429 retryable failures like timeouts/5xx)
    if (i < attempts - 1 && isRetryableUpstreamFailure(last)) {
      await sleepMs(baseBackoffMs * Math.pow(2, i));
      continue;
    }

    return last;
  }

  return last;
}

// Extended timeout constraints to allow thorough XAI searches (3-5+ minutes per field).
function clampStageTimeoutMs({
  remainingMs,
  minMs = 2_500,
  maxMs = resolveXaiStageTimeoutMaxMs(),
  safetyMarginMs = 1_200,
  label = "",
} = {}) {
  const rem = Number.isFinite(Number(remainingMs)) ? Number(remainingMs) : 0;
  const min = clampInt(minMs, { min: 250, max: 600_000, fallback: 2_500 });
  const max = clampInt(maxMs, { min, max: 600_000, fallback: resolveXaiStageTimeoutMaxMs() });
  const safety = clampInt(safetyMarginMs, { min: 0, max: 20_000, fallback: 1_200 });

  const raw = Math.max(0, Math.trunc(rem - safety));
  const result = Math.max(min, Math.min(max, raw));
  if (label) {
    console.log(`[clampStageTimeout] ${label}: ${result}ms (remaining=${rem}, min=${min}, max=${max}, safety=${safety})`);
  }
  return result;
}

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function classifyXaiFailure(result) {
  const r = result && typeof result === "object" ? result : {};
  const code = String(r.error_code || "").trim().toLowerCase();
  if (code === "upstream_timeout") return "upstream_timeout";

  const msg = String(r.error || "").toLowerCase();
  const abortedByUs = Boolean(r?.diagnostics?.aborted_by_us);

  if (abortedByUs || /\b(canceled|cancelled|timeout|timed out|abort|aborted)\b/i.test(msg)) {
    return "upstream_timeout";
  }

  return "upstream_unreachable";
}

function resolveChatModel(provided) {
  const fromArg = asString(provided).trim();
  if (fromArg) return fromArg;

  return asString(process.env.XAI_CHAT_MODEL || process.env.XAI_MODEL || "grok-4-latest").trim();
}

function resolveSearchModel(provided) {
  const fromArg = asString(provided).trim();
  if (fromArg) return fromArg;

  return asString(
    process.env.XAI_SEARCH_MODEL || process.env.XAI_CHAT_MODEL || process.env.XAI_MODEL || "grok-4-latest"
  ).trim();
}

function normalizeDomain(raw) {
  const host = asString(raw).trim().toLowerCase();
  if (!host) return "";
  return host.replace(/^www\./, "").replace(/\.+$/, "");
}

/**
 * When xAI returns an array of objects instead of a single merged object,
 * merge all elements into one.  E.g. [{hq: …}, {mfg: …}] → {hq: …, mfg: …}
 * Returns the input unchanged if it is not an array of plain objects.
 */
function mergeArrayResponse(parsed) {
  if (!Array.isArray(parsed)) return parsed;
  if (parsed.length === 0) return null;
  // Only merge if every element is a plain object (not a nested array / null / primitive)
  if (!parsed.every(el => el && typeof el === "object" && !Array.isArray(el))) return parsed;

  // Deep merge (one level): recursively merge nested plain objects instead
  // of overwriting.  Preserves hq_source_urls AND mfg_source_urls when they
  // live under the same parent key (location_source_urls) in separate array
  // elements.  Shallow Object.assign would let the second object's
  // location_source_urls overwrite the first, silently losing hq_source_urls.
  const result = {};
  const deepMergedKeys = [];
  for (const obj of parsed) {
    for (const [key, val] of Object.entries(obj)) {
      if (
        val && typeof val === "object" && !Array.isArray(val) &&
        result[key] && typeof result[key] === "object" && !Array.isArray(result[key])
      ) {
        Object.assign(result[key], val);
        deepMergedKeys.push(key);
      } else {
        result[key] = val;
      }
    }
  }
  if (deepMergedKeys.length > 0) {
    console.log(`[mergeArrayResponse] deep-merged keys: [${deepMergedKeys.join(", ")}]`);
  }
  return result;
}

function parseJsonFromXaiResponse(resp) {
  const text = extractTextFromXaiResponse(resp);
  const parsed = extractJsonFromText(text);
  return parsed;
}

function normalizeExcludeDomains({ normalizedDomain } = {}) {
  const nd = normalizeDomain(normalizedDomain);

  const out = [];
  const push = (v) => {
    const s = asString(v).trim();
    if (!s) return;
    out.push(s);
  };

  for (const d of DEFAULT_REVIEW_EXCLUDE_DOMAINS) push(d);
  if (nd) {
    push(nd);
    push(`www.${nd}`);
  }

  return Array.from(new Set(out));
}

function safeUrl(raw) {
  const s = asString(raw).trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    u.hash = "";
    return u.toString();
  } catch {
    return s;
  }
}

function urlHost(raw) {
  const s = asString(raw).trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    return asString(u.hostname).trim().toLowerCase();
  } catch {
    return "";
  }
}

function normalizeHostForDedupe(host) {
  const h = asString(host).trim().toLowerCase();
  return h.replace(/^www\./, "").replace(/\.+$/, "");
}

function isYouTubeUrl(raw) {
  const host = normalizeHostForDedupe(urlHost(raw));
  return host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be";
}

function isXUrl(raw) {
  const host = normalizeHostForDedupe(urlHost(raw));
  return host === "x.com" || host === "twitter.com" || host === "mobile.twitter.com";
}

/**
 * Returns true if the URL is effectively a site root / homepage.
 * Examples that match:
 *   https://example.com
 *   https://example.com/
 *   https://www.example.com/
 *   https://example.com/?ref=123  (root with only query params)
 */
function isRootDomainUrl(raw) {
  const s = asString(raw).trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    return u.pathname === "/" || u.pathname === "";
  } catch {
    return false;
  }
}

/**
 * Check if two hosts belong to the same domain family (same root domain or subdomain relationship).
 * Used to detect cross-domain redirects that likely indicate URL recycling or content migration.
 */
function areSameDomainFamily(host1, host2) {
  const norm1 = normalizeHostForDedupe(host1);
  const norm2 = normalizeHostForDedupe(host2);
  if (!norm1 || !norm2) return false;
  if (norm1 === norm2) return true;
  // Check if one is a subdomain of the other
  if (norm1.endsWith(`.${norm2}`) || norm2.endsWith(`.${norm1}`)) return true;
  return false;
}

function parseHtmlMeta(html, { key, property } = {}) {
  const source = asString(html);
  if (!source) return null;

  const tryAttr = (attrName, attrValue) => {
    if (!attrValue) return null;
    const needle = String(attrValue).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `<meta[^>]+(?:${attrName}\\s*=\\s*"${needle}"|${attrName}\\s*=\\s*'${needle}'|${attrName}\\s*=\\s*${needle})[^>]+content\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))[^>]*>`,
      "i"
    );
    const m = source.match(re);
    return m && (m[1] || m[2] || m[3]) ? asString(m[1] || m[2] || m[3]).trim() : null;
  };

  if (key) {
    const byName = tryAttr("name", key);
    if (byName) return byName;
  }

  if (property) {
    const byProp = tryAttr("property", property);
    if (byProp) return byProp;
  }

  return null;
}

function parseHtmlTitle(html) {
  const source = asString(html);
  if (!source) return null;
  const m = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const text = asString(m[1]).replace(/\s+/g, " ").trim();
  return text || null;
}

async function fetchWithTimeout(url, { method = "GET", timeoutMs = 8000, headers } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(500, Math.trunc(Number(timeoutMs) || 8000)));
  try {
    const res = await fetch(url, {
      method,
      redirect: "follow",
      headers: headers && typeof headers === "object" ? headers : undefined,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// Known trusted magazine/blog domains that may have complex pages triggering false soft-404
const TRUSTED_BLOG_DOMAINS = [
  "allure.com", "byrdie.com", "vogue.com", "refinery29.com", "harpersbazaar.com",
  "elle.com", "cosmopolitan.com", "glamour.com", "instyle.com", "marieclaire.com",
  "wmagazine.com", "nylon.com", "bustle.com", "thecut.com", "teenvogue.com",
  "popsugar.com", "who what wear", "coveteur.com", "mindbodygreen.com",
];

async function verifyUrlReachable(url, { timeoutMs = 8000, soft404Bytes = 50_000 } = {}) {
  const attempted = safeUrl(url);
  if (!attempted) return { ok: false, url: attempted, status: 0, reason: "empty_url" };

  // Always use GET so we can read the response body for soft-404 detection.
  // HEAD returns 200 even on error pages (e.g. bevnet.com "brand invalid"),
  // bypassing our content-based checks.
  try {
    const res = await fetchWithTimeout(attempted, {
      method: "GET",
      timeoutMs,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const status = Number(res.status || 0) || 0;
    if (status < 200 || status >= 300) {
      return { ok: false, url: attempted, status, reason: `http_${status}` };
    }

    // Detect cross-domain redirects (e.g., thekitchn.com → apartmenttherapy.com)
    // This catches URL recycling where old article IDs redirect to unrelated content on different sites
    const finalUrl = res.url || attempted;
    const originalHost = urlHost(attempted);
    const finalHost = urlHost(finalUrl);
    if (originalHost && finalHost && !areSameDomainFamily(originalHost, finalHost)) {
      return {
        ok: false,
        url: attempted,
        final_url: finalUrl,
        status,
        reason: "cross_domain_redirect",
        original_host: originalHost,
        final_host: finalHost,
      };
    }

    const ct = asString(res.headers?.get ? res.headers.get("content-type") : "").toLowerCase();
    const isHtml = ct.includes("text/html") || ct.includes("application/xhtml");
    if (!isHtml) return { ok: true, url: attempted, status, final_url: finalUrl };

    const text = await res.text();
    const head = text.slice(0, soft404Bytes);
    const title = parseHtmlTitle(head);

    // Skip soft-404 detection for trusted blog domains (they often have complex pages)
    const isTrustedBlog = TRUSTED_BLOG_DOMAINS.some((d) => attempted.toLowerCase().includes(d));
    // Skip for YouTube — their pages contain "no longer available" in JS bundles even for
    // valid videos; YouTube URLs are verified by verifyYouTubeVideoAvailable() oEmbed check instead.
    const isYT = isYouTubeUrl(attempted);
    const soft404 =
      !isTrustedBlog &&
      !isYT &&
      ((title &&
        /\b(404|not found|page not found|invalid|no longer available|doesn'?t exist|has been removed)\b/i.test(
          title
        )) ||
        /\b(404|page not found|sorry,?\s+we\s+can'?t\s+find|brand.{0,20}invalid|content\s+(is\s+)?(not|un)\s*available|no longer available|doesn'?t exist|this\s+(page|article|content)\s+(has\s+been|was)\s+(removed|deleted)|requested\s+(page|resource|item).{0,15}(not|invalid))\b/i.test(
          head
        ));

    if (soft404) return { ok: false, url: attempted, status, reason: "soft_404" };

    return { ok: true, url: attempted, status, html_preview: head, final_url: finalUrl };
  } catch (e) {
    return { ok: false, url: attempted, status: 0, reason: asString(e?.message || e || "fetch_failed") };
  }
}

/**
 * Extract YouTube video ID from various URL formats
 */
function extractYouTubeVideoId(url) {
  if (!url) return null;
  const str = String(url).trim();

  // Handle youtu.be/VIDEO_ID
  const shortMatch = str.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1];

  // Handle youtube.com/watch?v=VIDEO_ID
  const watchMatch = str.match(/youtube\.com\/watch\?[^#]*v=([a-zA-Z0-9_-]{11})/);
  if (watchMatch) return watchMatch[1];

  // Handle youtube.com/embed/VIDEO_ID
  const embedMatch = str.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
  if (embedMatch) return embedMatch[1];

  // Handle youtube.com/v/VIDEO_ID
  const vMatch = str.match(/youtube\.com\/v\/([a-zA-Z0-9_-]{11})/);
  if (vMatch) return vMatch[1];

  return null;
}

/**
 * Check if a YouTube video is actually available using oEmbed endpoint
 * Returns { ok: true } if available, { ok: false, reason: "..." } if not
 */
async function verifyYouTubeVideoAvailable(url, { timeoutMs = 5000 } = {}) {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    return { ok: false, reason: "invalid_video_id" };
  }

  try {
    // YouTube oEmbed endpoint returns 404 for unavailable videos
    const oEmbedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const res = await fetchWithTimeout(oEmbedUrl, {
      method: "GET",
      timeoutMs,
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const status = Number(res.status || 0) || 0;

    // 404 = video doesn't exist or is private
    // 401 = embedding disabled (but video may exist)
    if (status === 404) {
      return { ok: false, reason: "video_not_found" };
    }

    if (status === 401) {
      // Video exists but embedding is disabled - check if it's actually watchable
      // by trying to get the watch page
      try {
        const watchRes = await fetchWithTimeout(`https://www.youtube.com/watch?v=${videoId}`, {
          method: "GET",
          timeoutMs,
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        const watchHtml = await watchRes.text().catch(() => "");
        // Check for "Video unavailable" message
        if (watchHtml.includes("Video unavailable") || watchHtml.includes("This video isn't available")) {
          return { ok: false, reason: "video_unavailable" };
        }
        // Video exists, just embedding disabled
        return { ok: true, video_id: videoId, embed_disabled: true };
      } catch {
        return { ok: false, reason: "video_check_failed" };
      }
    }

    if (status >= 200 && status < 300) {
      return { ok: true, video_id: videoId };
    }

    return { ok: false, reason: `youtube_oembed_http_${status}` };
  } catch (e) {
    return { ok: false, reason: asString(e?.message || e || "youtube_check_failed") };
  }
}

/**
 * Check if an X/Twitter tweet is available using the public oEmbed endpoint.
 * x.com returns 401/403 to unauthenticated GETs, so standard HTTP verification fails.
 * The oEmbed endpoint works without auth: 200 = valid tweet, 404 = deleted/non-existent.
 */
async function verifyXTweetAvailable(url, { timeoutMs = 5000 } = {}) {
  try {
    const oEmbedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetchWithTimeout(oEmbedUrl, {
      method: "GET",
      timeoutMs,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const status = Number(res.status || 0) || 0;
    if (status === 404 || status === 400) {
      return { ok: false, reason: "tweet_not_found" };
    }
    if (status >= 200 && status < 300) {
      return { ok: true };
    }
    return { ok: false, reason: `x_oembed_http_${status}` };
  } catch (e) {
    return { ok: false, reason: "x_oembed_fetch_failed" };
  }
}

/**
 * Check if the fetched HTML content actually mentions the company name
 * This helps filter out irrelevant blog posts
 */
function validateBlogContentRelevance(html, companyName) {
  if (!html || !companyName) return { relevant: false, reason: "missing_inputs" };

  const lowerHtml = html.toLowerCase();
  const lowerName = companyName.toLowerCase().trim();

  // Check for exact company name
  if (lowerHtml.includes(lowerName)) {
    return { relevant: true, match_type: "exact_name" };
  }

  // Check for company name without common suffixes (Co., Inc., LLC, etc.)
  const strippedName = lowerName
    .replace(/\s+(co\.?|inc\.?|llc\.?|ltd\.?|corp\.?|company|corporation)$/i, "")
    .trim();
  if (strippedName.length >= 3 && lowerHtml.includes(strippedName)) {
    return { relevant: true, match_type: "stripped_name" };
  }

  // Check for first word of company name if it's distinctive (4+ chars)
  const firstWord = lowerName.split(/\s+/)[0];
  if (firstWord.length >= 4 && lowerHtml.includes(firstWord)) {
    return { relevant: true, match_type: "first_word" };
  }

  return { relevant: false, reason: "company_not_mentioned" };
}

function buildReviewMetadataFromHtml(url, html) {
  const host = normalizeHostForDedupe(urlHost(url));
  const source_name = host ? host.replace(/^www\./, "") : "";

  const title =
    parseHtmlMeta(html, { property: "og:title" }) ||
    parseHtmlMeta(html, { key: "title" }) ||
    parseHtmlTitle(html);

  const excerpt =
    parseHtmlMeta(html, { property: "og:description" }) ||
    parseHtmlMeta(html, { key: "description" }) ||
    null;

  const author =
    parseHtmlMeta(html, { key: "author" }) ||
    parseHtmlMeta(html, { property: "article:author" }) ||
    null;

  const date =
    parseHtmlMeta(html, { property: "article:published_time" }) ||
    parseHtmlMeta(html, { key: "date" }) ||
    parseHtmlMeta(html, { key: "pubdate" }) ||
    parseHtmlMeta(html, { key: "publishdate" }) ||
    null;

  return {
    source_name: source_name || null,
    author: author ? author : null,
    source_url: safeUrl(url) || url,
    title: title ? title : null,
    date: date ? date : null,
    excerpt: excerpt ? excerpt : null,
  };
}

async function fetchCuratedReviews({
  companyName,
  normalizedDomain,
  budgetMs = 25000,
  xaiUrl,
  xaiKey,
  model = "grok-4-latest",
  attempted_urls = [],
  browseAboutPage = false,
  signal,
} = {}) {
  const started = Date.now();

  const name = asString(companyName).trim();
  const domain = normalizeDomain(normalizedDomain);

  const logResult = (status, extra = "") => {
    console.log(`[grokEnrichment] fetchCuratedReviews: DONE status=${status}, elapsed=${Date.now() - started}ms${extra ? ", " + extra : ""}`);
  };

  const cacheKey = domain ? `reviews:${domain}` : "";
  const cached = cacheKey ? readStageCache(cacheKey) : null;
  if (cached) {
    logResult("cache_hit");
    return {
      ...cached,
      diagnostics: {
        ...(cached.diagnostics && typeof cached.diagnostics === "object" ? cached.diagnostics : {}),
        cache: "hit",
      },
    };
  }

  const excludeDomains = normalizeExcludeDomains({ normalizedDomain: domain });

  const websiteUrlForPrompt = domain ? `https://${domain}` : "";

  // When browseAboutPage, remove company domain from prompt exclusions —
  // the retry prompt needs to browse the company's own website pages.
  const promptExcludeDomains = browseAboutPage
    ? excludeDomains.filter(d => d !== domain && d !== `www.${domain}`)
    : excludeDomains;

  // Declarative review prompt: ask for what we want, let Grok decide how to find it.
  // Client-side verification (URL reachability + YouTube oEmbed) provides a safety net.
  // On retry (browseAboutPage=true), simplified website-only fallback: browse company pages to constitute 1 review.
  const prompt = `${FIELD_GUIDANCE.reviews.rulesFull(name, promptExcludeDomains, attempted_urls, websiteUrlForPrompt || "(unknown website)", { browseAboutPage })}
${FIELD_GUIDANCE.reviews.plainTextFormat}`.trim();

  // v3.0: use TWO_CALL_TIMEOUTS_MS for generous review timeout (3-5 min)
  const stageTimeout = TWO_CALL_TIMEOUTS_MS.reviews;

  // Budget clamp: if we can't safely run another upstream call, defer without terminalizing.
  // Skip budget check when test stub is active (allows tests with small budgets).
  const hasStub = globalThis && typeof globalThis.__xaiLiveSearchStub === "function";
  const remaining = budgetMs - (Date.now() - started);
  const minRequired = Math.min(stageTimeout.min + 1_200, RESUME_MIN_BUDGET_MS);
  console.log(`[grokEnrichment] fetchCuratedReviews: budgetMs=${budgetMs}, remaining=${remaining}, minRequired=${minRequired}, hasStub=${hasStub}, browseAboutPage=${browseAboutPage}`);
  if (!hasStub) {
    if (remaining < minRequired) {
      logResult("deferred", `remaining=${remaining}ms, minRequired=${minRequired}ms`);
      return {
        curated_reviews: [],
        reviews_stage_status: "deferred",
        diagnostics: {
          reason: "budget_too_low",
          remaining_ms: Math.max(0, remaining),
          min_required_ms: minRequired,
        },
      };
    }
  }

  // When browseAboutPage, don't exclude the company domain from web_search tool —
  // the retry prompt needs Grok to browse company website pages.
  const searchBuild = browseAboutPage
    ? buildSearchParameters({
        companyWebsiteHost: null,
        additionalExcludedHosts: excludeDomains.filter(d => d !== domain && d !== `www.${domain}`),
      })
    : buildSearchParameters({
        companyWebsiteHost: domain,
        additionalExcludedHosts: excludeDomains,
      });

  const maxTimeoutMs = Math.min(stageTimeout.max, resolveXaiStageTimeoutMaxMs());

  const r = await xaiLiveSearchWithRetry({
    prompt,
    timeoutMs: clampStageTimeoutMs({
      remainingMs: remaining,
      minMs: Math.min(stageTimeout.min, Math.max(2_500, remaining - 1_200)),
      maxMs: maxTimeoutMs,
      safetyMarginMs: 1_200,
      label: "reviews",
    }),
    maxAttempts: 1,   // No retry — review timeout is already generous (150-240s); retrying doubles it
    maxTokens: 2000,  // 2 reviews need less output than the previous 3-5
    model: asString(model).trim() || "grok-4-latest",
    xaiUrl,
    xaiKey,
    signal,
    search_parameters: {
      ...searchBuild.search_parameters,
      excluded_domains: searchBuild.excluded_domains,
    },
    useTools: true,   // Reviews need real web search — includes page browsing in agentic flow
  });

  if (!r.ok) {
    const failure = classifyXaiFailure(r);
    logResult(failure, `error=${r.error || "unknown"}`);
    return {
      curated_reviews: [],
      reviews_stage_status: failure,
      diagnostics: {
        error: r.error,
        error_code: failure,
        ...(r.diagnostics && typeof r.diagnostics === "object" ? r.diagnostics : {}),
      },
      search_telemetry: searchBuild.telemetry,
      excluded_hosts: searchBuild.excluded_hosts,
    };
  }

  // Diagnostic: log response shape for tools-based review calls
  const _respShape = r.resp && typeof r.resp === "object" ? r.resp : {};
  const _respInner = _respShape.data && typeof _respShape.data === "object" ? _respShape.data : _respShape;
  console.log(`[fetchCuratedReviews] response_shape`, {
    has_output_text: typeof _respInner.output_text === "string",
    output_text_len: typeof _respInner.output_text === "string" ? _respInner.output_text.length : null,
    has_output: Array.isArray(_respInner.output),
    output_len: Array.isArray(_respInner.output) ? _respInner.output.length : null,
    output_types: Array.isArray(_respInner.output)
      ? _respInner.output.map(i => `${i?.type || "?"}${i?.role ? ":" + i.role : ""}`)
      : null,
    top_keys: Object.keys(_respInner).slice(0, 12),
  });

  // Scannable web_search_call count (avoids manual counting in response_shape output_types)
  const _outputTypes = Array.isArray(_respInner.output)
    ? _respInner.output.map(i => i?.type || "?")
    : [];
  const _webSearchCallCount = _outputTypes.filter(t => t === "web_search_call").length;
  console.log(`[fetchCuratedReviews] web_search_calls=${_webSearchCallCount}, elapsed=${Date.now() - started}ms`);

  // Parse response — try plain-text format first (Source:/Author:/URL:), fall back to JSON.
  const rawText = asString(extractTextFromXaiResponse(r.resp));

  // Diagnostic: always log rawText metrics so we can trace parsing failures
  console.log(`[fetchCuratedReviews] rawText: ${rawText ? rawText.length : 0} chars, preview: ${rawText ? rawText.slice(0, 300).replace(/\n/g, "\\n") : "(empty)"}`);
  if (!rawText || rawText.length < 10) {
    console.warn(`[fetchCuratedReviews] rawText extraction produced ${rawText ? rawText.length : 0} chars (expected review data)`);
  }
  let rawCandidates = null;

  // Plain-text parser: split on "Source:" blocks
  if (rawText && /\bSource:\s*.+/i.test(rawText)) {
    const blocks = rawText.split(/(?:^|\n)(?=Source:\s)/i).filter((b) => b.trim());
    const ptCandidates = [];
    for (const block of blocks) {
      const getField = (label) => {
        const m = block.match(new RegExp(`^${label}:\\s*(.+)`, "im"));
        return m ? m[1].trim() : "";
      };
      const url = getField("URL");
      if (!url) continue;
      ptCandidates.push({
        source_url: url,
        source_name: getField("Source") || null,
        author: getField("Author") || null,
        title: getField("Title") || null,
        date: getField("Date") || null,
        excerpt: getField("Text") || null,
        category: isYouTubeUrl(url) ? "youtube" : "blog",
      });
    }
    if (ptCandidates.length > 0) rawCandidates = ptCandidates;
  }

  // Fall back to JSON parsing if plain-text didn't yield results
  if (!rawCandidates) {
    const parsed = parseJsonFromXaiResponse(r.resp);
    rawCandidates =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Array.isArray(parsed.reviews_url_candidates)
          ? parsed.reviews_url_candidates
          : Array.isArray(parsed.review_candidates)
            ? parsed.review_candidates
            : null
        : null;
  }

  if (!rawCandidates) {
    // Distinguish "xAI searched but found nothing" from "response was unparseable garbage"
    // or from "all-search-no-answer" (Grok did web searches but never produced a text message)
    const noResultsPattern = /no\s+(verified|third[- ]party)?\s*reviews?\s+(were\s+)?found|could\s+not\s+find|unable\s+to\s+find|no\s+results/i;
    const isEmptySearch = rawText && rawText.length > 10 && noResultsPattern.test(rawText);
    const outputTypes = Array.isArray(_respInner.output)
      ? _respInner.output.map(i => i?.type || "?")
      : [];
    const hasSearchCalls = outputTypes.some(t => t === "web_search_call");
    const hasMessage = outputTypes.some(t => t === "message");
    const isAllSearchNoAnswer = hasSearchCalls && !hasMessage && (!rawText || rawText.length < 10);
    const status = isEmptySearch ? "empty" : isAllSearchNoAnswer ? "no_synthesis" : "invalid_response";
    const reason = isEmptySearch ? "xai_found_no_reviews"
      : isAllSearchNoAnswer ? `grok_searched_${outputTypes.filter(t => t === "web_search_call").length}_times_but_no_text`
      : "no_parseable_reviews";
    if (isAllSearchNoAnswer) {
      console.warn(`[fetchCuratedReviews] Grok all-search-no-answer: ${outputTypes.length} output items (${outputTypes.filter(t => t === "web_search_call").length} searches), no text message produced`);
    }
    logResult(status, reason);
    return {
      curated_reviews: [],
      reviews_stage_status: status,
      diagnostics: {
        reason,
        raw_preview: rawText ? rawText.slice(0, 1200) : null,
      },
      search_telemetry: searchBuild.telemetry,
      excluded_hosts: searchBuild.excluded_hosts,
    };
  }

  const candidates = rawCandidates
    .filter((x) => x && typeof x === "object")
    .map((x) => {
      const url = safeUrl(x.source_url || x.url || x.link);
      const categoryRaw = asString(x.category || x.type || "").trim().toLowerCase();
      const category = categoryRaw === "youtube" || isYouTubeUrl(url) ? "youtube" : "blog";
      const sourceName = asString(x.source_name || "").trim() || null;
      // Detect website testimonial entries (strategy 5 last-resort fallback)
      const isWebsiteTestimonial = Boolean(
        sourceName && /\bwebsite\b/i.test(sourceName) &&
        domain && url && url.includes(domain)
      );
      return {
        source_url: url,
        category,
        source_name: sourceName,
        title: asString(x.title || "").trim() || null,
        date: asString(x.date || "").trim() || null,
        excerpt: asString(x.excerpt || "").trim() || null,
        author: asString(x.author || "").trim() || null,
        is_website_testimonial: isWebsiteTestimonial,
      };
    })
    .filter((x) => x.source_url)
    .filter((x) => {
      const raw = String(x.source_url || "").trim().toLowerCase();
      if (raw === "n/a" || raw === "na" || raw === "none" || raw === "null" || raw === "undefined" || raw === "-" || raw === "#") {
        console.log(`[grokEnrichment] reviews: placeholder_url_rejected: "${x.source_url}"`);
        return false;
      }
      return true;
    })
    // Reject root/homepage URLs for the company's own domain — a review on the company site must link to a specific page.
    // Exception: website testimonials (browseAboutPage may use the homepage as a last-resort source).
    .filter((x) => {
      if (isRootDomainUrl(x.source_url) && domain && x.source_url.includes(domain)) {
        if (x.is_website_testimonial) return true;
        console.log(`[grokEnrichment] reviews: company_root_url_rejected: "${x.source_url}"`);
        return false;
      }
      return true;
    })
    // Exclude company's own domain — EXCEPT for website testimonial entries (strategy 5)
    .filter((x) => x.is_website_testimonial || !excludeDomains.some((d) => x.source_url.includes(d)))
    .filter((x) => {
      const len = (x.excerpt || "").length;
      const minLen = x.is_website_testimonial ? 30 : 100;
      if (len < minLen) {
        console.log(`[grokEnrichment] reviews: excerpt_too_short (${len} chars < ${minLen}): ${x.source_url}`);
        return false;
      }
      return true;
    });

  if (candidates.length === 0) {
    logResult("not_found", "0 candidates after filtering");
    return {
      curated_reviews: [],
      reviews_stage_status: "not_found",
      diagnostics: { candidate_count: 0, verified_count: 0 },
      search_telemetry: searchBuild.telemetry,
      excluded_hosts: searchBuild.excluded_hosts,
    };
  }

  const deduped = [];
  const seenUrls = new Set();
  for (const c of candidates) {
    const u = safeUrl(c.source_url);
    if (!u || seenUrls.has(u)) continue;
    seenUrls.add(u);
    deduped.push({ ...c, source_url: u });
  }

  // Streamlined verification: URL reachability + YouTube oEmbed only.
  // Trust Grok's judgment on content relevance (it read the page).
  const this_attempt_urls = [];
  const verified_reviews = [];
  const usedHosts = new Set();

  const perUrlTimeoutMs = clampInt(remaining / 6, { min: 3000, max: 10000, fallback: 6000 });

  for (const c of deduped) {
    if (Date.now() - started > budgetMs - 1500) break;
    if (verified_reviews.length >= 5) break;

    // Prefer unique blog/magazine domains when possible (YouTube is exempt — multiple
    // videos from different creators on youtube.com are all valid unique reviews).
    const host = normalizeHostForDedupe(urlHost(c.source_url));
    const isYT = c.category === "youtube" || isYouTubeUrl(c.source_url);
    const isX = isXUrl(c.source_url);
    if (
      !isYT &&
      !isX &&
      host &&
      usedHosts.has(host) &&
      deduped.some((x) => normalizeHostForDedupe(urlHost(x.source_url)) !== host)
    ) {
      continue;
    }

    this_attempt_urls.push(c.source_url);

    // X/Twitter-specific: use oEmbed endpoint (x.com returns 401 to unauthenticated GETs)
    if (isX) {
      const xCheck = await verifyXTweetAvailable(c.source_url, { timeoutMs: 5000 });
      if (!xCheck.ok) {
        console.log(`[grokEnrichment] reviews: X tweet unavailable: ${c.source_url} (${xCheck.reason})`);
        continue;
      }
      verified_reviews.push({
        source_name: "X",
        author: c.author || null,
        source_url: c.source_url,
        title: c.title || null,
        date: c.date || null,
        excerpt: c.excerpt || null,
        link_status: "ok",
        match_confidence: 1.0,
        show_to_users: true,
        is_public: true,
      });
      if (host) usedHosts.add(host);
      continue;
    }

    let verified = await verifyUrlReachable(c.source_url, { timeoutMs: perUrlTimeoutMs });

    // Retry once if first attempt failed (but not soft-404)
    if (!verified.ok && verified.reason !== "soft_404") {
      await sleepMs(400);
      verified = await verifyUrlReachable(c.source_url, { timeoutMs: perUrlTimeoutMs });
    }

    // YouTube-specific: Check if the video is actually available (not deleted/private)
    if (verified.ok && c.category === "youtube") {
      const ytCheck = await verifyYouTubeVideoAvailable(c.source_url, { timeoutMs: 5000 });
      if (!ytCheck.ok) {
        console.log(`[grokEnrichment] reviews: YouTube video unavailable: ${c.source_url} (${ytCheck.reason})`);
        verified = { ok: false, reason: ytCheck.reason || "youtube_unavailable" };
      }
    }

    if (!verified.ok) {
      // Company websites may redirect to CDN/Shopify domains — accept for website testimonials
      if (c.is_website_testimonial && verified.reason === "cross_domain_redirect") {
        console.log(`[grokEnrichment] reviews: cross_domain_redirect accepted for website testimonial: ${c.source_url} → ${verified.final_url}`);
        verified = { ok: true, url: c.source_url, final_url: c.source_url, status: verified.status };
      } else {
        console.log(`[grokEnrichment] reviews: URL failed verification: ${c.source_url} (${verified.reason})`);
        continue;
      }
    }

    // Use Grok-provided metadata; fall back to HTML meta only for missing fields
    const html = typeof verified.html_preview === "string" ? verified.html_preview : "";
    const meta = html ? buildReviewMetadataFromHtml(c.source_url, html) : {};

    verified_reviews.push({
      source_name: isYouTubeUrl(c.source_url) ? "YouTube" : (c.source_name || meta.source_name || null),
      author: c.author || meta.author || null,
      source_url: verified.final_url || c.source_url,
      title: c.title || meta.title || null,
      date: c.date || meta.date || null,
      excerpt: c.excerpt || meta.excerpt || null,
      link_status: "ok",
      match_confidence: c.is_website_testimonial ? 0.5 : 1.0,
      show_to_users: true,
      is_public: true,
      ...(c.is_website_testimonial ? { is_website_testimonial: true } : {}),
    });
    if (host) usedHosts.add(host);
  }

  const curated_reviews = verified_reviews.slice(0, 5);
  const youtubeCount = curated_reviews.filter((r) => isYouTubeUrl(r?.source_url)).length;
  const xCount = curated_reviews.filter((r) => isXUrl(r?.source_url)).length;
  const blogCount = curated_reviews.length - youtubeCount - xCount;

  // Target 3 reviews. 1-2 = incomplete (triggers retry), 3+ = ok (done).
  const ok = curated_reviews.length >= 3;

  if (!ok) {
    const reasonParts = [];
    if (curated_reviews.length === 0) reasonParts.push("no_verified_reviews");
    else reasonParts.push("insufficient_verified_reviews");

    const isExhausted = this_attempt_urls.length >= deduped.length;

    const value = {
      curated_reviews,
      reviews_stage_status: "incomplete",
      incomplete_reason: reasonParts.join(",") || "insufficient_verified_reviews",
      attempted_urls: this_attempt_urls,
      diagnostics: {
        candidate_count: candidates.length,
        verified_count: curated_reviews.length,
        youtube_verified: youtubeCount,
        x_verified: xCount,
        blog_verified: blogCount,
        exhausted: isExhausted,
      },
      search_telemetry: searchBuild.telemetry,
      excluded_hosts: searchBuild.excluded_hosts,
    };
    // Do NOT cache incomplete results — let resume-worker retry get a fresh API call
    logResult("incomplete", `verified=${curated_reviews.length}, candidates=${candidates.length}`);
    return value;
  }

  const value = {
    curated_reviews,
    reviews_stage_status: "ok",
    diagnostics: {
      candidate_count: candidates.length,
      verified_count: curated_reviews.length,
      youtube_verified: youtubeCount,
      x_verified: xCount,
      blog_verified: blogCount,
    },
    attempted_urls: this_attempt_urls,
    search_telemetry: searchBuild.telemetry,
    excluded_hosts: searchBuild.excluded_hosts,
  };
  if (cacheKey) writeStageCache(cacheKey, value);
  logResult("ok", `verified=${curated_reviews.length}, youtube=${youtubeCount}, x=${xCount}, blog=${blogCount}`);
  return value;
}

/** @deprecated v3.0 — subsumed by fetchStructuredFields() Call 1.
 *  Kept exported for backward compat (admin refresh, ENRICHMENT_FIELDS in _directEnrichment.js). */
async function fetchHeadquartersLocation({ companyName, normalizedDomain, budgetMs = 20000, xaiUrl, xaiKey, signal } = {}) {
  const started = Date.now();

  const name = asString(companyName).trim();
  const domain = normalizeDomain(normalizedDomain);

  const cacheKey = domain ? `hq:${domain}` : "";
  const cached = cacheKey ? readStageCache(cacheKey) : null;
  if (cached) {
    return {
      ...cached,
      diagnostics: {
        ...(cached.diagnostics && typeof cached.diagnostics === "object" ? cached.diagnostics : {}),
        cache: "hit",
      },
    };
  }

  const websiteUrlForPrompt = domain ? `https://${domain}` : "";

  const prompt = `${SEARCH_PREAMBLE}
${websiteUrlForPrompt ? `
PRIORITY: Before any web searches, browse these pages of the company website first:
- ${websiteUrlForPrompt}/pages/about-us
- ${websiteUrlForPrompt}/pages/about
- ${websiteUrlForPrompt}/about
- ${websiteUrlForPrompt}/pages/contact
If any of these pages contain headquarters or location information, accept it immediately and return the result. Only proceed to web searches if none of these pages have what you need.
` : ""}
For the company ${name} (${websiteUrlForPrompt || "(unknown website)"}) determine the headquarters location.

Task: Determine the company's HEADQUARTERS location.

Rules:
${FIELD_GUIDANCE.headquarters.rules}
- Output STRICT JSON only.

Return:
${FIELD_GUIDANCE.headquarters.jsonSchemaWithSources}
`.trim();

  const stageTimeout = XAI_STAGE_TIMEOUTS_MS.location;

  // Skip budget check when test stub is active or admin refresh bypass is set
  const hasStub = globalThis && typeof globalThis.__xaiLiveSearchStub === "function";
  const hasAdminBypass = isAdminRefreshBypass();

  const remaining = budgetMs - (Date.now() - started);
  if (!hasStub && !hasAdminBypass) {
    // Use the lower of the ideal stage minimum and the resume-friendly floor.
    // This allows resume cycles (15s budget) to attempt xAI calls instead of
    // immediately deferring. xAI often responds within 5-15s for location queries.
    const minRequired = Math.min(stageTimeout.min + 1_200, RESUME_MIN_BUDGET_MS);
    if (remaining < minRequired) {
      return {
        headquarters_location: "",
        hq_status: "deferred",
        diagnostics: {
          reason: "budget_too_low",
          remaining_ms: Math.max(0, remaining),
          min_required_ms: minRequired,
        },
      };
    }
  }

  const maxTimeoutMs = Math.min(stageTimeout.max, resolveXaiStageTimeoutMaxMs());

  const r = await xaiLiveSearchWithRetry({
    prompt,
    timeoutMs: clampStageTimeoutMs({
      remainingMs: remaining,
      minMs: Math.min(stageTimeout.min, Math.max(2_500, remaining - 1_200)),
      maxMs: maxTimeoutMs,
      safetyMarginMs: 1_200,
      label: "headquarters",
    }),
    maxAttempts: 1, // outer enrichCompanyFields handles retries with budget management
    maxTokens: 400,
    model: resolveSearchModel(),
    xaiUrl,
    xaiKey,
    signal,
    search_parameters: { mode: "on" },
  });

  if (!r.ok) {
    const failure = classifyXaiFailure(r);
    return {
      headquarters_location: "",
      hq_status: failure,
      diagnostics: {
        error: r.error,
        error_code: failure,
        ...(r.diagnostics && typeof r.diagnostics === "object" ? r.diagnostics : {}),
      },
    };
  }

  const out = parseJsonFromXaiResponse(r.resp);

  if (
    !out ||
    typeof out !== "object" ||
    Array.isArray(out) ||
    !Object.prototype.hasOwnProperty.call(out, "headquarters_location")
  ) {
    const rawText = asString(extractTextFromXaiResponse(r.resp));
    return {
      headquarters_location: "",
      hq_status: "invalid_json",
      source_urls: [],
      location_source_urls: { hq_source_urls: [] },
      diagnostics: {
        reason: "missing_headquarters_location_key",
        raw_preview: rawText ? rawText.slice(0, 1200) : null,
      },
    };
  }

  const value = asString(out?.headquarters_location).trim();

  const hq_source_urls_raw = Array.isArray(out?.location_source_urls?.hq_source_urls)
    ? out.location_source_urls.hq_source_urls
    : out?.source_urls;

  const source_urls = Array.isArray(hq_source_urls_raw)
    ? hq_source_urls_raw.map((x) => safeUrl(x)).filter(Boolean).slice(0, 12)
    : [];

  const location_source_urls = { hq_source_urls: source_urls };

  if (!value) {
    const valueOut = { headquarters_location: "", hq_status: "not_found", source_urls, location_source_urls };
    if (cacheKey) writeStageCache(cacheKey, valueOut);
    return valueOut;
  }

  // "Not disclosed" is a terminal sentinel (downstream treats it as complete).
  if (value.toLowerCase() === "not disclosed" || value.toLowerCase() === "not_disclosed") {
    const valueOut = {
      headquarters_location: "Not disclosed",
      hq_status: "not_disclosed",
      source_urls,
      location_source_urls,
    };
    if (cacheKey) writeStageCache(cacheKey, valueOut);
    return valueOut;
  }

  // Infer country from US state or Canadian province abbreviation (e.g., "Chicago, IL" → "Chicago, IL, USA")
  const inferred = inferCountryFromStateAbbreviation(value);
  const hqValue = inferred ? inferred.formatted : normalizeCountryInLocation(value);
  const valueOut = {
    headquarters_location: hqValue,
    hq_status: "ok",
    source_urls,
    location_source_urls,
    ...(inferred ? {
      headquarters_city: inferred.city,
      headquarters_state: inferred.state_code,       // Use abbreviation (TX, not Texas)
      headquarters_state_code: inferred.state_code,  // Explicit abbreviation field
      headquarters_country: inferred.country,
      headquarters_country_code: inferred.country_code,
    } : {}),
  };
  if (cacheKey) writeStageCache(cacheKey, valueOut);
  return valueOut;
}

/** @deprecated v3.0 — subsumed by fetchStructuredFields() Call 1.
 *  Kept exported for backward compat (admin refresh, ENRICHMENT_FIELDS in _directEnrichment.js). */
async function fetchManufacturingLocations({ companyName, normalizedDomain, budgetMs = 20000, xaiUrl, xaiKey, signal } = {}) {
  const started = Date.now();

  const name = asString(companyName).trim();
  const domain = normalizeDomain(normalizedDomain);

  const cacheKey = domain ? `mfg:${domain}` : "";
  const cached = cacheKey ? readStageCache(cacheKey) : null;
  if (cached) {
    return {
      ...cached,
      diagnostics: {
        ...(cached.diagnostics && typeof cached.diagnostics === "object" ? cached.diagnostics : {}),
        cache: "hit",
      },
    };
  }

  const websiteUrlForPrompt = domain ? `https://${domain}` : "";

  const prompt = `${SEARCH_PREAMBLE}
${websiteUrlForPrompt ? `
PRIORITY: Before any web searches, browse these pages of the company website first:
- ${websiteUrlForPrompt}/pages/about-us
- ${websiteUrlForPrompt}/pages/about
- ${websiteUrlForPrompt}/about
- ${websiteUrlForPrompt}/pages/contact
If any of these pages contain manufacturing or production location information (e.g., "Made in...", "sourced and made in..."), accept it immediately and return the result. Only proceed to web searches if none of these pages have what you need.
` : ""}
IMPORTANT: If the company website reveals this is a RETAILER, MARKETPLACE, or RESELLER selling products from multiple other brands — do NOT search for factory addresses. Instead, if the site states a sourcing country (e.g., "America's Best Craft Jerky", "Made in USA"), return that country: {"manufacturing_locations": [{"city": "", "state": "", "country": "USA"}], "mfg_status": "ok", "location_source_urls": {"mfg_source_urls": ["<url>"]}}.
If no sourcing country is stated, return {"manufacturing_locations": [], "mfg_status": "not_applicable", "location_source_urls": {"mfg_source_urls": []}}.

SMALL / ARTISAN PRODUCERS: If the company is a small-batch, artisan, or craft producer and no separate manufacturing facility is mentioned anywhere on the website, the headquarters address IS the manufacturing location. Return the HQ address as the manufacturing location rather than spending time searching for a separate factory that does not exist.

For the company ${name} (${websiteUrlForPrompt || "(unknown website)"}) determine the manufacturing locations.

Task: Identify ALL known MANUFACTURING locations for this company worldwide.

Rules:
${FIELD_GUIDANCE.manufacturing.rules}
- Output STRICT JSON only.

Return:
${FIELD_GUIDANCE.manufacturing.jsonSchemaWithSources}
`.trim();

  const stageTimeout = XAI_STAGE_TIMEOUTS_MS.location;

  // Skip budget check when test stub is active or admin refresh bypass is set
  const hasStub = globalThis && typeof globalThis.__xaiLiveSearchStub === "function";
  const hasAdminBypass = isAdminRefreshBypass();

  const remaining = budgetMs - (Date.now() - started);
  if (!hasStub && !hasAdminBypass) {
    // Use the lower of the ideal stage minimum and the resume-friendly floor.
    // This allows resume cycles (15s budget) to attempt xAI calls instead of
    // immediately deferring. xAI often responds within 5-15s for location queries.
    const minRequired = Math.min(stageTimeout.min + 1_200, RESUME_MIN_BUDGET_MS);
    if (remaining < minRequired) {
      return {
        manufacturing_locations: [],
        mfg_status: "deferred",
        diagnostics: {
          reason: "budget_too_low",
          remaining_ms: Math.max(0, remaining),
          min_required_ms: minRequired,
        },
      };
    }
  }

  const maxTimeoutMs = Math.min(stageTimeout.max, resolveXaiStageTimeoutMaxMs());

  const r = await xaiLiveSearchWithRetry({
    prompt,
    timeoutMs: clampStageTimeoutMs({
      remainingMs: remaining,
      minMs: Math.min(stageTimeout.min, Math.max(2_500, remaining - 1_200)),
      maxMs: maxTimeoutMs,
      safetyMarginMs: 1_200,
      label: "manufacturing",
    }),
    maxAttempts: 1, // outer enrichCompanyFields handles retries with budget management
    maxTokens: 500,
    model: resolveSearchModel(),
    xaiUrl,
    xaiKey,
    signal,
    search_parameters: { mode: "on" },
  });

  if (!r.ok) {
    const failure = classifyXaiFailure(r);
    return {
      manufacturing_locations: [],
      mfg_status: failure,
      diagnostics: {
        error: r.error,
        error_code: failure,
        ...(r.diagnostics && typeof r.diagnostics === "object" ? r.diagnostics : {}),
        resp: r.resp,
      },
    };
  }

  const out = parseJsonFromXaiResponse(r.resp);

  if (
    !out ||
    typeof out !== "object" ||
    Array.isArray(out) ||
    !Object.prototype.hasOwnProperty.call(out, "manufacturing_locations")
  ) {
    const rawText = asString(extractTextFromXaiResponse(r.resp));
    return {
      manufacturing_locations: [],
      mfg_status: "invalid_json",
      source_urls: [],
      location_source_urls: { mfg_source_urls: [] },
      diagnostics: {
        reason: "missing_manufacturing_locations_key",
        raw_preview: rawText ? rawText.slice(0, 1200) : null,
      },
    };
  }

  const mfg_source_urls_raw = Array.isArray(out?.location_source_urls?.mfg_source_urls)
    ? out.location_source_urls.mfg_source_urls
    : out?.source_urls;

  const source_urls = Array.isArray(mfg_source_urls_raw)
    ? mfg_source_urls_raw.map((x) => safeUrl(x)).filter(Boolean).slice(0, 12)
    : [];

  const location_source_urls = { mfg_source_urls: source_urls };

  const arr = Array.isArray(out?.manufacturing_locations) ? out.manufacturing_locations : [];
  const cleaned = arr
    .map((x) => asString(x).trim())
    .filter(Boolean)
    .map(normalizeLocationWithStateAbbrev)  // Normalize state names to abbreviations
    .map(normalizeCountryInLocation);       // Normalize "United States" → "USA"

  // Detect explicit "not_applicable" signal from Grok (retailer/marketplace, not a manufacturer)
  const grokMfgStatus = asString(out?.mfg_status).trim().toLowerCase();
  if (cleaned.length === 0 && grokMfgStatus === "not_applicable") {
    const valueOut = { manufacturing_locations: [], mfg_status: "not_applicable", source_urls, location_source_urls };
    if (cacheKey) writeStageCache(cacheKey, valueOut);
    return valueOut;
  }

  if (cleaned.length === 0) {
    const valueOut = { manufacturing_locations: [], mfg_status: "not_found", source_urls, location_source_urls };
    if (cacheKey) writeStageCache(cacheKey, valueOut);
    return valueOut;
  }

  if (cleaned.length === 1 && cleaned[0].toLowerCase().includes("not disclosed")) {
    const valueOut = {
      manufacturing_locations: ["Not disclosed"],
      mfg_status: "not_disclosed",
      source_urls,
      location_source_urls,
    };
    if (cacheKey) writeStageCache(cacheKey, valueOut);
    return valueOut;
  }

  const valueOut = { manufacturing_locations: cleaned, mfg_status: "ok", source_urls, location_source_urls };
  if (cacheKey) writeStageCache(cacheKey, valueOut);
  return valueOut;
}

/** @deprecated v3.0 — subsumed by fetchStructuredFields() Call 1.
 *  Kept exported for backward compat (admin refresh, ENRICHMENT_FIELDS in _directEnrichment.js). */
async function fetchTagline({
  companyName,
  normalizedDomain,
  budgetMs = 12000,
  xaiUrl,
  xaiKey,
  model = process.env.XAI_SEARCH_MODEL || process.env.XAI_CHAT_MODEL || process.env.XAI_MODEL || "grok-4-latest",
} = {}) {
  const started = Date.now();

  const name = asString(companyName).trim();
  const domain = normalizeDomain(normalizedDomain);

  const cacheKey = domain ? `tagline:${domain}` : "";
  const cached = cacheKey ? readStageCache(cacheKey) : null;
  if (cached) {
    return {
      ...cached,
      diagnostics: {
        ...(cached.diagnostics && typeof cached.diagnostics === "object" ? cached.diagnostics : {}),
        cache: "hit",
      },
    };
  }

  const websiteUrlForPrompt = domain ? `https://${domain}` : "";

  const prompt = `${SEARCH_PREAMBLE}

For the company ${name} (${websiteUrlForPrompt || "(unknown website)"}) provide the tagline.

Task: Provide the company's official tagline or slogan.

Rules:
${FIELD_GUIDANCE.tagline.rules}
- Output STRICT JSON only.

Return:
{ ${FIELD_GUIDANCE.tagline.jsonSchema} }
`.trim();

  const stageTimeout = XAI_STAGE_TIMEOUTS_MS.light;

  // Skip budget check when test stub is active or admin refresh bypass is set
  const hasStub = globalThis && typeof globalThis.__xaiLiveSearchStub === "function";
  const hasAdminBypass = isAdminRefreshBypass();

  const remaining = budgetMs - (Date.now() - started);
  if (!hasStub && !hasAdminBypass) {
    const minRequired = Math.min(stageTimeout.min + 1_200, RESUME_MIN_BUDGET_MS);
    if (remaining < minRequired) {
      return {
        tagline: "",
        tagline_status: "deferred",
        diagnostics: {
          reason: "budget_too_low",
          remaining_ms: Math.max(0, remaining),
          min_required_ms: minRequired,
        },
      };
    }
  }

  const maxTimeoutMs = Math.min(stageTimeout.max, resolveXaiStageTimeoutMaxMs());

  const r = await xaiLiveSearchWithRetry({
    prompt,
    timeoutMs: clampStageTimeoutMs({
      remainingMs: remaining,
      minMs: Math.min(stageTimeout.min, Math.max(2_500, remaining - 1_200)),
      maxMs: maxTimeoutMs,
      safetyMarginMs: 1_200,
      label: "tagline",
    }),
    maxTokens: 180,
    model: resolveSearchModel(model),
    xaiUrl,
    xaiKey,
    search_parameters: { mode: "on" },
  });

  if (!r.ok) {
    const failure = classifyXaiFailure(r);
    return {
      tagline: "",
      tagline_status: failure,
      diagnostics: {
        error: r.error,
        error_code: failure,
        ...(r.diagnostics && typeof r.diagnostics === "object" ? r.diagnostics : {}),
        resp: r.resp,
      },
    };
  }

  const out = parseJsonFromXaiResponse(r.resp);

  if (
    !out ||
    typeof out !== "object" ||
    Array.isArray(out) ||
    (!Object.prototype.hasOwnProperty.call(out, "tagline") &&
      !Object.prototype.hasOwnProperty.call(out, "slogan"))
  ) {
    const rawText = asString(extractTextFromXaiResponse(r.resp));
    return {
      tagline: "",
      tagline_status: "invalid_json",
      diagnostics: {
        reason: "missing_tagline_key",
        raw_preview: rawText ? rawText.slice(0, 1200) : null,
      },
    };
  }

  const tagline = asString(out?.tagline || out?.slogan || "").trim();

  if (!tagline || /^(unknown|n\/a|not disclosed)$/i.test(tagline)) {
    const valueOut = { tagline: "", tagline_status: "not_found" };
    if (cacheKey) writeStageCache(cacheKey, valueOut);
    return valueOut;
  }

  const valueOut = { tagline, tagline_status: "ok" };
  if (cacheKey) writeStageCache(cacheKey, valueOut);
  return valueOut;
}

/** @deprecated v3.0 — subsumed by fetchStructuredFields() Call 1.
 *  Kept exported for backward compat (admin refresh, ENRICHMENT_FIELDS in _directEnrichment.js). */
async function fetchIndustries({
  companyName,
  normalizedDomain,
  budgetMs = 15000,
  xaiUrl,
  xaiKey,
  model = process.env.XAI_SEARCH_MODEL || process.env.XAI_CHAT_MODEL || process.env.XAI_MODEL || "grok-4-latest",
} = {}) {
  const started = Date.now();

  const name = asString(companyName).trim();
  const domain = normalizeDomain(normalizedDomain);

  const cacheKey = domain ? `industries:${domain}` : "";
  const cached = cacheKey ? readStageCache(cacheKey) : null;
  if (cached) {
    return {
      ...cached,
      diagnostics: {
        ...(cached.diagnostics && typeof cached.diagnostics === "object" ? cached.diagnostics : {}),
        cache: "hit",
      },
    };
  }

  const websiteUrlForPrompt = domain ? `https://${domain}` : "";

  const prompt = `${SEARCH_PREAMBLE}

For the company ${name} (${websiteUrlForPrompt || "(unknown website)"}) identify the industries.

Task: Identify the company's industries.

Rules:
${FIELD_GUIDANCE.industries.rules}
- Output STRICT JSON only.

Return:
{ ${FIELD_GUIDANCE.industries.jsonSchema} }
`.trim();

  const stageTimeout = XAI_STAGE_TIMEOUTS_MS.light;

  // Skip budget check when test stub is active or admin refresh bypass is set
  const hasStub = globalThis && typeof globalThis.__xaiLiveSearchStub === "function";
  const hasAdminBypass = isAdminRefreshBypass();

  const remaining = budgetMs - (Date.now() - started);
  if (!hasStub && !hasAdminBypass) {
    const minRequired = Math.min(stageTimeout.min + 1_200, RESUME_MIN_BUDGET_MS);
    if (remaining < minRequired) {
      return {
        industries: [],
        industries_status: "deferred",
        diagnostics: {
          reason: "budget_too_low",
          remaining_ms: Math.max(0, remaining),
          min_required_ms: minRequired,
        },
      };
    }
  }

  const maxTimeoutMs = Math.min(stageTimeout.max, resolveXaiStageTimeoutMaxMs());

  const r = await xaiLiveSearchWithRetry({
    prompt,
    timeoutMs: clampStageTimeoutMs({
      remainingMs: remaining,
      minMs: Math.min(stageTimeout.min, Math.max(2_500, remaining - 1_200)),
      maxMs: maxTimeoutMs,
      safetyMarginMs: 1_200,
      label: "industries",
    }),
    maxTokens: 220,
    model: resolveSearchModel(model),
    xaiUrl,
    xaiKey,
    search_parameters: { mode: "on" },
  });

  if (!r.ok) {
    const failure = classifyXaiFailure(r);
    return {
      industries: [],
      industries_status: failure,
      diagnostics: {
        error: r.error,
        error_code: failure,
        ...(r.diagnostics && typeof r.diagnostics === "object" ? r.diagnostics : {}),
        resp: r.resp,
      },
    };
  }

  const out = parseJsonFromXaiResponse(r.resp);

  if (!out || typeof out !== "object" || Array.isArray(out) || !Object.prototype.hasOwnProperty.call(out, "industries")) {
    const rawText = asString(extractTextFromXaiResponse(r.resp));
    return {
      industries: [],
      industries_status: "invalid_json",
      diagnostics: {
        reason: "missing_industries_key",
        raw_preview: rawText ? rawText.slice(0, 1200) : null,
      },
    };
  }

  const list = Array.isArray(out?.industries) ? out.industries : [];
  const cleaned = list.map((x) => asString(x).trim()).filter(Boolean);
  if (cleaned.length === 0) {
    const valueOut = { industries: [], industries_status: "not_found" };
    if (cacheKey) writeStageCache(cacheKey, valueOut);
    return valueOut;
  }

  const valueOut = { industries: cleaned.slice(0, 3), industries_status: "ok" };
  if (cacheKey) writeStageCache(cacheKey, valueOut);
  return valueOut;
}

/** @deprecated v3.0 — subsumed by fetchStructuredFields() Call 1.
 *  Kept exported for backward compat (admin refresh, ENRICHMENT_FIELDS in _directEnrichment.js). */
async function fetchProductKeywords({
  companyName,
  normalizedDomain,
  budgetMs = 15000,
  xaiUrl,
  xaiKey,
  model = process.env.XAI_SEARCH_MODEL || process.env.XAI_CHAT_MODEL || process.env.XAI_MODEL || "grok-4-latest",
} = {}) {
  const started = Date.now();

  const name = asString(companyName).trim();
  const domain = normalizeDomain(normalizedDomain);

  const cacheKey = domain ? `products:${domain}` : "";
  const cached = cacheKey ? readStageCache(cacheKey) : null;
  if (cached) {
    return {
      ...cached,
      diagnostics: {
        ...(cached.diagnostics && typeof cached.diagnostics === "object" ? cached.diagnostics : {}),
        cache: "hit",
      },
    };
  }

  const websiteUrlForPrompt = domain ? `https://${domain}` : "";

  const prompt = `${SEARCH_PREAMBLE}

For the company ${name} (${websiteUrlForPrompt || "(unknown website)"}) provide the product keywords.

Task: Provide an EXHAUSTIVE, COMPLETE, and ALL-INCLUSIVE list of ALL PRODUCTS this company sells.

Hard rules:
${FIELD_GUIDANCE.keywords.rules}
- Output STRICT JSON only.

Return:
${FIELD_GUIDANCE.keywords.jsonSchemaWithCompleteness}
`.trim();

  // Use keywords-specific timeout (2x light) since keywords must accumulate all products
  const stageTimeout = XAI_STAGE_TIMEOUTS_MS.keywords;

  // Skip budget check when test stub is active or admin refresh bypass is set
  const hasStub = globalThis && typeof globalThis.__xaiLiveSearchStub === "function";
  const hasAdminBypass = isAdminRefreshBypass();

  const remaining = budgetMs - (Date.now() - started);
  if (!hasStub && !hasAdminBypass) {
    const minRequired = Math.min(stageTimeout.min + 1_200, RESUME_MIN_BUDGET_MS);
    if (remaining < minRequired) {
      return {
        keywords: [],
        keywords_status: "deferred",
        diagnostics: {
          reason: "budget_too_low",
          remaining_ms: Math.max(0, remaining),
          min_required_ms: minRequired,
        },
      };
    }
  }

  const maxTimeoutMs = Math.min(stageTimeout.max, resolveXaiStageTimeoutMaxMs());

  const r = await xaiLiveSearchWithRetry({
    prompt,
    timeoutMs: clampStageTimeoutMs({
      remainingMs: remaining,
      minMs: Math.min(stageTimeout.min, Math.max(2_500, remaining - 1_200)),
      maxMs: maxTimeoutMs,
      safetyMarginMs: 1_200,
      label: "product_keywords",
    }),
    maxTokens: 2400,  // Large budget for exhaustive product catalogs with variants
    model: resolveSearchModel(model),
    xaiUrl,
    xaiKey,
    search_parameters: { mode: "on" },
  });

  if (!r.ok) {
    const failure = classifyXaiFailure(r);
    return {
      keywords: [],
      keywords_status: failure,
      diagnostics: {
        error: r.error,
        error_code: failure,
        ...(r.diagnostics && typeof r.diagnostics === "object" ? r.diagnostics : {}),
        resp: r.resp,
      },
    };
  }

  const out = parseJsonFromXaiResponse(r.resp);

  if (!out || typeof out !== "object" || Array.isArray(out) || !Object.prototype.hasOwnProperty.call(out, "completeness")) {
    const rawText = asString(extractTextFromXaiResponse(r.resp));
    return {
      product_keywords: [],
      keywords: [],
      keywords_status: "invalid_json",
      diagnostics: {
        reason: "missing_completeness_key",
        raw_preview: rawText ? rawText.slice(0, 1200) : null,
      },
    };
  }

  const hasProductKeywordsKey = Object.prototype.hasOwnProperty.call(out, "product_keywords");
  const hasKeywordsKey = Object.prototype.hasOwnProperty.call(out, "keywords");

  if (!hasProductKeywordsKey && !hasKeywordsKey) {
    const rawText = asString(extractTextFromXaiResponse(r.resp));
    return {
      product_keywords: [],
      keywords: [],
      keywords_status: "invalid_json",
      diagnostics: {
        reason: "missing_product_keywords_key",
        raw_preview: rawText ? rawText.slice(0, 1200) : null,
      },
    };
  }

  const list = Array.isArray(out?.product_keywords)
    ? out.product_keywords
    : Array.isArray(out?.keywords)
      ? out.keywords
      : [];

  const cleaned = list.map((x) => asString(x).trim()).filter(Boolean);
  const deduped = Array.from(new Set(cleaned));

  if (deduped.length === 0) {
    const valueOut = { product_keywords: [], keywords: [], keywords_status: "not_found" };
    if (cacheKey) writeStageCache(cacheKey, valueOut);
    return valueOut;
  }

  const completenessRaw = asString(out?.completeness).trim().toLowerCase();
  const completeness = completenessRaw === "incomplete" ? "incomplete" : "complete";
  const incomplete_reason = completeness === "incomplete" ? (asString(out?.incomplete_reason).trim() || null) : null;

  const valueOut = {
    product_keywords: deduped,
    keywords: deduped,
    keywords_status: completeness === "incomplete" ? "incomplete" : "ok",
    keywords_completeness: completeness,
    keywords_incomplete_reason: incomplete_reason,
  };
  if (cacheKey) writeStageCache(cacheKey, valueOut);
  return valueOut;
}

/**
 * Grok-based logo detection fallback when HTML parsing fails to find a logo.
 * Uses AI to identify the company's official logo URL from the website.
 * @deprecated v3.0 — logo_url is now fetched as part of fetchStructuredFields() Call 1.
 *  This standalone fetcher is kept for backward compat (admin refresh, _logoImport.js fallback).
 */
async function fetchLogo({
  companyName,
  normalizedDomain,
  budgetMs = 15000,
  xaiUrl,
  xaiKey,
  model = process.env.XAI_SEARCH_MODEL || process.env.XAI_CHAT_MODEL || process.env.XAI_MODEL || "grok-4-latest",
} = {}) {
  const started = Date.now();

  const name = asString(companyName).trim();
  const domain = normalizeDomain(normalizedDomain);

  const cacheKey = domain ? `logo:${domain}` : "";
  const cached = cacheKey ? readStageCache(cacheKey) : null;
  if (cached) {
    return {
      ...cached,
      diagnostics: {
        ...(cached.diagnostics && typeof cached.diagnostics === "object" ? cached.diagnostics : {}),
        cache: "hit",
      },
    };
  }

  const websiteUrlForPrompt = domain ? `https://${domain}` : "";

  const prompt = `${SEARCH_PREAMBLE}

For the company ${name} (${websiteUrlForPrompt || "(unknown website)"}) find the company logo.

Task: Find this company's official logo.

Step 1: Browse ${websiteUrlForPrompt || "the company website"} and look for the logo in the header, navigation, or footer.

Step 2: Determine the logo format:
- If the logo is a separate image file (PNG, SVG, JPG, WebP), return its direct URL in logo_url
- If the logo is an inline <svg> element embedded in the HTML (no separate image file URL), extract the full SVG markup and return it in svg_code
  - If the SVG uses <use href="#id"> or <use xlink:href="#id">, find the referenced <symbol> or <svg> element and inline its contents to produce a self-contained SVG
  - Strip any CSS class attributes that reference external stylesheets

Requirements:
- The logo must be the company's official brand logo or wordmark
- Do NOT return favicon.ico or generic placeholder images
- Do NOT return product images, hero banners, or promotional graphics
- If multiple logo variants exist, prefer the main/primary version
- Verify the URL actually returns an image (if providing a URL)

Output STRICT JSON only:
{
  "logo_url": "https://..." | null,
  "svg_code": "<svg ...>...</svg>" | null,
  "logo_source": "header" | "nav" | "footer" | "about" | "meta" | "schema" | null,
  "confidence": "high" | "medium" | "low"
}

Return logo_url if a direct image URL exists. Return svg_code ONLY when the logo is an inline SVG with no separate image URL. Never return both.`.trim();

  const stageTimeout = XAI_STAGE_TIMEOUTS_MS.light;

  // Skip budget check when test stub is active or admin refresh bypass is set
  const hasStub = globalThis && typeof globalThis.__xaiLiveSearchStub === "function";
  const hasAdminBypass = isAdminRefreshBypass();

  const remaining = budgetMs - (Date.now() - started);
  if (!hasStub && !hasAdminBypass) {
    const minRequired = Math.min(stageTimeout.min + 1_200, RESUME_MIN_BUDGET_MS);
    if (remaining < minRequired) {
      return {
        logo_url: null,
        logo_status: "deferred",
        diagnostics: {
          reason: "budget_too_low",
          remaining_ms: Math.max(0, remaining),
          min_required_ms: minRequired,
        },
      };
    }
  }

  const maxTimeoutMs = Math.min(stageTimeout.max, resolveXaiStageTimeoutMaxMs());

  const r = await xaiLiveSearchWithRetry({
    prompt,
    timeoutMs: clampStageTimeoutMs({
      remainingMs: remaining,
      minMs: Math.min(stageTimeout.min, Math.max(2_500, remaining - 1_200)),
      maxMs: maxTimeoutMs,
      safetyMarginMs: 1_200,
      label: "logo",
    }),
    maxTokens: 2000,
    model: resolveSearchModel(model),
    xaiUrl,
    xaiKey,
    search_parameters: { mode: "on" },
  });

  if (!r.ok) {
    const failure = classifyXaiFailure(r);
    return {
      logo_url: null,
      logo_status: failure,
      diagnostics: {
        error: r.error,
        error_code: failure,
        ...(r.diagnostics && typeof r.diagnostics === "object" ? r.diagnostics : {}),
      },
    };
  }

  const out = parseJsonFromXaiResponse(r.resp);

  if (!out || typeof out !== "object" || Array.isArray(out)) {
    const rawText = asString(extractTextFromXaiResponse(r.resp));
    return {
      logo_url: null,
      logo_status: "invalid_json",
      diagnostics: {
        reason: "invalid_json_response",
        raw_preview: rawText ? rawText.slice(0, 600) : null,
      },
    };
  }

  const logoUrl = asString(out?.logo_url).trim() || null;
  const svgCode = asString(out?.svg_code).trim() || null;
  const logoSource = asString(out?.logo_source).trim().toLowerCase() || null;
  const confidence = asString(out?.confidence).trim().toLowerCase() || "low";

  // Handle inline SVG code when Grok found no separate image URL
  if (!logoUrl && svgCode) {
    if (!svgCode.startsWith("<svg") || !svgCode.includes("</svg>")) {
      const valueOut = {
        logo_url: null,
        logo_status: "invalid_svg",
        diagnostics: { reason: "svg_code_malformed", preview: svgCode.slice(0, 200) },
      };
      if (cacheKey) writeStageCache(cacheKey, valueOut);
      return valueOut;
    }

    const svgBuf = Buffer.from(svgCode, "utf8");

    // Reuse safety check from _logoImport.js
    const { looksLikeUnsafeSvg } = require("./_logoImport");
    if (looksLikeUnsafeSvg(svgBuf)) {
      const valueOut = {
        logo_url: null,
        logo_status: "unsafe_svg",
        diagnostics: { reason: "svg_code_unsafe" },
      };
      if (cacheKey) writeStageCache(cacheKey, valueOut);
      return valueOut;
    }

    // Return buffer for the caller to upload to blob storage
    return {
      logo_url: null,
      logo_svg_buffer: svgBuf,
      logo_source: logoSource,
      logo_confidence: confidence,
      logo_status: "ok_svg",
    };
  }

  if (!logoUrl) {
    const valueOut = {
      logo_url: null,
      logo_status: "not_found",
      logo_source: null,
      logo_confidence: null,
    };
    if (cacheKey) writeStageCache(cacheKey, valueOut);
    return valueOut;
  }

  // Basic URL validation
  const validUrl = safeUrl(logoUrl);
  if (!validUrl) {
    const valueOut = {
      logo_url: null,
      logo_status: "invalid_url",
      diagnostics: { raw_url: logoUrl },
    };
    if (cacheKey) writeStageCache(cacheKey, valueOut);
    return valueOut;
  }

  // HTTP validation: verify the URL actually serves an image (not a 404 or HTML page).
  // Grok frequently returns stale or hallucinated URLs, especially after site migrations.
  try {
    const headRes = await fetchWithTimeout(validUrl, { method: "HEAD", timeoutMs: 5000, headers: { "User-Agent": "Mozilla/5.0" } });
    const httpStatus = Number(headRes.status || 0) || 0;
    const ct = asString(headRes.headers?.get ? headRes.headers.get("content-type") : "").toLowerCase();
    const isImage = ct.startsWith("image/") || ct.includes("svg");

    if (httpStatus === 404 || httpStatus === 403 || httpStatus === 410) {
      console.log(`[fetchLogo] Logo URL returned HTTP ${httpStatus}: ${validUrl}`);
      const valueOut = {
        logo_url: null,
        logo_status: "url_dead",
        diagnostics: { url: validUrl, http_status: httpStatus, content_type: ct },
      };
      if (cacheKey) writeStageCache(cacheKey, valueOut);
      return valueOut;
    }

    if (httpStatus >= 200 && httpStatus < 300 && !isImage) {
      // URL returns 200 but not an image (e.g., HTML error page)
      console.log(`[fetchLogo] Logo URL returns non-image content-type "${ct}": ${validUrl}`);
      const valueOut = {
        logo_url: null,
        logo_status: "not_image",
        diagnostics: { url: validUrl, http_status: httpStatus, content_type: ct },
      };
      if (cacheKey) writeStageCache(cacheKey, valueOut);
      return valueOut;
    }
  } catch (e) {
    // If HEAD fails (some servers block it), try GET with range to minimize transfer
    try {
      const getRes = await fetchWithTimeout(validUrl, {
        method: "GET",
        timeoutMs: 5000,
        headers: { "User-Agent": "Mozilla/5.0", Range: "bytes=0-0" },
      });
      const httpStatus = Number(getRes.status || 0) || 0;
      if (httpStatus === 404 || httpStatus === 403 || httpStatus === 410) {
        console.log(`[fetchLogo] Logo URL GET returned HTTP ${httpStatus}: ${validUrl}`);
        const valueOut = {
          logo_url: null,
          logo_status: "url_dead",
          diagnostics: { url: validUrl, http_status: httpStatus, method: "GET_fallback" },
        };
        if (cacheKey) writeStageCache(cacheKey, valueOut);
        return valueOut;
      }
    } catch {
      // Both HEAD and GET failed — URL is likely unreachable
      console.log(`[fetchLogo] Logo URL unreachable: ${validUrl} (${e?.message || "unknown"})`);
      const valueOut = {
        logo_url: null,
        logo_status: "url_unreachable",
        diagnostics: { url: validUrl, error: e?.message || String(e) },
      };
      if (cacheKey) writeStageCache(cacheKey, valueOut);
      return valueOut;
    }
  }

  const valueOut = {
    logo_url: validUrl,
    logo_status: "ok",
    logo_source: logoSource,
    logo_confidence: confidence,
  };
  if (cacheKey) writeStageCache(cacheKey, valueOut);
  return valueOut;
}

// ============================================================================
// UNIFIED ENRICHMENT: Single Grok prompt for all fields (mirrors manual query)
// ============================================================================

/**
 * Fetch all company fields in a single Grok call.
 * This mirrors the manual Grok prompt that produces accurate results.
 * Returns raw response text + parsed fields for transparency/debugging.
 */
/** @deprecated v3.0 — replaced by fetchStructuredFields() in the two-call split pipeline.
 *  Kept exported for backward compat (admin refresh, resume-worker legacy path). */
async function fetchAllFieldsUnified({
  companyName,
  websiteUrl,
  normalizedDomain,
  budgetMs = 300000,
  xaiUrl,
  xaiKey,
  model,
} = {}) {
  const started = Date.now();

  const name = asString(companyName).trim();
  const domain = normalizeDomain(normalizedDomain || websiteUrl);
  const websiteUrlForPrompt = websiteUrl
    ? asString(websiteUrl).trim()
    : domain
      ? `https://${domain}`
      : "";

  const prompt = `${SEARCH_PREAMBLE}

For the company ${name} (${websiteUrlForPrompt || "(unknown website)"}) please provide their tagline, HQ, manufacturing, industries, keywords (products), and reviews.

LOCATIONS: ${FIELD_SUMMARIES.locations}

INDUSTRIES: ${FIELD_SUMMARIES.industries}

KEYWORDS: ${FIELD_SUMMARIES.keywords}

REVIEWS: ${FIELD_GUIDANCE.reviews.rulesCompact(name, websiteUrlForPrompt)} Fields: "source_name", "author", "source_url" (direct URL, not homepage), "title", "date", "excerpt".

Return STRICT JSON only:
{
  ${FIELD_GUIDANCE.tagline.jsonSchema},
  ${FIELD_GUIDANCE.headquarters.jsonSchema},
  ${FIELD_GUIDANCE.manufacturing.jsonSchema},
  ${FIELD_GUIDANCE.industries.jsonSchema},
  ${FIELD_GUIDANCE.keywords.jsonSchemaArray},
  ${FIELD_GUIDANCE.reviews.jsonSchemaRich},
  "location_source_urls": { "hq_source_urls": ["https://..."], "mfg_source_urls": ["https://..."] }
}`.trim();

  const searchBuild = buildSearchParameters({ companyWebsiteHost: domain });

  const r = await xaiLiveSearchWithRetry({
    prompt,
    timeoutMs: clampStageTimeoutMs({
      remainingMs: budgetMs,
      minMs: 30_000,
      maxMs: 120_000,
      safetyMarginMs: 5_000,
      label: "unified",
    }),
    maxAttempts: 1, // No retry — retrying doubles Phase 1 (110s×2=220s)
    maxTokens: 4000,
    model: resolveSearchModel(model),
    xaiUrl,
    xaiKey,
    search_parameters: {
      ...searchBuild.search_parameters,
      excluded_domains: searchBuild.excluded_domains,
    },
    useTools: true,
  });

  const elapsedMs = Date.now() - started;

  if (!r.ok) {
    const failure = classifyXaiFailure(r);
    return {
      ok: false,
      method: "unified",
      raw_response_text: "",
      parsed_fields: null,
      field_statuses: {},
      error: r.error,
      error_code: failure,
      elapsed_ms: elapsedMs,
      diagnostics: {
        ...(r.diagnostics && typeof r.diagnostics === "object" ? r.diagnostics : {}),
      },
    };
  }

  const rawText = asString(extractTextFromXaiResponse(r.resp));
  console.log(`[fetchAllFieldsUnified] Raw response (${rawText.length} chars): ${rawText.slice(0, 500)}${rawText.length > 500 ? "..." : ""}`);
  const parsedRaw = parseJsonFromXaiResponse(r.resp);
  if (Array.isArray(parsedRaw)) {
    console.log(`[fetchAllFieldsUnified] Merged array response (${parsedRaw.length} elements) into single object`);
  }
  const parsed = mergeArrayResponse(parsedRaw);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.log(`[fetchAllFieldsUnified] Failed to parse JSON from response`);

    return {
      ok: false,
      method: "unified",
      raw_response_text: rawText,
      parsed_fields: null,
      field_statuses: {},
      error: "invalid_json",
      elapsed_ms: elapsedMs,
      diagnostics: {
        reason: "could_not_parse_unified_response",
        raw_preview: rawText ? rawText.slice(0, 2000) : null,
      },
    };
  }

  // Extract and normalize each field from the unified response
  const field_statuses = {};

  const tagline = asString(parsed.tagline || parsed.slogan || "").trim();
  field_statuses.tagline = tagline ? "ok" : "empty";

  // Unwrap nested object — XAI sometimes wraps in { headquarters: { headquarters_location: "..." } }
  let hq_val_r = parsed.headquarters_location || parsed.hq || parsed.headquarters?.headquarters_location || "";
  if (hq_val_r && typeof hq_val_r === "object" && !Array.isArray(hq_val_r)) {
    hq_val_r = hq_val_r.headquarters_location || hq_val_r.hq || hq_val_r.location || "";
  }
  const hq_raw = asString(hq_val_r).trim();
  const hq_normalized = hq_raw ? normalizeCountryInLocation(normalizeLocationWithStateAbbrev(hq_raw)) : "";
  field_statuses.headquarters = hq_normalized ? "ok" : "empty";

  // Unwrap nested object — XAI sometimes wraps in { manufacturing: { manufacturing_locations: [...] } }
  let mfg_val_r = parsed.manufacturing_locations || parsed.manufacturing?.manufacturing_locations;
  if (mfg_val_r && typeof mfg_val_r === "object" && !Array.isArray(mfg_val_r) && Array.isArray(mfg_val_r.manufacturing_locations)) {
    mfg_val_r = mfg_val_r.manufacturing_locations;
  }
  const mfg_raw = Array.isArray(mfg_val_r) ? mfg_val_r : [];
  const mfg_cleaned = mfg_raw
    .map((x) => asString(x).trim())
    .filter(Boolean)
    .map(normalizeLocationWithStateAbbrev)
    .map(normalizeCountryInLocation);
  field_statuses.manufacturing = mfg_cleaned.length > 0 ? "ok" : "empty";

  // Unwrap nested object — XAI sometimes returns { industries: { industries: [...] } }
  let industries_val_r = parsed.industries;
  if (industries_val_r && typeof industries_val_r === "object" && !Array.isArray(industries_val_r) && Array.isArray(industries_val_r.industries)) {
    industries_val_r = industries_val_r.industries;
  }
  const industries_raw = Array.isArray(industries_val_r) ? industries_val_r : [];
  const industries_cleaned = industries_raw.map((x) => asString(x).trim()).filter(Boolean).slice(0, 3);
  field_statuses.industries = industries_cleaned.length > 0 ? "ok" : "empty";

  // Unwrap nested object — XAI sometimes returns { product_keywords: { product_keywords: [...] } }
  let kw_val_r = parsed.product_keywords || parsed.keywords;
  if (kw_val_r && typeof kw_val_r === "object" && !Array.isArray(kw_val_r)) {
    kw_val_r = kw_val_r.product_keywords || kw_val_r.keywords || kw_val_r;
  }
  const kw_raw = Array.isArray(kw_val_r) ? kw_val_r : [];
  const kw_cleaned = Array.from(new Set(kw_raw.map((x) => asString(x).trim()).filter(Boolean)));
  field_statuses.keywords = kw_cleaned.length > 0 ? "ok" : "empty";

  const reviews_raw = Array.isArray(parsed.reviews) ? parsed.reviews : [];
  const reviews_cleaned = reviews_raw
    .filter((x) => x && typeof x === "object")
    .map((x) => ({
      source_name: asString(x.source_name || "").trim() || null,
      author: asString(x.author || "").trim() || null,
      source_url: safeUrl(x.source_url || x.url || x.link || ""),
      title: asString(x.title || "").trim() || null,
      date: asString(x.date || "").trim() || null,
      excerpt: asString(x.excerpt || "").trim() || null,
    }))
    .filter((x) => x.source_url);
  field_statuses.reviews = reviews_cleaned.length > 0 ? "ok" : "empty";

  const parsed_fields = {
    tagline,
    headquarters_location: hq_normalized,
    manufacturing_locations: mfg_cleaned,
    industries: industries_cleaned,
    product_keywords: kw_cleaned,
    reviews: reviews_cleaned,
  };

  // Infer HQ country
  if (hq_normalized) {
    const inferred = inferCountryFromStateAbbreviation(hq_normalized);
    if (inferred) {
      parsed_fields.headquarters_location = inferred.formatted;
      parsed_fields.headquarters_city = inferred.city;
      parsed_fields.headquarters_state_code = inferred.state_code;
      parsed_fields.headquarters_country = inferred.country;
      parsed_fields.headquarters_country_code = inferred.country_code;
    }
  }

  // Extract location source URLs for audit trail
  if (parsed.location_source_urls && typeof parsed.location_source_urls === "object") {
    parsed_fields.location_source_urls = parsed.location_source_urls;
  }

  console.log(`[fetchAllFieldsUnified] Parsed fields summary: tagline=${tagline ? "yes" : "no"}, hq=${hq_normalized || "none"}, mfg=${mfg_cleaned.length}, industries=${industries_cleaned.length}, keywords=${kw_cleaned.length}, reviews=${reviews_cleaned.length}`);

  return {
    ok: true,
    method: "unified",
    raw_response_text: rawText,
    parsed_fields,
    field_statuses,
    elapsed_ms: elapsedMs,
    diagnostics: {
      ...(r.diagnostics && typeof r.diagnostics === "object" ? r.diagnostics : {}),
    },
  };
}

// ============================================================================
// FIVE-CALL SPLIT (v5.0): HQ + MFG + keywords + light fields + reviews
// ============================================================================

/**
 * Fetch HQ + Manufacturing locations in a dedicated xAI call.
 * Isolated from other fields so the model can devote full attention to thorough
 * location research (multiple browse_page + web_search calls, cross-verification).
 */
async function fetchLocationFields({
  companyName,
  websiteUrl,
  normalizedDomain,
  budgetMs = 150000,
  xaiUrl,
  xaiKey,
  model,
} = {}) {
  const started = Date.now();

  const name = asString(companyName).trim();
  const domain = normalizeDomain(normalizedDomain || websiteUrl);
  const websiteUrlForPrompt = websiteUrl
    ? asString(websiteUrl).trim()
    : domain
      ? `https://${domain}`
      : "";

  const prompt = `${SEARCH_PREAMBLE}

For the company: ${name} / ${websiteUrlForPrompt || "(unknown website)"}, determine the headquarters and manufacturing locations.

HEADQUARTERS LOCATION:
${FIELD_GUIDANCE.headquarters.rules}

MANUFACTURING LOCATIONS:
${FIELD_GUIDANCE.manufacturing.rules}

${QUALITY_RULES}
Return STRICT JSON only:
{
  ${FIELD_GUIDANCE.headquarters.jsonSchemaWithSources},
  ${FIELD_GUIDANCE.manufacturing.jsonSchemaWithSources}
}`.trim();

  // Don't exclude company domain — the prompt needs Grok to browse the company website
  // for contact/about page addresses. Domain exclusion only makes sense for reviews.
  const searchBuild = buildSearchParameters({ companyWebsiteHost: null });

  console.log(`[fetchLocationFields] prompt_summary: company="${name}", domain="${domain}", fields=["headquarters_location","manufacturing_locations"], prompt_chars=${prompt.length}, budget=${budgetMs}ms`);

  const r = await xaiLiveSearchWithRetry({
    prompt,
    timeoutMs: clampStageTimeoutMs({
      remainingMs: budgetMs,
      minMs: CALL_TIMEOUTS_MS.locations.min,
      maxMs: CALL_TIMEOUTS_MS.locations.max,
      safetyMarginMs: 5_000,
      label: "locations",
    }),
    maxAttempts: 1,
    maxTokens: 1500,
    model: resolveSearchModel(model),
    xaiUrl,
    xaiKey,
    search_parameters: {
      ...searchBuild.search_parameters,
      excluded_domains: searchBuild.excluded_domains,
    },
    useTools: true,
  });

  const elapsedMs = Date.now() - started;

  if (!r.ok) {
    const failure = classifyXaiFailure(r);
    console.log(`[fetchLocationFields] Failed: ${failure}, company="${name}", elapsed=${elapsedMs}ms`);
    return {
      ok: false,
      method: "locations",
      raw_response_text: "",
      parsed_fields: null,
      field_statuses: {},
      error: r.error,
      error_code: failure,
      elapsed_ms: elapsedMs,
      diagnostics: {
        ...(r.diagnostics && typeof r.diagnostics === "object" ? r.diagnostics : {}),
      },
    };
  }

  const rawText = asString(extractTextFromXaiResponse(r.resp));
  console.log(`[fetchLocationFields] Raw response (${rawText.length} chars): ${rawText.slice(0, 500)}${rawText.length > 500 ? "..." : ""}`);
  const parsedRaw = parseJsonFromXaiResponse(r.resp);
  // xAI sometimes returns [{hq_fields}, {mfg_fields}] instead of a single object — merge them
  if (Array.isArray(parsedRaw)) {
    console.log(`[fetchLocationFields] Merged array response (${parsedRaw.length} elements) into single object`);
  }
  const parsed = mergeArrayResponse(parsedRaw);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.log(`[fetchLocationFields] Failed to parse JSON from response for "${name}"`);
    return {
      ok: false,
      method: "locations",
      raw_response_text: rawText,
      parsed_fields: null,
      field_statuses: {},
      error: "invalid_json",
      elapsed_ms: elapsedMs,
      diagnostics: {
        reason: "could_not_parse_location_response",
        raw_preview: rawText ? rawText.slice(0, 2000) : null,
      },
    };
  }

  const result = parseStructuredResponse(parsed);

  console.log(`[fetchLocationFields] Parsed: hq=${result.parsed_fields.headquarters_location || "none"}, mfg=${result.parsed_fields.manufacturing_locations?.length || 0}, elapsed=${elapsedMs}ms`);
  console.log(`[fetchLocationFields] field_values`, {
    headquarters_location: result.parsed_fields.headquarters_location || "(empty)",
    manufacturing_locations: result.parsed_fields.manufacturing_locations || [],
    hq_source_urls: result.parsed_fields.location_source_urls?.hq_source_urls || [],
    mfg_source_urls: result.parsed_fields.location_source_urls?.mfg_source_urls || [],
  });

  return {
    ok: true,
    method: "locations",
    raw_response_text: rawText,
    parsed_fields: result.parsed_fields,
    field_statuses: result.field_statuses,
    elapsed_ms: elapsedMs,
    diagnostics: {
      ...(r.diagnostics && typeof r.diagnostics === "object" ? r.diagnostics : {}),
    },
  };
}

/**
 * Fetch product keywords in a dedicated xAI call.
 * Isolated so the model can deeply browse product catalogs, shop pages, and
 * collections without competing with other field research.
 */
async function fetchKeywordFields({
  companyName,
  websiteUrl,
  normalizedDomain,
  budgetMs = 150000,
  xaiUrl,
  xaiKey,
  model,
  signal,
} = {}) {
  const started = Date.now();

  const name = asString(companyName).trim();
  const domain = normalizeDomain(normalizedDomain || websiteUrl);
  const websiteUrlForPrompt = websiteUrl
    ? asString(websiteUrl).trim()
    : domain
      ? `https://${domain}`
      : "";

  const prompt = `${SEARCH_PREAMBLE}

For the company: ${name} / ${websiteUrlForPrompt || "(unknown website)"}, find all product keywords.

PRODUCT KEYWORDS:
${FIELD_GUIDANCE.keywords.rules}

${QUALITY_RULES}
Return STRICT JSON only:
{
  ${FIELD_GUIDANCE.keywords.jsonSchemaWithCompleteness}
}`.trim();

  // Don't exclude company domain — the prompt needs Grok to browse product/shop pages.
  const searchBuild = buildSearchParameters({ companyWebsiteHost: null });

  console.log(`[fetchKeywordFields] prompt_summary: company="${name}", domain="${domain}", fields=["product_keywords"], prompt_chars=${prompt.length}, budget=${budgetMs}ms`);

  const r = await xaiLiveSearchWithRetry({
    prompt,
    timeoutMs: clampStageTimeoutMs({
      remainingMs: budgetMs,
      minMs: CALL_TIMEOUTS_MS.keywords.min,
      maxMs: CALL_TIMEOUTS_MS.keywords.max,
      safetyMarginMs: 5_000,
      label: "keywords",
    }),
    maxAttempts: 1,
    maxTokens: 1500,
    model: resolveSearchModel(model),
    xaiUrl,
    xaiKey,
    signal,
    search_parameters: {
      ...searchBuild.search_parameters,
      excluded_domains: searchBuild.excluded_domains,
    },
    useTools: true,
  });

  const elapsedMs = Date.now() - started;

  if (!r.ok) {
    const failure = classifyXaiFailure(r);
    console.log(`[fetchKeywordFields] Failed: ${failure}, company="${name}", elapsed=${elapsedMs}ms`);
    return {
      ok: false,
      method: "keywords",
      raw_response_text: "",
      parsed_fields: null,
      field_statuses: {},
      error: r.error,
      error_code: failure,
      elapsed_ms: elapsedMs,
      diagnostics: {
        ...(r.diagnostics && typeof r.diagnostics === "object" ? r.diagnostics : {}),
      },
    };
  }

  const rawText = asString(extractTextFromXaiResponse(r.resp));
  console.log(`[fetchKeywordFields] Raw response (${rawText.length} chars): ${rawText.slice(0, 500)}${rawText.length > 500 ? "..." : ""}`);
  const parsedRaw = parseJsonFromXaiResponse(r.resp);
  // xAI sometimes returns [{kw_fields}] instead of a single object — merge if needed
  if (Array.isArray(parsedRaw)) {
    console.log(`[fetchKeywordFields] Merged array response (${parsedRaw.length} elements) into single object`);
  }
  const parsed = mergeArrayResponse(parsedRaw);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.log(`[fetchKeywordFields] Failed to parse JSON from response for "${name}"`);
    return {
      ok: false,
      method: "keywords",
      raw_response_text: rawText,
      parsed_fields: null,
      field_statuses: {},
      error: "invalid_json",
      elapsed_ms: elapsedMs,
      diagnostics: {
        reason: "could_not_parse_keyword_response",
        raw_preview: rawText ? rawText.slice(0, 2000) : null,
      },
    };
  }

  const result = parseStructuredResponse(parsed);

  console.log(`[fetchKeywordFields] Parsed: keywords=${result.parsed_fields.product_keywords?.length || 0}, completeness=${result.parsed_fields.keywords_completeness || "n/a"}, elapsed=${elapsedMs}ms`);
  {
    const kw = result.parsed_fields.product_keywords || [];
    console.log(`[fetchKeywordFields] field_values: total=${kw.length}, first_20=${JSON.stringify(kw.slice(0, 20))}${kw.length > 20 ? `, ... +${kw.length - 20} more` : ""}`);
  }

  return {
    ok: true,
    method: "keywords",
    raw_response_text: rawText,
    parsed_fields: result.parsed_fields,
    field_statuses: result.field_statuses,
    elapsed_ms: elapsedMs,
    diagnostics: {
      ...(r.diagnostics && typeof r.diagnostics === "object" ? r.diagnostics : {}),
    },
  };
}

/**
 * Fetch tagline + industries + logo in a single lightweight xAI call.
 * These fields are all found on or near the homepage and require minimal
 * web searching — natural companions that finish quickly.
 */
async function fetchLightFields({
  companyName,
  websiteUrl,
  normalizedDomain,
  budgetMs = 90000,
  xaiUrl,
  xaiKey,
  model,
  skipLogo = false,
  signal,
} = {}) {
  const started = Date.now();

  const name = asString(companyName).trim();
  const domain = normalizeDomain(normalizedDomain || websiteUrl);
  const websiteUrlForPrompt = websiteUrl
    ? asString(websiteUrl).trim()
    : domain
      ? `https://${domain}`
      : "";

  const logoBlock = skipLogo ? "" : `
LOGO:
${FIELD_GUIDANCE.logo.rules}
`;
  const logoJsonSchema = skipLogo ? "" : `
  ${FIELD_GUIDANCE.logo.jsonSchema},
  "logo_source": "header" | "nav" | "footer" | "meta" | null`;

  const prompt = `${SEARCH_PREAMBLE}

For the company: ${name} / ${websiteUrlForPrompt || "(unknown website)"}, provide the following fields.
IMPORTANT: When browsing the homepage, identify the tagline FIRST — it is the short phrase in the hero section, near the logo, or in the site's meta description. Return the exact text.

TAGLINE:
${FIELD_GUIDANCE.tagline.rules}

INDUSTRIES:
${FIELD_GUIDANCE.industries.rules}
${logoBlock}
${QUALITY_RULES}
Return STRICT JSON only:
{
  ${FIELD_GUIDANCE.tagline.jsonSchema},
  ${FIELD_GUIDANCE.industries.jsonSchema}${logoJsonSchema}
}`.trim();

  // Don't exclude company domain — the prompt needs Grok to browse the homepage.
  const searchBuild = buildSearchParameters({ companyWebsiteHost: null });

  const lightFieldNames = skipLogo ? '["tagline","industries"]' : '["tagline","industries","logo_url"]';
  console.log(`[fetchLightFields] prompt_summary: company="${name}", domain="${domain}", fields=${lightFieldNames}, prompt_chars=${prompt.length}, budget=${budgetMs}ms${skipLogo ? ", skipLogo=true" : ""}`);

  const r = await xaiLiveSearchWithRetry({
    prompt,
    timeoutMs: clampStageTimeoutMs({
      remainingMs: budgetMs,
      minMs: CALL_TIMEOUTS_MS.light.min,
      maxMs: CALL_TIMEOUTS_MS.light.max,
      safetyMarginMs: 5_000,
      label: "light",
    }),
    maxAttempts: 1,
    maxTokens: 2000,
    model: resolveSearchModel(model),
    xaiUrl,
    xaiKey,
    signal,
    search_parameters: {
      ...searchBuild.search_parameters,
      excluded_domains: searchBuild.excluded_domains,
    },
    useTools: true,
    enableImageUnderstanding: true,
  });

  const elapsedMs = Date.now() - started;

  if (!r.ok) {
    const failure = classifyXaiFailure(r);
    console.log(`[fetchLightFields] Failed: ${failure}, company="${name}", elapsed=${elapsedMs}ms`);
    return {
      ok: false,
      method: "light",
      raw_response_text: "",
      parsed_fields: null,
      field_statuses: {},
      error: r.error,
      error_code: failure,
      elapsed_ms: elapsedMs,
      diagnostics: {
        ...(r.diagnostics && typeof r.diagnostics === "object" ? r.diagnostics : {}),
      },
    };
  }

  const rawText = asString(extractTextFromXaiResponse(r.resp));
  console.log(`[fetchLightFields] Raw response (${rawText.length} chars): ${rawText.slice(0, 500)}${rawText.length > 500 ? "..." : ""}`);
  const parsedRaw = parseJsonFromXaiResponse(r.resp);
  // xAI sometimes returns [{tagline_fields}, {industry_fields}, ...] — merge if needed
  if (Array.isArray(parsedRaw)) {
    console.log(`[fetchLightFields] Merged array response (${parsedRaw.length} elements) into single object`);
  }
  const parsed = mergeArrayResponse(parsedRaw);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.log(`[fetchLightFields] Failed to parse JSON from response for "${name}"`);
    return {
      ok: false,
      method: "light",
      raw_response_text: rawText,
      parsed_fields: null,
      field_statuses: {},
      error: "invalid_json",
      elapsed_ms: elapsedMs,
      diagnostics: {
        reason: "could_not_parse_light_response",
        raw_preview: rawText ? rawText.slice(0, 2000) : null,
      },
    };
  }

  const result = parseStructuredResponse(parsed);

  // Add logo_url extraction (same as fetchStructuredFields) — skip when logo already captured
  if (!skipLogo) {
    const logo_url_raw = asString(parsed.logo_url || "").trim() || null;
    const logo_source_raw = asString(parsed.logo_source || "").trim() || null;
    result.field_statuses.logo_url = logo_url_raw ? "ok" : "empty";
    result.parsed_fields.logo_url = logo_url_raw ? safeUrl(logo_url_raw) : null;
    result.parsed_fields.logo_source = logo_source_raw;
  }

  const logoStatus = skipLogo ? "skipped (pre-captured)" : (result.parsed_fields.logo_url ? "yes" : "no");
  console.log(`[fetchLightFields] Parsed: tagline=${result.parsed_fields.tagline ? "yes" : "no"}, industries=${result.parsed_fields.industries?.length || 0}, logo=${logoStatus}, elapsed=${elapsedMs}ms`);
  console.log(`[fetchLightFields] field_values`, {
    tagline: result.parsed_fields.tagline || "(empty)",
    industries: result.parsed_fields.industries || [],
    ...(skipLogo ? {} : { logo_url: result.parsed_fields.logo_url || "(empty)", logo_source: result.parsed_fields.logo_source || "(none)" }),
  });

  return {
    ok: true,
    method: "light",
    raw_response_text: rawText,
    parsed_fields: result.parsed_fields,
    field_statuses: result.field_statuses,
    elapsed_ms: elapsedMs,
    diagnostics: {
      ...(r.diagnostics && typeof r.diagnostics === "object" ? r.diagnostics : {}),
    },
  };
}

// ============================================================================
// LEGACY (v3.0): fetchStructuredFields + retryMissingStructuredFields
// ============================================================================

/**
 * @deprecated v4.0 — replaced by fetchLocationFields + fetchKeywordFields + fetchLightFields.
 * Kept for backward compatibility and retryMissingStructuredFields fallback.
 *
 * Fetches ALL structured fields (tagline, HQ, mfg, industries, keywords, logo)
 * in a single xAI call using FULL FIELD_GUIDANCE rules (not condensed summaries).
 * Does NOT request reviews (those come from fetchCuratedReviews in parallel).
 */
async function fetchStructuredFields({
  companyName,
  websiteUrl,
  normalizedDomain,
  budgetMs = 180000,
  xaiUrl,
  xaiKey,
  model,
} = {}) {
  const started = Date.now();

  const name = asString(companyName).trim();
  const domain = normalizeDomain(normalizedDomain || websiteUrl);
  const websiteUrlForPrompt = websiteUrl
    ? asString(websiteUrl).trim()
    : domain
      ? `https://${domain}`
      : "";

  const prompt = `${SEARCH_PREAMBLE}

For the company: ${name} / ${websiteUrlForPrompt || "(unknown website)"}, provide the following fields.
IMPORTANT: When browsing the homepage, identify the tagline FIRST — it is the short phrase in the hero section, near the logo, or in the site's meta description. Return the exact text.

TAGLINE:
${FIELD_GUIDANCE.tagline.rules}

HEADQUARTERS LOCATION:
${FIELD_GUIDANCE.headquarters.rules}

MANUFACTURING LOCATIONS:
${FIELD_GUIDANCE.manufacturing.rules}

INDUSTRIES:
${FIELD_GUIDANCE.industries.rules}

PRODUCT KEYWORDS:
${FIELD_GUIDANCE.keywords.rules}

LOGO:
${FIELD_GUIDANCE.logo.rules}

${QUALITY_RULES}
Return STRICT JSON only:
{
  ${FIELD_GUIDANCE.tagline.jsonSchema},
  ${FIELD_GUIDANCE.headquarters.jsonSchemaWithSources},
  ${FIELD_GUIDANCE.manufacturing.jsonSchemaWithSources},
  ${FIELD_GUIDANCE.industries.jsonSchema},
  ${FIELD_GUIDANCE.keywords.jsonSchemaWithCompleteness},
  ${FIELD_GUIDANCE.logo.jsonSchema},
  "logo_source": "header" | "nav" | "footer" | "meta" | null
}`.trim();

  const searchBuild = buildSearchParameters({ companyWebsiteHost: domain });

  const r = await xaiLiveSearchWithRetry({
    prompt,
    timeoutMs: clampStageTimeoutMs({
      remainingMs: budgetMs,
      minMs: TWO_CALL_TIMEOUTS_MS.structured.min,
      maxMs: TWO_CALL_TIMEOUTS_MS.structured.max,
      safetyMarginMs: 5_000,
      label: "structured",
    }),
    maxAttempts: 1,
    maxTokens: 4000,
    model: resolveSearchModel(model),
    xaiUrl,
    xaiKey,
    search_parameters: {
      ...searchBuild.search_parameters,
      excluded_domains: searchBuild.excluded_domains,
    },
    useTools: true,
    enableImageUnderstanding: true,  // Grok can verify logo images found during search
  });

  const elapsedMs = Date.now() - started;

  if (!r.ok) {
    const failure = classifyXaiFailure(r);
    console.log(`[fetchStructuredFields] Failed: ${failure}, company="${name}", elapsed=${elapsedMs}ms`);
    return {
      ok: false,
      method: "structured",
      raw_response_text: "",
      parsed_fields: null,
      field_statuses: {},
      error: r.error,
      error_code: failure,
      elapsed_ms: elapsedMs,
      diagnostics: {
        ...(r.diagnostics && typeof r.diagnostics === "object" ? r.diagnostics : {}),
      },
    };
  }

  const rawText = asString(extractTextFromXaiResponse(r.resp));
  console.log(`[fetchStructuredFields] Raw response (${rawText.length} chars): ${rawText.slice(0, 500)}${rawText.length > 500 ? "..." : ""}`);
  const parsedRaw = parseJsonFromXaiResponse(r.resp);
  if (Array.isArray(parsedRaw)) {
    console.log(`[fetchStructuredFields] Merged array response (${parsedRaw.length} elements) into single object`);
  }
  const parsed = mergeArrayResponse(parsedRaw);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.log(`[fetchStructuredFields] Failed to parse JSON from response for "${name}"`);
    return {
      ok: false,
      method: "structured",
      raw_response_text: rawText,
      parsed_fields: null,
      field_statuses: {},
      error: "invalid_json",
      elapsed_ms: elapsedMs,
      diagnostics: {
        reason: "could_not_parse_structured_response",
        raw_preview: rawText ? rawText.slice(0, 2000) : null,
      },
    };
  }

  // Reuse the same field extraction/normalization as fetchAllFieldsUnified
  const result = parseStructuredResponse(parsed);

  // Add logo_url extraction
  const logo_url_raw = asString(parsed.logo_url || "").trim() || null;
  const logo_source = asString(parsed.logo_source || "").trim() || null;
  result.field_statuses.logo_url = logo_url_raw ? "ok" : "empty";
  result.parsed_fields.logo_url = logo_url_raw ? safeUrl(logo_url_raw) : null;
  result.parsed_fields.logo_source = logo_source;

  console.log(`[fetchStructuredFields] Parsed fields summary: tagline=${result.parsed_fields.tagline ? "yes" : "no"}, hq=${result.parsed_fields.headquarters_location || "none"}, mfg=${result.parsed_fields.manufacturing_locations?.length || 0}, industries=${result.parsed_fields.industries?.length || 0}, keywords=${result.parsed_fields.product_keywords?.length || 0}, logo=${logo_url_raw ? "yes" : "no"}`);

  return {
    ok: true,
    method: "structured",
    raw_response_text: rawText,
    parsed_fields: result.parsed_fields,
    field_statuses: result.field_statuses,
    elapsed_ms: elapsedMs,
    diagnostics: {
      ...(r.diagnostics && typeof r.diagnostics === "object" ? r.diagnostics : {}),
    },
  };
}

/** Returns true if the string is a sentinel or placeholder that should not count as real data. */
function isSentinelOrPlaceholder(s) {
  const key = asString(s).trim().toLowerCase().replace(/\s+/g, " ");
  return !key || SENTINEL_STRINGS.has(key) || PLACEHOLDER_STRINGS.has(key);
}

/**
 * Shared field extraction/normalization for structured responses.
 * Used by both fetchStructuredFields() and retryMissingStructuredFields().
 */
function parseStructuredResponse(parsed) {
  const field_statuses = {};

  const tagline_raw = asString(parsed.tagline || parsed.slogan || "").trim();
  const tagline = isSentinelOrPlaceholder(tagline_raw) ? "" : tagline_raw;
  field_statuses.tagline = tagline ? "ok" : "empty";

  // Unwrap nested object — XAI sometimes wraps in { headquarters: { headquarters_location: "..." } }
  // or { headquarters_location: { headquarters_location: "..." } }
  let hq_val = parsed.headquarters_location || parsed.hq || parsed.headquarters?.headquarters_location || "";
  if (hq_val && typeof hq_val === "object" && !Array.isArray(hq_val)) {
    hq_val = hq_val.headquarters_location || hq_val.hq || hq_val.location || "";
  }
  const hq_raw = asString(hq_val).trim();
  let hq_normalized = hq_raw ? normalizeCountryInLocation(normalizeLocationWithStateAbbrev(hq_raw)) : "";
  if (isSentinelOrPlaceholder(hq_normalized)) hq_normalized = "";
  field_statuses.headquarters = hq_normalized ? "ok" : "empty";

  // Unwrap nested object — XAI sometimes wraps in { manufacturing: { manufacturing_locations: [...] } }
  // or { manufacturing_locations: { manufacturing_locations: [...] } }
  let mfg_val = parsed.manufacturing_locations || parsed.manufacturing?.manufacturing_locations;
  if (mfg_val && typeof mfg_val === "object" && !Array.isArray(mfg_val) && Array.isArray(mfg_val.manufacturing_locations)) {
    mfg_val = mfg_val.manufacturing_locations;
  }
  const mfg_raw = Array.isArray(mfg_val) ? mfg_val : [];
  const mfg_all = mfg_raw
    .map((x) => asString(x).trim())
    .filter(Boolean)
    .map(normalizeLocationWithStateAbbrev)
    .map(normalizeCountryInLocation);
  const mfg_cleaned = mfg_all.filter((loc) => !isSentinelOrPlaceholder(loc));
  const mfg_had_sentinel = mfg_all.length > 0 && mfg_cleaned.length === 0;
  field_statuses.manufacturing = mfg_cleaned.length > 0
    ? "ok"
    : mfg_had_sentinel ? "not_disclosed" : "empty";

  // Unwrap nested object — XAI sometimes returns { industries: { industries: [...] } }
  let industries_val = parsed.industries;
  if (industries_val && typeof industries_val === "object" && !Array.isArray(industries_val) && Array.isArray(industries_val.industries)) {
    industries_val = industries_val.industries;
  }
  const industries_raw = Array.isArray(industries_val) ? industries_val : [];
  const industries_cleaned = industries_raw
    .map((x) => asString(x).trim())
    .filter(Boolean)
    .filter((x) => !isSentinelOrPlaceholder(x))
    .slice(0, 3);
  field_statuses.industries = industries_cleaned.length > 0 ? "ok" : "empty";

  // Unwrap nested object — XAI sometimes returns { product_keywords: { product_keywords: [...] } }
  let kw_val = parsed.product_keywords || parsed.keywords;
  if (kw_val && typeof kw_val === "object" && !Array.isArray(kw_val)) {
    kw_val = kw_val.product_keywords || kw_val.keywords || kw_val;
  }
  const kw_raw = Array.isArray(kw_val) ? kw_val : [];
  const kw_cleaned = Array.from(new Set(
    kw_raw.map((x) => asString(x).trim()).filter(Boolean).filter((x) => !isSentinelOrPlaceholder(x))
  ));
  field_statuses.keywords = kw_cleaned.length > 0 ? "ok" : "empty";

  // Check self-reported completeness for keywords
  // Treat "incomplete" as "ok" when 5+ keywords are present (realistic capture rate)
  const kw_completeness = asString(parsed.completeness || "").trim().toLowerCase();
  if (kw_cleaned.length >= 5 && kw_completeness === "incomplete") {
    field_statuses.keywords = "ok";
  } else if (kw_cleaned.length > 0 && kw_completeness === "incomplete") {
    field_statuses.keywords = "incomplete";
  }

  const parsed_fields = {
    tagline,
    headquarters_location: hq_normalized,
    manufacturing_locations: mfg_cleaned,
    industries: industries_cleaned,
    product_keywords: kw_cleaned,
    keywords_completeness: kw_completeness || null,
    keywords_incomplete_reason: asString(parsed.incomplete_reason || "").trim() || null,
  };

  // Infer HQ country
  if (hq_normalized) {
    const inferred = inferCountryFromStateAbbreviation(hq_normalized);
    if (inferred) {
      parsed_fields.headquarters_location = inferred.formatted;
      parsed_fields.headquarters_city = inferred.city;
      parsed_fields.headquarters_state_code = inferred.state_code;
      parsed_fields.headquarters_country = inferred.country;
      parsed_fields.headquarters_country_code = inferred.country_code;
    }
  }

  // Extract location source URLs for audit trail — may be at top level or nested inside
  // wrapper objects (e.g., parsed.headquarters.location_source_urls, parsed.manufacturing.location_source_urls)
  const merged_source_urls = {};
  const sourceCandidates = [
    parsed.location_source_urls,
    parsed.headquarters?.location_source_urls,
    parsed.manufacturing?.location_source_urls,
  ];
  for (const src of sourceCandidates) {
    if (src && typeof src === "object") Object.assign(merged_source_urls, src);
  }
  if (Object.keys(merged_source_urls).length > 0) {
    parsed_fields.location_source_urls = merged_source_urls;
  }

  return { parsed_fields, field_statuses };
}

/**
 * Retry for missing structured fields — makes ONE xAI call requesting only
 * the specific fields that came back empty from fetchStructuredFields().
 */
async function retryMissingStructuredFields({
  companyName,
  websiteUrl,
  normalizedDomain,
  missingFields,
  budgetMs = 120000,
  xaiUrl,
  xaiKey,
  model,
} = {}) {
  if (!Array.isArray(missingFields) || missingFields.length === 0) {
    return { ok: true, parsed_fields: {}, field_statuses: {}, elapsed_ms: 0 };
  }

  const started = Date.now();
  const name = asString(companyName).trim();
  const domain = normalizeDomain(normalizedDomain || websiteUrl);
  const websiteUrlForPrompt = websiteUrl
    ? asString(websiteUrl).trim()
    : domain
      ? `https://${domain}`
      : "";

  // Build targeted prompt with ONLY the missing field guidance
  const sections = [];
  const jsonParts = [];
  for (const field of missingFields) {
    switch (field) {
      case "tagline":
        sections.push(`TAGLINE:\n${FIELD_GUIDANCE.tagline.rules}`);
        jsonParts.push(FIELD_GUIDANCE.tagline.jsonSchema);
        break;
      case "headquarters":
        sections.push(`HEADQUARTERS LOCATION:\n${FIELD_GUIDANCE.headquarters.rules}`);
        jsonParts.push(FIELD_GUIDANCE.headquarters.jsonSchemaWithSources);
        break;
      case "manufacturing":
        sections.push(`MANUFACTURING LOCATIONS:\n${FIELD_GUIDANCE.manufacturing.rules}`);
        jsonParts.push(FIELD_GUIDANCE.manufacturing.jsonSchemaWithSources);
        break;
      case "industries":
        sections.push(`INDUSTRIES:\n${FIELD_GUIDANCE.industries.rules}`);
        jsonParts.push(FIELD_GUIDANCE.industries.jsonSchema);
        break;
      case "keywords":
        sections.push(`PRODUCT KEYWORDS:\n${FIELD_GUIDANCE.keywords.rules}`);
        jsonParts.push(FIELD_GUIDANCE.keywords.jsonSchemaWithCompleteness);
        break;
      case "logo_url":
        sections.push(`LOGO:\n${FIELD_GUIDANCE.logo.rules}`);
        jsonParts.push(`${FIELD_GUIDANCE.logo.jsonSchema}, "logo_source": "header" | "nav" | "footer" | "meta" | null`);
        break;
    }
  }

  if (sections.length === 0) {
    return { ok: true, parsed_fields: {}, field_statuses: {}, elapsed_ms: 0 };
  }

  const prompt = `${SEARCH_PREAMBLE}

For the company: ${name} / ${websiteUrlForPrompt || "(unknown website)"}, determine the following fields.

${sections.join("\n\n")}

${QUALITY_RULES}
Return STRICT JSON only with the requested fields:
{ ${jsonParts.join(", ")} }`.trim();

  // Don't exclude company domain — the prompt needs Grok to browse the company website
  // for locations (footer/contact addresses), keywords (product pages), tagline, logo, etc.
  const searchBuild = buildSearchParameters({ companyWebsiteHost: null });

  const needsImageUnderstanding = missingFields.includes("logo_url");

  const r = await xaiLiveSearchWithRetry({
    prompt,
    timeoutMs: clampStageTimeoutMs({
      remainingMs: budgetMs,
      minMs: TWO_CALL_TIMEOUTS_MS.structured.min,
      maxMs: TWO_CALL_TIMEOUTS_MS.structured.max,
      safetyMarginMs: 5_000,
      label: "structured_retry",
    }),
    maxAttempts: 1,
    maxTokens: 2000,
    model: resolveSearchModel(model),
    xaiUrl,
    xaiKey,
    search_parameters: {
      ...searchBuild.search_parameters,
      excluded_domains: searchBuild.excluded_domains,
    },
    useTools: true,
    enableImageUnderstanding: needsImageUnderstanding,
  });

  const elapsedMs = Date.now() - started;

  if (!r.ok) {
    const failure = classifyXaiFailure(r);
    console.log(`[retryMissingStructuredFields] Failed for "${name}": ${failure}, fields=[${missingFields.join(", ")}], elapsed=${elapsedMs}ms`);
    return {
      ok: false,
      parsed_fields: {},
      field_statuses: Object.fromEntries(missingFields.map((f) => [f, failure])),
      error: r.error,
      error_code: failure,
      elapsed_ms: elapsedMs,
    };
  }

  const parsed = parseJsonFromXaiResponse(r.resp);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.log(`[retryMissingStructuredFields] Failed to parse JSON for "${name}", fields=[${missingFields.join(", ")}]`);
    return {
      ok: false,
      parsed_fields: {},
      field_statuses: Object.fromEntries(missingFields.map((f) => [f, "invalid_json"])),
      error: "invalid_json",
      elapsed_ms: elapsedMs,
    };
  }

  const result = parseStructuredResponse(parsed);

  // Add logo_url extraction (mirrors fetchStructuredFields post-processing)
  if (missingFields.includes("logo_url")) {
    const logo_url_raw = asString(parsed.logo_url || "").trim() || null;
    const logo_source = asString(parsed.logo_source || "").trim() || null;
    result.field_statuses.logo_url = logo_url_raw ? "ok" : "empty";
    result.parsed_fields.logo_url = logo_url_raw ? safeUrl(logo_url_raw) : null;
    result.parsed_fields.logo_source = logo_source;
  }

  // Strip empty/falsy values so they don't get saved as "filled" and trigger another retry cycle
  for (const [key, val] of Object.entries(result.parsed_fields)) {
    if (val === "" || val === null || val === undefined ||
        (Array.isArray(val) && val.length === 0)) {
      delete result.parsed_fields[key];
    }
  }

  const filledCount = Object.keys(result.parsed_fields).length;
  console.log(`[retryMissingStructuredFields] ${filledCount > 0 ? "Success" : "Complete (all empty)"} for "${name}": fields=[${missingFields.join(", ")}], filled=${filledCount}, statuses=${JSON.stringify(result.field_statuses)}, elapsed=${elapsedMs}ms`);

  return {
    ok: filledCount > 0,
    parsed_fields: result.parsed_fields,
    field_statuses: result.field_statuses,
    elapsed_ms: elapsedMs,
  };
}

/**
 * Verify a logo URL is accessible via HEAD request.
 * Returns { ok, reason, content_type }.
 */
async function verifyLogoUrl(logoUrl) {
  const validUrl = safeUrl(logoUrl);
  if (!validUrl) return { ok: false, reason: "invalid_url" };
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 10_000);
    const resp = await fetch(validUrl, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "Tabarnam-LogoVerify/1.0" },
    });
    clearTimeout(tid);
    if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    const isImage = ct.startsWith("image/") || ct.includes("svg");
    if (!isImage) return { ok: false, reason: `not_image_${ct.split(";")[0]}` };
    return { ok: true, reason: null, content_type: ct };
  } catch (e) {
    return { ok: false, reason: e?.name === "AbortError" ? "timeout" : "network_error" };
  }
}

// ============================================================================
// VERIFICATION PIPELINE: Validate fields returned by unified or individual calls
// ============================================================================

/**
 * Verify enrichment fields - especially review URLs and locations.
 * Returns verified fields + verification status per field.
 */
async function verifyEnrichmentFields(parsed, { companyName, budgetMs = 60000 } = {}) {
  const started = Date.now();
  const verified = { ...parsed };
  const verification_status = {};
  const name = asString(companyName).trim();

  const getRemainingMs = () => Math.max(0, budgetMs - (Date.now() - started));

  // --- Verify review URLs ---
  if (Array.isArray(parsed.reviews) && parsed.reviews.length > 0) {
    const excludeDomains = normalizeExcludeDomains({ normalizedDomain: normalizeDomain(parsed.headquarters_location || "") });
    const verifiedReviews = [];
    const unverifiedReviews = [];
    const seenAuthors = new Set();

    for (const review of parsed.reviews) {
      if (verifiedReviews.length + unverifiedReviews.length >= 6) break;

      // Skip duplicate authors
      const authorKey = asString(review.author).trim().toLowerCase();
      if (authorKey && seenAuthors.has(authorKey)) continue;

      // Skip excluded domains
      if (excludeDomains.some((d) => (review.source_url || "").includes(d))) continue;

      // If budget is running low, keep remaining reviews as unverified
      if (getRemainingMs() < 3000) {
        review.verified = false;
        review.verification_failure = "budget_exhausted";
        console.log(`[verifyEnrichmentFields] Review "${review.source_url}" → UNVERIFIED (budget_exhausted)`);
        if (authorKey) seenAuthors.add(authorKey);
        unverifiedReviews.push(review);
        continue;
      }

      const isYT = isYouTubeUrl(review.source_url);
      const timeoutMs = isYT ? 6000 : 10000;

      // Verify URL is reachable
      const urlCheck = await verifyUrlReachable(review.source_url, { timeoutMs });

      if (!urlCheck.ok) {
        review.verified = false;
        review.verification_failure = "url_unreachable";
        console.log(`[verifyEnrichmentFields] Review "${review.source_url}" → UNVERIFIED (url_unreachable)`);
        if (authorKey) seenAuthors.add(authorKey);
        unverifiedReviews.push(review);
        continue;
      }

      // YouTube: verify video actually exists
      if (isYT) {
        const ytCheck = await verifyYouTubeVideoAvailable(review.source_url, { timeoutMs: 5000 });
        if (!ytCheck.ok) {
          review.verified = false;
          review.verification_failure = "youtube_unavailable";
          console.log(`[verifyEnrichmentFields] Review "${review.source_url}" → UNVERIFIED (youtube_unavailable)`);
          if (authorKey) seenAuthors.add(authorKey);
          unverifiedReviews.push(review);
          continue;
        }
        // Enrich YouTube reviews with HTML metadata (og:title has the actual video title)
        if (urlCheck.html_preview) {
          const meta = buildReviewMetadataFromHtml(review.source_url, urlCheck.html_preview);
          if (meta.title) review.title = meta.title;
        }
      }

      // Blog: verify content mentions the company
      if (!isYT && urlCheck.html_preview && name) {
        const relevance = validateBlogContentRelevance(urlCheck.html_preview, name);
        if (!relevance.relevant) {
          review.verified = false;
          review.verification_failure = "content_not_relevant";
          console.log(`[verifyEnrichmentFields] Review "${review.source_url}" → UNVERIFIED (content_not_relevant)`);
          if (authorKey) seenAuthors.add(authorKey);
          unverifiedReviews.push(review);
          continue;
        }
        // Enrich with HTML metadata when available
        const meta = buildReviewMetadataFromHtml(review.source_url, urlCheck.html_preview);
        if (meta.title) review.title = meta.title;
        if (meta.author && !review.author) review.author = meta.author;
        if (meta.date && !review.date) review.date = meta.date;
        if (meta.excerpt && !review.excerpt) review.excerpt = meta.excerpt;
      }

      review.verified = true;
      console.log(`[verifyEnrichmentFields] Review "${review.source_url}" → VERIFIED`);
      if (authorKey) seenAuthors.add(authorKey);
      verifiedReviews.push(review);
    }

    // Prefer verified reviews, then include "soft" unverified (budget_exhausted,
    // content_not_relevant) as fallbacks. Reviews with confirmed-dead URLs
    // (url_unreachable, youtube_unavailable) are dropped — they would fail the
    // get-reviews visibility filter anyway and confuse admin into thinking
    // reviews exist when they don't.
    const DEAD_URL_REASONS = new Set(["url_unreachable", "youtube_unavailable", "cross_domain_redirect"]);
    const softUnverified = unverifiedReviews.filter((r) => !DEAD_URL_REASONS.has(r.verification_failure));
    const droppedDead = unverifiedReviews.filter((r) => DEAD_URL_REASONS.has(r.verification_failure));
    if (droppedDead.length > 0) {
      console.log(`[verifyEnrichmentFields] Dropped ${droppedDead.length} review(s) with dead URLs: ${droppedDead.map((r) => r.source_url).join(", ")}`);
    }

    const maxReviews = 3;
    const combined = verifiedReviews.slice(0, maxReviews);
    if (combined.length < maxReviews && softUnverified.length > 0) {
      combined.push(...softUnverified.slice(0, maxReviews - combined.length));
    }
    verified.reviews = combined;
    // verification_status MUST be a string ("ok" | "empty" | etc.) so that downstream
    // consumers (runDirectEnrichment → isFieldComplete) can compare with ===.
    // Detailed stats are stored separately in reviews_verification_detail.
    verification_status.reviews = combined.length > 0 ? "ok" : "empty";
    verification_status.reviews_verification_detail = {
      submitted: parsed.reviews.length,
      verified: verifiedReviews.length,
      unverified: unverifiedReviews.length,
      dropped_dead_urls: droppedDead.length,
      kept: combined.length,
    };
    console.log(`[verifyEnrichmentFields] Reviews: ${parsed.reviews.length} submitted → ${verifiedReviews.length} verified + ${softUnverified.length} soft-unverified + ${droppedDead.length} dropped (dead URLs) → ${combined.length} kept`);

    // Track ALL attempted review URLs (verified + unverified) so downstream
    // callers can persist them to review_cursor.attempted_urls and prevent
    // the resume worker from re-trying the same URLs.
    verification_status.reviews_attempted_urls = [
      ...verifiedReviews.map((r) => r.source_url),
      ...unverifiedReviews.map((r) => r.source_url),
    ].filter(Boolean);
  }

  // --- Verify/normalize locations (lightweight) ---
  if (verified.headquarters_location) {
    verification_status.headquarters = "ok";
  }
  if (Array.isArray(verified.manufacturing_locations) && verified.manufacturing_locations.length > 0) {
    verification_status.manufacturing = "ok";
  }
  if (Array.isArray(verified.industries) && verified.industries.length > 0) {
    verification_status.industries = "ok";
  }
  if (Array.isArray(verified.product_keywords) && verified.product_keywords.length > 0) {
    verification_status.keywords = "ok";
  }
  if (verified.tagline) {
    verification_status.tagline = "ok";
  }

  return { verified, verification_status };
}

// ============================================================================
// ORCHESTRATOR: Unified prompt → verify → fallback for missing fields
// ============================================================================

/**
 * Helper: identify which fields are missing/empty from the enrichment result.
 */
function findMissingFields(fields) {
  const missing = [];
  if (!fields.tagline) missing.push("tagline");
  if (!fields.headquarters_location) missing.push("headquarters");
  if (!Array.isArray(fields.manufacturing_locations) || fields.manufacturing_locations.length === 0) missing.push("manufacturing");
  if (!Array.isArray(fields.industries) || fields.industries.length === 0) missing.push("industries");
  if (!Array.isArray(fields.product_keywords) || fields.product_keywords.length === 0) missing.push("keywords");
  if (!Array.isArray(fields.reviews) || fields.reviews.length === 0) missing.push("reviews");
  if (!fields.logo_url) missing.push("logo_url");
  return missing;
}

/**
 * Fill specific missing fields using individual prompt functions.
 */
/** @deprecated v3.0 — replaced by retryMissingStructuredFields() in the two-call split pipeline.
 *  Kept exported for backward compat (admin refresh, resume-worker legacy path). */
async function fillMissingFieldsIndividually(missingFields, {
  companyName,
  normalizedDomain,
  budgetMs = 120000,
  xaiUrl,
  xaiKey,
  attempted_urls = [],
} = {}) {
  const started = Date.now();
  const getRemainingMs = () => Math.max(0, budgetMs - (Date.now() - started));
  const filled = {};
  const field_statuses = {};

  const promises = [];
  const fieldNames = [];

  for (const field of missingFields) {
    if (getRemainingMs() < 10000) break;

    const args = { companyName, normalizedDomain, budgetMs: getRemainingMs(), xaiUrl, xaiKey };

    switch (field) {
      case "tagline":
        promises.push(fetchTagline(args));
        fieldNames.push("tagline");
        break;
      case "headquarters":
        promises.push(fetchHeadquartersLocation(args));
        fieldNames.push("headquarters");
        break;
      case "manufacturing":
        promises.push(fetchManufacturingLocations(args));
        fieldNames.push("manufacturing");
        break;
      case "industries":
        promises.push(fetchIndustries(args));
        fieldNames.push("industries");
        break;
      case "keywords":
        promises.push(fetchProductKeywords(args));
        fieldNames.push("keywords");
        break;
      case "reviews":
        promises.push(fetchCuratedReviews({ ...args, attempted_urls }));
        fieldNames.push("reviews");
        break;
    }
  }

  if (promises.length === 0) return { filled, field_statuses };

  // Wrap allSettled with a hard timeout so it never exceeds the budget.
  // xaiLiveSearchWithRetry can retry (2 attempts × full timeout), causing
  // allSettled to wait far longer than budgetMs. This cap ensures we return
  // partial results instead of hanging.
  const results = await raceTimeout(
    Promise.allSettled(promises),
    budgetMs + 5000,
    "fillMissingFieldsIndividually"
  ).catch((e) => {
    console.warn(`[fillMissingFieldsIndividually] ${e.message} — returning partial results`);
    return promises.map(() => ({ status: "rejected", reason: e }));
  });

  for (let i = 0; i < results.length; i++) {
    const field = fieldNames[i];
    const result = results[i];

    if (result.status !== "fulfilled" || !result.value) {
      field_statuses[field] = "error";
      continue;
    }

    const val = result.value;

    switch (field) {
      case "tagline":
        if (val.tagline) {
          filled.tagline = val.tagline;
          field_statuses.tagline = "ok";
        } else {
          field_statuses.tagline = val.tagline_status || "empty";
        }
        break;
      case "headquarters":
        if (val.headquarters_location) {
          filled.headquarters_location = val.headquarters_location;
          if (val.headquarters_city) filled.headquarters_city = val.headquarters_city;
          if (val.headquarters_state_code) filled.headquarters_state_code = val.headquarters_state_code;
          if (val.headquarters_country) filled.headquarters_country = val.headquarters_country;
          if (val.headquarters_country_code) filled.headquarters_country_code = val.headquarters_country_code;
          field_statuses.headquarters = "ok";
        } else {
          field_statuses.headquarters = val.hq_status || "empty";
        }
        break;
      case "manufacturing":
        if (Array.isArray(val.manufacturing_locations) && val.manufacturing_locations.length > 0) {
          filled.manufacturing_locations = val.manufacturing_locations;
          field_statuses.manufacturing = "ok";
        } else {
          field_statuses.manufacturing = val.mfg_status || "empty";
        }
        break;
      case "industries":
        if (Array.isArray(val.industries) && val.industries.length > 0) {
          filled.industries = val.industries;
          field_statuses.industries = "ok";
        } else {
          field_statuses.industries = val.industries_status || "empty";
        }
        break;
      case "keywords":
        if (Array.isArray(val.product_keywords) && val.product_keywords.length > 0) {
          filled.product_keywords = val.product_keywords;
          field_statuses.keywords = "ok";
        } else if (Array.isArray(val.keywords) && val.keywords.length > 0) {
          filled.product_keywords = val.keywords;
          field_statuses.keywords = "ok";
        } else {
          field_statuses.keywords = val.keywords_status || "empty";
        }
        break;
      case "reviews":
        if (Array.isArray(val.curated_reviews) && val.curated_reviews.length > 0) {
          filled.reviews = val.curated_reviews;
          // Mark "ok" only when 5-review target met; "incomplete" saves partial
          // results while signaling resume worker that more reviews are needed.
          // Tiered: love 5, like 3, must have 1
          field_statuses.reviews = val.curated_reviews.length >= 1 ? "ok" : "incomplete";
        } else {
          field_statuses.reviews = val.reviews_stage_status || "empty";
        }
        break;
    }
  }

  console.log(`[fillMissingFieldsIndividually] Done: ${JSON.stringify(field_statuses)}, filled=[${Object.keys(filled).join(", ")}]`);
  return { filled, field_statuses };
}

/**
 * Main enrichment orchestrator.
 * Phase 1: Unified Grok prompt (single call, all fields)
 * Phase 2: Verify (review URLs, locations, etc.)
 * Phase 3: Fill missing fields with individual calls as fallback
 */
async function enrichCompanyFields({
  companyName,
  websiteUrl,
  normalizedDomain,
  budgetMs = 540000,
  xaiUrl,
  xaiKey,
  fieldsToEnrich,
  skipDedicatedDeepening = false,   // legacy — ignored by v3.0 pipeline
  dedicatedFieldsOnly,              // legacy — ignored by v3.0 pipeline
  onIntermediateSave,
  phase3BudgetCapMs,                // legacy — ignored by v3.0 pipeline
  retryHints,                       // { hadStructuredTimeout: boolean } — reduces structured timeout on retry cycles
  existingLogoUrl,                  // if non-null, skip logo in fetchLightFields (already captured by homepage scraper)
  signal,                           // Optional: AbortSignal — cancels in-flight xAI fetches when worker is orphaned
} = {}) {
  const started = Date.now();
  const getRemainingMs = () => Math.max(0, budgetMs - (Date.now() - started));
  const runId = Math.random().toString(36).slice(2, 8); // unique marker per invocation — distinguishes real runs from Azure log stream replays

  // Map long MANDATORY_ENRICH_FIELDS names → short findMissingFields names
  const FIELD_SHORT_TO_LONG = {
    tagline: "tagline", headquarters: "headquarters_location",
    manufacturing: "manufacturing_locations", industries: "industries",
    keywords: "product_keywords", reviews: "reviews",
    logo_url: "logo_url",
  };
  const LONG_TO_SHORT = {};
  for (const [short, long] of Object.entries(FIELD_SHORT_TO_LONG)) LONG_TO_SHORT[long] = short;

  const filterMissingByTarget = (missingShortNames) =>
    Array.isArray(fieldsToEnrich)
      ? missingShortNames.filter((short) => fieldsToEnrich.includes(FIELD_SHORT_TO_LONG[short] || short))
      : missingShortNames;

  const domain = normalizeDomain(normalizedDomain || websiteUrl);

  // ── Targeted refresh shortcut (≤2 specific fields) ──────────────────────
  // When only a few fields need refreshing, skip the full five-call pipeline
  // and use retryMissingStructuredFields or fetchCuratedReviews directly.
  // Location fields get routed to fetchHeadquartersLocation/fetchManufacturingLocations directly.
  const LOCATION_LONG_NAMES = new Set(["manufacturing_locations", "headquarters_location"]);
  const isLocationsOnly = Array.isArray(fieldsToEnrich) && fieldsToEnrich.length > 0 &&
    fieldsToEnrich.every((f) => LOCATION_LONG_NAMES.has(f));
  const hasDeepResearchField = Array.isArray(fieldsToEnrich) && fieldsToEnrich.some((f) => LOCATION_LONG_NAMES.has(f));
  const skipUnified = Array.isArray(fieldsToEnrich) && fieldsToEnrich.length > 0 && fieldsToEnrich.length <= 2 && !hasDeepResearchField;

  // ── Field ownership: each call "owns" specific fields ──────────────────
  // parseStructuredResponse() returns ALL fields (with empty defaults),
  // so without filtering, later calls overwrite earlier calls' real data.
  const LOCATION_OWNED_PARSED = [
    "headquarters_location", "manufacturing_locations", "location_source_urls",
    "headquarters_city", "headquarters_state_code", "headquarters_country", "headquarters_country_code",
  ];
  const LOCATION_OWNED_STATUSES = ["headquarters", "manufacturing"];

  const KEYWORD_OWNED_PARSED = ["product_keywords", "keywords_completeness", "keywords_incomplete_reason"];
  const KEYWORD_OWNED_STATUSES = ["keywords"];

  const LIGHT_OWNED_PARSED = ["tagline", "industries", "logo_url", "logo_source"];
  const LIGHT_OWNED_STATUSES = ["tagline", "industries", "logo_url"];

  // Remap short field_statuses names → long names for runDirectEnrichment()
  const STATUS_SHORT_TO_LONG = { headquarters: "headquarters_location", manufacturing: "manufacturing_locations", keywords: "product_keywords" };

  const pickKeys = (obj, keys) => {
    if (!obj || typeof obj !== "object") return {};
    const out = {};
    for (const k of keys) { if (k in obj) out[k] = obj[k]; }
    return out;
  };

  const remapFieldStatuses = (statuses) => {
    for (const [short, long] of Object.entries(STATUS_SHORT_TO_LONG)) {
      if (short in statuses && !(long in statuses)) {
        statuses[long] = statuses[short];
        delete statuses[short];
      }
    }
  };

  // ── Location-only shortcut: route directly to fetchLocationFields() ──
  if (isLocationsOnly) {
    console.log(`[enrichCompanyFields] Location-only refresh for [${fieldsToEnrich.join(", ")}], budget=${budgetMs}ms`);
    const locResult = await fetchLocationFields({
      companyName, websiteUrl, normalizedDomain: domain,
      budgetMs: Math.min(CALL_TIMEOUTS_MS.locations.max, getRemainingMs() - 5_000),
      xaiUrl, xaiKey,
    });
    const filled = {};
    const fld_statuses = {};
    if (locResult?.ok && locResult.parsed_fields) {
      Object.assign(filled, pickKeys(locResult.parsed_fields, LOCATION_OWNED_PARSED));
      Object.assign(fld_statuses, pickKeys(locResult.field_statuses, LOCATION_OWNED_STATUSES));
      remapFieldStatuses(fld_statuses);
    }
    if (typeof onIntermediateSave === "function" && Object.keys(filled).length > 0) {
      try { await onIntermediateSave(filled); } catch { /* best effort */ }
    }
    console.log(`[enrichCompanyFields] Location-only refresh done for "${companyName}": filled=[${Object.keys(filled).join(", ")}], elapsed=${Date.now() - started}ms`);
    return {
      ok: true,
      method: "location_direct",
      proposed: filled,
      field_statuses: fld_statuses,
      elapsed_ms: Date.now() - started,
      remaining_budget_ms: getRemainingMs(),
    };
  }

  if (skipUnified) {
    const targetShortNames = fieldsToEnrich.map((f) => LONG_TO_SHORT[f] || f).filter(Boolean);
    const hasReviews = targetShortNames.includes("reviews");
    const structuredShort = targetShortNames.filter((f) => f !== "reviews");

    console.log(`[enrichCompanyFields] Targeted refresh for [${fieldsToEnrich.join(", ")}], budget=${budgetMs}ms`);

    const promises = [];
    if (structuredShort.length > 0) {
      const retryMaxMs = retryHints?.hadStructuredTimeout ? 90_000 : (getRemainingMs() - 5000);
      promises.push(retryMissingStructuredFields({
        companyName, websiteUrl, normalizedDomain: domain,
        missingFields: structuredShort,
        budgetMs: Math.min(retryMaxMs, getRemainingMs() - 5000),
        xaiUrl, xaiKey,
      }).then((r) => ({ type: "structured", result: r })));
    }
    if (hasReviews) {
      promises.push(fetchCuratedReviews({
        companyName, normalizedDomain: domain,
        budgetMs: Math.min(TWO_CALL_TIMEOUTS_MS.reviews.max, getRemainingMs() - 5000),
        xaiUrl, xaiKey,
        browseAboutPage: !!retryHints?.browseAboutPage,
      }).then((r) => ({ type: "reviews", result: r })));
    }

    const settled = await Promise.allSettled(promises);
    const filled = {};
    const field_statuses = {};

    for (const s of settled) {
      if (s.status !== "fulfilled") continue;
      const { type, result } = s.value;
      if (type === "structured" && result.ok && result.parsed_fields) {
        for (const shortName of structuredShort) {
          const longName = FIELD_SHORT_TO_LONG[shortName] || shortName;
          if (result.parsed_fields[longName] !== undefined) {
            filled[longName] = result.parsed_fields[longName];
          }
          if (result.field_statuses[shortName]) {
            field_statuses[shortName] = result.field_statuses[shortName];
          }
        }
      } else if (type === "reviews" && result.curated_reviews) {
        filled.reviews = result.curated_reviews;
        field_statuses.reviews = result.reviews_stage_status || (result.curated_reviews.length > 0 ? "ok" : "empty");
      }
    }

    if (typeof onIntermediateSave === "function" && Object.keys(filled).length > 0) {
      try { await onIntermediateSave(filled); } catch { /* best effort */ }
    }

    remapFieldStatuses(field_statuses);
    console.log(`[enrichCompanyFields] Targeted refresh done for "${companyName}": filled=[${Object.keys(filled).join(", ")}], statuses=${JSON.stringify(field_statuses)}, elapsed=${Date.now() - started}ms`);
    return {
      ok: true,
      method: "targeted_direct",
      proposed: filled,
      field_statuses,
      elapsed_ms: Date.now() - started,
      remaining_budget_ms: getRemainingMs(),
    };
  }

  // ── Five-Call Split Pipeline (v5.0) ─────────────────────────────────────
  // Call 1: fetchHeadquartersLocation (HQ — standalone focused query)
  // Call 2: fetchManufacturingLocations (MFG — standalone focused query)
  // Call 3: fetchKeywordFields (product keywords — deep catalog browsing)
  // Call 4: fetchLightFields (tagline + industries + logo — quick homepage)
  // Call 5: fetchCuratedReviews (reviews with PRIMARY SUBJECT disambiguation)
  // All five fire in parallel via Promise.allSettled.
  //
  // v5.0 replaces the combined fetchLocationFields (240s timeout, frequent timeouts)
  // with two parallel standalone calls (~60s each). This cuts wall-clock from ~7 min to ~3 min.

  const wantLocations = !Array.isArray(fieldsToEnrich) || fieldsToEnrich.some((f) =>
    ["headquarters_location", "manufacturing_locations"].includes(f));
  const wantKeywords = !Array.isArray(fieldsToEnrich) || fieldsToEnrich.includes("product_keywords");
  const wantLight = !Array.isArray(fieldsToEnrich) || fieldsToEnrich.some((f) =>
    ["tagline", "industries", "logo", "logo_url"].includes(f));
  const wantReviews = !Array.isArray(fieldsToEnrich) || fieldsToEnrich.includes("reviews");
  const wantLogo = !Array.isArray(fieldsToEnrich) || fieldsToEnrich.includes("logo") || fieldsToEnrich.includes("logo_url");

  console.log(`[enrichCompanyFields] Five-call split for "${companyName}" (${domain}), budget=${budgetMs}ms, wantLocations=${wantLocations}, wantKeywords=${wantKeywords}, wantLight=${wantLight}, wantReviews=${wantReviews}, run=${runId}`);

  // Each promise saves its results to Cosmos immediately via onIntermediateSave,
  // so that if Azure DrainMode kills the process mid-flight, data from whichever
  // calls already completed is preserved. The post-merge save at the bottom
  // still runs (idempotent upsert via Object.assign).
  const earlySave = async (result, label, ownedParsedKeys) => {
    if (result?.ok && result.parsed_fields && typeof onIntermediateSave === "function") {
      try {
        // Only save the fields this call owns — prevents clobbering other calls' data
        const payload = ownedParsedKeys
          ? pickKeys(result.parsed_fields, ownedParsedKeys)
          : result.parsed_fields;
        await onIntermediateSave(payload);
        console.log(`[enrichCompanyFields] Early ${label} save OK, run=${runId}`);
      } catch (e) {
        console.warn(`[enrichCompanyFields] Early ${label} save failed: ${e?.message}, run=${runId}`);
      }
    }
    return result;
  };

  // ── HQ promise — standalone call with early save ──
  const hqStartedAt = Date.now();
  const hqPromise = wantLocations
    ? fetchHeadquartersLocation({
        companyName, normalizedDomain: domain,
        budgetMs: Math.min(CALL_TIMEOUTS_MS.locations.max, getRemainingMs() - 15_000),
        xaiUrl, xaiKey, signal,
      }).then(async (hqRaw) => {
        const hqLoc = asString(hqRaw?.headquarters_location).trim();
        const isOk = !!hqLoc && hqRaw?.hq_status !== "deferred";
        if (isOk && typeof onIntermediateSave === "function") {
          try {
            const payload = { headquarters_location: hqLoc };
            if (hqRaw.location_source_urls) payload.location_source_urls = hqRaw.location_source_urls;
            if (hqRaw.headquarters_city) payload.headquarters_city = hqRaw.headquarters_city;
            if (hqRaw.headquarters_state_code) payload.headquarters_state_code = hqRaw.headquarters_state_code;
            if (hqRaw.headquarters_country) payload.headquarters_country = hqRaw.headquarters_country;
            if (hqRaw.headquarters_country_code) payload.headquarters_country_code = hqRaw.headquarters_country_code;
            await onIntermediateSave(payload);
            console.log(`[enrichCompanyFields] Early HQ save OK, run=${runId}`);
          } catch (e) {
            console.warn(`[enrichCompanyFields] Early HQ save failed: ${e?.message}, run=${runId}`);
          }
        }
        if (hqRaw && typeof hqRaw === "object") hqRaw.elapsed_ms = Date.now() - hqStartedAt;
        return hqRaw;
      })
    : Promise.resolve(null);

  // ── MFG promise — standalone call with early save ──
  const mfgStartedAt = Date.now();
  const mfgPromise = wantLocations
    ? fetchManufacturingLocations({
        companyName, normalizedDomain: domain,
        budgetMs: Math.min(CALL_TIMEOUTS_MS.locations.max, getRemainingMs() - 15_000),
        xaiUrl, xaiKey, signal,
      }).then(async (mfgRaw) => {
        const mfgLocs = mfgRaw?.manufacturing_locations;
        const isOk = Array.isArray(mfgLocs) && mfgLocs.length > 0 && mfgRaw?.mfg_status !== "deferred";
        if (isOk && typeof onIntermediateSave === "function") {
          try {
            const payload = { manufacturing_locations: mfgLocs };
            if (mfgRaw.location_source_urls) payload.location_source_urls = mfgRaw.location_source_urls;
            await onIntermediateSave(payload);
            console.log(`[enrichCompanyFields] Early MFG save OK, run=${runId}`);
          } catch (e) {
            console.warn(`[enrichCompanyFields] Early MFG save failed: ${e?.message}, run=${runId}`);
          }
        }
        if (mfgRaw && typeof mfgRaw === "object") mfgRaw.elapsed_ms = Date.now() - mfgStartedAt;
        return mfgRaw;
      })
    : Promise.resolve(null);

  const keywordPromise = wantKeywords
    ? fetchKeywordFields({
        companyName, websiteUrl, normalizedDomain: domain,
        budgetMs: Math.min(CALL_TIMEOUTS_MS.keywords.max, getRemainingMs() - 15_000),
        xaiUrl, xaiKey, signal,
      }).then((r) => earlySave(r, "keywords", KEYWORD_OWNED_PARSED))
    : Promise.resolve(null);

  const skipLogo = !!existingLogoUrl;
  const lightPromise = wantLight
    ? fetchLightFields({
        companyName, websiteUrl, normalizedDomain: domain,
        budgetMs: Math.min(CALL_TIMEOUTS_MS.light.max, getRemainingMs() - 15_000),
        xaiUrl, xaiKey, signal,
        skipLogo,
      }).then((r) => earlySave(r, "light", LIGHT_OWNED_PARSED))
    : Promise.resolve(null);

  const reviewsStarted = Date.now();
  const reviewsPromise = wantReviews
    ? fetchCuratedReviews({
        companyName, normalizedDomain: domain,
        budgetMs: Math.min(CALL_TIMEOUTS_MS.reviews.max, getRemainingMs() - 15_000),
        xaiUrl, xaiKey, signal,
        browseAboutPage: !!retryHints?.browseAboutPage,
      }).then(async (result) => {
        if (result?.curated_reviews?.length > 0 && typeof onIntermediateSave === "function") {
          try {
            await onIntermediateSave({ reviews: result.curated_reviews });
            console.log(`[enrichCompanyFields] Early reviews save OK (${result.curated_reviews.length} reviews), run=${runId}`);
          } catch (e) {
            console.warn(`[enrichCompanyFields] Early reviews save failed: ${e?.message}, run=${runId}`);
          }
        }
        // Inject elapsed_ms for per-call breakdown logging
        if (result && typeof result === "object") result.elapsed_ms = Date.now() - reviewsStarted;
        return result;
      })
    : Promise.resolve(null);

  const [hqSettled, mfgSettled, kwSettled, lightSettled, revSettled] = await raceTimeout(
    Promise.allSettled([hqPromise, mfgPromise, keywordPromise, lightPromise, reviewsPromise]),
    budgetMs + 10_000,
    `enrichCompanyFields_five_call_split[${runId}]`
  ).catch((e) => {
    console.warn(`[enrichCompanyFields] Five-call split watchdog fired (${budgetMs + 10000}ms): ${e.message}, run=${runId}`);
    return [
      { status: "rejected", reason: e },
      { status: "rejected", reason: e },
      { status: "rejected", reason: e },
      { status: "rejected", reason: e },
      { status: "rejected", reason: e },
    ];
  });

  // ── Merge results (order: HQ → MFG → keywords → light → reviews) ──
  const hqResult = hqSettled.status === "fulfilled" ? hqSettled.value : null;
  const mfgResult = mfgSettled.status === "fulfilled" ? mfgSettled.value : null;
  const keywords = kwSettled.status === "fulfilled" ? kwSettled.value : null;
  const light = lightSettled.status === "fulfilled" ? lightSettled.value : null;
  const reviews = revSettled.status === "fulfilled" ? revSettled.value : null;

  // Log rejection reasons so promise crashes are diagnosable
  for (const [label, settled] of [["hq", hqSettled], ["mfg", mfgSettled], ["keywords", kwSettled], ["light", lightSettled], ["reviews", revSettled]]) {
    if (settled.status === "rejected") {
      console.error(`[enrichCompanyFields] ${label} promise REJECTED: ${settled.reason?.message || String(settled.reason)}, run=${runId}`);
    }
  }

  // Per-call elapsed breakdown for performance diagnostics
  const callElapsed = {
    hq:        hqResult?.elapsed_ms ?? (hqSettled.status === "rejected" ? "rejected" : "(n/a)"),
    mfg:       mfgResult?.elapsed_ms ?? (mfgSettled.status === "rejected" ? "rejected" : "(n/a)"),
    keywords:  keywords?.elapsed_ms ?? (kwSettled.status === "rejected" ? "rejected" : "(n/a)"),
    light:     light?.elapsed_ms ?? (lightSettled.status === "rejected" ? "rejected" : "(n/a)"),
    reviews:   reviews?.elapsed_ms ?? (revSettled.status === "rejected" ? "rejected" : "(n/a)"),
  };
  console.log(`[enrichCompanyFields] call_elapsed`, callElapsed, `run=${runId}`);

  let proposed = {};
  let field_statuses = {};

  // Merge HQ result (standalone shape → proposed)
  const hqLoc = asString(hqResult?.headquarters_location).trim();
  if (hqLoc) {
    proposed.headquarters_location = hqLoc;
    field_statuses.headquarters = hqResult.hq_status || "ok";
    if (hqResult.location_source_urls?.hq_source_urls) {
      if (!proposed.location_source_urls) proposed.location_source_urls = {};
      proposed.location_source_urls.hq_source_urls = hqResult.location_source_urls.hq_source_urls;
    }
    // Geo sub-fields from state abbreviation inference
    if (hqResult.headquarters_city) proposed.headquarters_city = hqResult.headquarters_city;
    if (hqResult.headquarters_state_code) proposed.headquarters_state_code = hqResult.headquarters_state_code;
    if (hqResult.headquarters_country) proposed.headquarters_country = hqResult.headquarters_country;
    if (hqResult.headquarters_country_code) proposed.headquarters_country_code = hqResult.headquarters_country_code;
  }

  // Merge MFG result (standalone shape → proposed)
  if (mfgResult?.manufacturing_locations?.length > 0) {
    proposed.manufacturing_locations = mfgResult.manufacturing_locations;
    field_statuses.manufacturing = mfgResult.mfg_status || "ok";
    if (mfgResult.location_source_urls?.mfg_source_urls) {
      if (!proposed.location_source_urls) proposed.location_source_urls = {};
      proposed.location_source_urls.mfg_source_urls = mfgResult.location_source_urls.mfg_source_urls;
    }
  } else if (mfgResult?.mfg_status) {
    // Preserve status even when empty (e.g. "not_applicable" for retailers) to prevent pointless retries
    field_statuses.manufacturing = mfgResult.mfg_status;
  }

  // ── Location retry ──
  // If either standalone call failed (timeout/error), retry individually.
  // Cap retry budgets to reserve ≥150s for downstream work
  // (reviews browseAboutPage fallback ~120s + logo verification ~30s).
  const DOWNSTREAM_RESERVE_MS = 150_000;

  const needHqRetry = wantLocations && !proposed.headquarters_location;
  // Skip MFG retry if Grok explicitly said "not_applicable" (retailer/marketplace)
  // Also skip if initial MFG call timed out — a second try won't find data that 118.8s couldn't
  const mfgExplicitlyEmpty = field_statuses.manufacturing === "not_applicable" || field_statuses.manufacturing === "not_disclosed";
  const mfgTimedOut = field_statuses.manufacturing === "upstream_timeout";
  const needMfgRetry = wantLocations && !(proposed.manufacturing_locations?.length > 0) && !mfgExplicitlyEmpty && !mfgTimedOut;
  if (mfgTimedOut && !(proposed.manufacturing_locations?.length > 0)) {
    console.log(`[enrichCompanyFields] Skipping MFG retry (initial timed out — back off and move on), run=${runId}`);
  }

  if ((needHqRetry || needMfgRetry)
      && getRemainingMs() > CALL_TIMEOUTS_MS.locations.min + DOWNSTREAM_RESERVE_MS) {
    const locationRetryBudget = getRemainingMs() - DOWNSTREAM_RESERVE_MS;
    console.log(`[enrichCompanyFields] Location retry needed (hq=${needHqRetry}, mfg=${needMfgRetry}), budget_remaining=${getRemainingMs()}ms, locationRetryBudget=${locationRetryBudget}ms, run=${runId}`);

    const retryStarted = Date.now();

    if (needHqRetry) {
      const hqRetry = await fetchHeadquartersLocation({
        companyName, normalizedDomain: domain,
        budgetMs: Math.min(CALL_TIMEOUTS_MS.locations.max, needMfgRetry ? locationRetryBudget / 2 : locationRetryBudget),
        xaiUrl, xaiKey,
      });
      const hqElapsed = Date.now() - retryStarted;
      const retryHqLoc = asString(hqRetry?.headquarters_location).trim();

      if (retryHqLoc) {
        proposed.headquarters_location = retryHqLoc;
        field_statuses.headquarters = hqRetry.hq_status || "ok";
        if (hqRetry.location_source_urls?.hq_source_urls) {
          if (!proposed.location_source_urls) proposed.location_source_urls = {};
          proposed.location_source_urls.hq_source_urls = hqRetry.location_source_urls.hq_source_urls;
        }
        if (hqRetry.headquarters_city) proposed.headquarters_city = hqRetry.headquarters_city;
        if (hqRetry.headquarters_state_code) proposed.headquarters_state_code = hqRetry.headquarters_state_code;
        if (hqRetry.headquarters_country) proposed.headquarters_country = hqRetry.headquarters_country;
        if (hqRetry.headquarters_country_code) proposed.headquarters_country_code = hqRetry.headquarters_country_code;
        console.log(`[enrichCompanyFields] HQ retry SUCCESS: "${retryHqLoc}", elapsed=${hqElapsed}ms, run=${runId}`);
      } else {
        console.log(`[enrichCompanyFields] HQ retry empty (status=${hqRetry?.hq_status}), elapsed=${hqElapsed}ms, run=${runId}`);
      }
    }

    if (needMfgRetry) {
      const mfgBudget = Math.max(0, locationRetryBudget - (Date.now() - retryStarted));
      if (mfgBudget > CALL_TIMEOUTS_MS.locations.min) {
        const mfgRetryStarted = Date.now();
        const mfgRetry2 = await fetchManufacturingLocations({
          companyName, normalizedDomain: domain,
          budgetMs: Math.min(CALL_TIMEOUTS_MS.locations.max, mfgBudget),
          xaiUrl, xaiKey,
        });
        const mfgElapsed2 = Date.now() - mfgRetryStarted;

        if (mfgRetry2?.manufacturing_locations?.length > 0) {
          proposed.manufacturing_locations = mfgRetry2.manufacturing_locations;
          field_statuses.manufacturing = mfgRetry2.mfg_status || "ok";
          if (mfgRetry2.location_source_urls?.mfg_source_urls) {
            if (!proposed.location_source_urls) proposed.location_source_urls = {};
            proposed.location_source_urls.mfg_source_urls = mfgRetry2.location_source_urls.mfg_source_urls;
          }
          console.log(`[enrichCompanyFields] MFG retry SUCCESS: ${JSON.stringify(mfgRetry2.manufacturing_locations)}, elapsed=${mfgElapsed2}ms, run=${runId}`);
        } else {
          console.log(`[enrichCompanyFields] MFG retry empty (status=${mfgRetry2?.mfg_status}), elapsed=${mfgElapsed2}ms, run=${runId}`);
        }
      } else {
        console.log(`[enrichCompanyFields] MFG retry skipped (mfgBudget=${mfgBudget}ms < min=${CALL_TIMEOUTS_MS.locations.min}ms), preserving budget for downstream, run=${runId}`);
      }
    }

    // Early save retry results
    if (Object.keys(proposed).length > 0 && typeof onIntermediateSave === "function") {
      try { await onIntermediateSave(proposed); }
      catch (e) { console.warn(`[enrichCompanyFields] Location retry save failed: ${e?.message}, run=${runId}`); }
    }
  }

  // ── MFG country-only refinement ──
  // If MFG locations are all country-level (e.g. "USA") and budget allows,
  // fire a focused refinement call to get city-level precision.
  const mfgLocs = proposed.manufacturing_locations;
  if (Array.isArray(mfgLocs) && mfgLocs.length > 0
      && mfgLocs.every(isCountryOnlyLocation)
      && getRemainingMs() > CALL_TIMEOUTS_MS.locations.min + 15_000) {
    console.log(`[enrichCompanyFields] MFG country-only detected (${JSON.stringify(mfgLocs)}), attempting refinement, budget_remaining=${getRemainingMs()}ms, run=${runId}`);
    const mfgStarted = Date.now();
    const mfgRetry = await fetchManufacturingLocations({
      companyName, normalizedDomain: domain,
      budgetMs: Math.min(CALL_TIMEOUTS_MS.locations.max, getRemainingMs() - 15_000),
      xaiUrl, xaiKey,
    });
    const mfgElapsed = Date.now() - mfgStarted;

    if (mfgRetry?.manufacturing_locations?.length > 0
        && !mfgRetry.manufacturing_locations.every(isCountryOnlyLocation)) {
      proposed.manufacturing_locations = mfgRetry.manufacturing_locations;
      // Carry over source URLs if available
      if (mfgRetry.location_source_urls?.mfg_source_urls) {
        if (!proposed.location_source_urls) proposed.location_source_urls = {};
        proposed.location_source_urls.mfg_source_urls = mfgRetry.location_source_urls.mfg_source_urls;
      }
      console.log(`[enrichCompanyFields] MFG refinement SUCCESS: ${JSON.stringify(mfgRetry.manufacturing_locations)}, elapsed=${mfgElapsed}ms, run=${runId}`);
    } else {
      console.log(`[enrichCompanyFields] MFG refinement no improvement (still country-only or empty), elapsed=${mfgElapsed}ms, run=${runId}`);
    }
  }

  // Merge keyword fields (only owned: product_keywords, completeness, incomplete_reason)
  if (keywords?.ok && keywords.parsed_fields) {
    Object.assign(proposed, pickKeys(keywords.parsed_fields, KEYWORD_OWNED_PARSED));
    Object.assign(field_statuses, pickKeys(keywords.field_statuses, KEYWORD_OWNED_STATUSES));
  } else if (keywords?.error_code) {
    // Propagate failure status so downstream knows WHY keywords are missing (not just "unknown")
    field_statuses.keywords = keywords.error_code;
  }

  // ── Keyword retry on timeout ──
  // Keywords should always exist for product companies. Unlike MFG (where data may
  // genuinely not exist), a timeout here means XAI was slow, not that there's no data.
  // Use a shorter budget on retry — if 180s wasn't enough, give it one focused 90s shot.
  const keywordsTimedOut = !keywords?.ok && keywords?.error_code === "upstream_timeout";
  const keywordRetryBudget = getRemainingMs();
  const canRetryKeywords = wantKeywords && keywordsTimedOut
    && keywordRetryBudget > CALL_TIMEOUTS_MS.keywords.min + 15_000;

  if (keywordsTimedOut && !canRetryKeywords) {
    console.log(`[enrichCompanyFields] Skipping keywords retry (budget=${keywordRetryBudget}ms < min=${CALL_TIMEOUTS_MS.keywords.min + 15_000}ms), run=${runId}`);
  }

  if (canRetryKeywords) {
    console.log(`[enrichCompanyFields] Keywords timed out, retrying with shorter budget, budget_remaining=${keywordRetryBudget}ms, run=${runId}`);
    const kwRetryStarted = Date.now();
    const kwRetry = await fetchKeywordFields({
      companyName, websiteUrl, normalizedDomain: domain,
      budgetMs: Math.min(CALL_TIMEOUTS_MS.keywords.min, keywordRetryBudget - 15_000),
      xaiUrl, xaiKey, signal,
    });
    const kwRetryElapsed = Date.now() - kwRetryStarted;

    if (kwRetry?.ok && kwRetry.parsed_fields) {
      Object.assign(proposed, pickKeys(kwRetry.parsed_fields, KEYWORD_OWNED_PARSED));
      Object.assign(field_statuses, pickKeys(kwRetry.field_statuses, KEYWORD_OWNED_STATUSES));
      console.log(`[enrichCompanyFields] Keywords retry SUCCESS: ${kwRetry.parsed_fields?.product_keywords?.length || 0} keywords, elapsed=${kwRetryElapsed}ms, run=${runId}`);
      if (typeof onIntermediateSave === "function") {
        try { await onIntermediateSave(pickKeys(kwRetry.parsed_fields, KEYWORD_OWNED_PARSED)); }
        catch (e) { console.warn(`[enrichCompanyFields] Keywords retry save failed: ${e?.message}, run=${runId}`); }
      }
    } else {
      console.log(`[enrichCompanyFields] Keywords retry also failed (${kwRetry?.error_code || "unknown"}), elapsed=${kwRetryElapsed}ms, run=${runId}`);
    }
  }

  // Merge light fields (only owned: tagline, industries, logo_url, logo_source)
  if (light?.ok && light.parsed_fields) {
    Object.assign(proposed, pickKeys(light.parsed_fields, LIGHT_OWNED_PARSED));
    Object.assign(field_statuses, pickKeys(light.field_statuses, LIGHT_OWNED_STATUSES));
  }

  // Merge reviews
  if (reviews?.curated_reviews?.length > 0) {
    proposed.reviews = reviews.curated_reviews;
    field_statuses.reviews = reviews.reviews_stage_status || "ok";

    // If first attempt found 1-2 reviews ("incomplete") and budget allows,
    // supplement with browseAboutPage to add a website review
    if (field_statuses.reviews === "incomplete"
        && !retryHints?.browseAboutPage
        && getRemainingMs() > CALL_TIMEOUTS_MS.reviews.min + 15_000) {
      const incReason = reviews?.diagnostics?.reason || "insufficient_verified_reviews";
      console.log(`[enrichCompanyFields] Reviews incomplete (${proposed.reviews.length} found, reason=${incReason}), supplementing with browseAboutPage, budget_remaining=${getRemainingMs()}ms, run=${runId}`);
      const retryStarted = Date.now();
      const retryResult = await fetchCuratedReviews({
        companyName, normalizedDomain: domain,
        budgetMs: Math.min(CALL_TIMEOUTS_MS.reviews.max, getRemainingMs() - 15_000),
        xaiUrl, xaiKey,
        browseAboutPage: true,
      });
      const retryElapsed = Date.now() - retryStarted;

      if (retryResult?.curated_reviews?.length > 0) {
        const existingUrls = new Set(proposed.reviews.map(r => r?.source_url).filter(Boolean));
        const newReviews = retryResult.curated_reviews.filter(r => !existingUrls.has(r?.source_url));
        proposed.reviews = proposed.reviews.concat(newReviews);
        console.log(`[enrichCompanyFields] browseAboutPage supplement SUCCESS: +${newReviews.length} new (total=${proposed.reviews.length}), elapsed=${retryElapsed}ms, run=${runId}`);
      } else {
        console.log(`[enrichCompanyFields] browseAboutPage supplement empty, elapsed=${retryElapsed}ms, run=${runId}`);
      }
      // Accept whatever total we have — browseAboutPage is best-effort supplement
      field_statuses.reviews = "ok";

      if (proposed.reviews.length > 0 && typeof onIntermediateSave === "function") {
        try { await onIntermediateSave({ reviews: proposed.reviews }); }
        catch (e) { console.warn(`[enrichCompanyFields] Supplemented reviews save failed: ${e?.message}, run=${runId}`); }
      }
    }
  } else if (wantReviews) {
    const reviewReason = reviews?.diagnostics?.reason || reviews?.reviews_stage_status || "unknown";
    const reviewsTimedOut = reviews?.reviews_stage_status === "upstream_timeout";
    const retryBudget = getRemainingMs();
    const canRetry = !retryHints?.browseAboutPage   // prevent double-retry
      && !reviewsTimedOut                            // if XAI timed out, retry won't help — back off and move on
      && retryBudget > CALL_TIMEOUTS_MS.reviews.min + 15_000;  // need 90s+15s = 105s minimum

    if (reviewsTimedOut) {
      proposed.reviews = [];
      field_statuses.reviews = "upstream_timeout";
      console.log(`[enrichCompanyFields] Skipping reviews browseAboutPage retry (initial timed out — back off and move on), run=${runId}`);
    } else if (canRetry) {
      console.log(`[enrichCompanyFields] Reviews empty (reason=${reviewReason}), attempting browseAboutPage retry, budget_remaining=${retryBudget}ms, run=${runId}`);
      const retryStarted = Date.now();
      const retryResult = await fetchCuratedReviews({
        companyName, normalizedDomain: domain,
        budgetMs: Math.min(CALL_TIMEOUTS_MS.reviews.max, retryBudget - 15_000),
        xaiUrl, xaiKey,
        browseAboutPage: true,
      });
      const retryElapsed = Date.now() - retryStarted;

      if (retryResult?.curated_reviews?.length > 0) {
        proposed.reviews = retryResult.curated_reviews;
        // browseAboutPage is our last-resort retry — accept any reviews found (even 1).
        // Don't pass through "incomplete" from fetchCuratedReviews (which wants 3+),
        // or isRealValue will treat reviews as missing and trigger re-enrichment.
        field_statuses.reviews = "ok";
        console.log(`[enrichCompanyFields] browseAboutPage retry SUCCESS: ${retryResult.curated_reviews.length} reviews, elapsed=${retryElapsed}ms, run=${runId}`);
        // Early save the retry reviews
        if (typeof onIntermediateSave === "function") {
          try {
            await onIntermediateSave({ reviews: retryResult.curated_reviews });
          } catch (e) {
            console.warn(`[enrichCompanyFields] Retry reviews save failed: ${e?.message}, run=${runId}`);
          }
        }
      } else {
        proposed.reviews = [];
        field_statuses.reviews = retryResult?.reviews_stage_status || "empty";
        console.log(`[enrichCompanyFields] browseAboutPage retry also empty, elapsed=${retryElapsed}ms, run=${runId}`);
      }
    } else {
      proposed.reviews = [];
      field_statuses.reviews = reviews?.reviews_stage_status || "empty";
      console.log(`[enrichCompanyFields] Reviews empty for "${companyName}": status=${field_statuses.reviews}, reason=${reviewReason}, canRetry=false (alreadyBrowsed=${!!retryHints?.browseAboutPage}, budget=${retryBudget}ms), run=${runId}`);
    }
  }

  // Remap short field_statuses names → long names for runDirectEnrichment()
  remapFieldStatuses(field_statuses);

  // ── Intermediate save after all calls merged ──
  if (typeof onIntermediateSave === "function" && Object.keys(proposed).length > 0) {
    try {
      await onIntermediateSave(proposed);
      console.log(`[enrichCompanyFields] Intermediate save after five-call merge complete`);
    } catch (e) {
      console.warn(`[enrichCompanyFields] Intermediate save failed: ${e?.message}`);
    }
  }

  // ── Verify logo URL from light call ──
  if (wantLogo) {
    if (!proposed.logo_url) {
      console.log(`[enrichCompanyFields] Logo extraction: Grok returned no logo URL for "${companyName}", will try homepage scraper, run=${runId}`);
    }
    if (proposed.logo_url) {
      const logoCheck = await verifyLogoUrl(proposed.logo_url);
      if (!logoCheck.ok) {
        console.log(`[enrichCompanyFields] Logo URL verification failed for "${companyName}": ${logoCheck.reason} — clearing, run=${runId}`);
        proposed.logo_url = null;
        field_statuses.logo_url = `url_dead_${logoCheck.reason}`;
      }
    }

    // ── Homepage scraper fallback for logo ──
    if (!proposed.logo_url && getRemainingMs() > 15_000) {
      try {
        console.log(`[enrichCompanyFields] Logo fallback: trying homepage scraper for "${companyName}", remaining=${getRemainingMs()}ms, run=${runId}`);
        const scraperResult = await discoverLogoSourceUrl(
          { domain, websiteUrl, companyName },
          console,
          { budgetMs: Math.min(12_000, getRemainingMs() - 5_000) },
        );
        if (scraperResult?.ok && scraperResult.logo_source_url) {
          const scraperCheck = await verifyLogoUrl(scraperResult.logo_source_url);
          if (scraperCheck.ok) {
            proposed.logo_url = scraperResult.logo_source_url;
            proposed.logo_source = scraperResult.strategy || "homepage_scraper";
            field_statuses.logo_url = "ok";
            console.log(`[enrichCompanyFields] Logo fallback SUCCESS: url=${scraperResult.logo_source_url}, strategy=${scraperResult.strategy}, run=${runId}`);
          } else {
            console.log(`[enrichCompanyFields] Logo fallback: scraped URL also dead (${scraperCheck.reason}), run=${runId}`);
          }
        } else {
          console.log(`[enrichCompanyFields] Logo fallback: homepage scraper found nothing, run=${runId}`);
        }
      } catch (e) {
        console.warn(`[enrichCompanyFields] Logo fallback error: ${e?.message || e}, run=${runId}`);
      }
    }
  } else {
    delete proposed.logo_url;
    delete proposed.logo_source;
  }

  // No retry round: each dedicated call includes full field guidance.
  // If xAI couldn't find a field with thorough focused search, repeating won't help.
  // Admin reviews each company and can refresh individual missing fields.

  const totalElapsed = Date.now() - started;
  const missingAtEnd = Object.entries(field_statuses).filter(([, v]) => v !== "ok").map(([k, v]) => `${k}=${v}`);
  console.log(`[enrichCompanyFields] Done for "${companyName}" (${domain}). reviews=${Array.isArray(proposed.reviews) ? proposed.reviews.length : 0}, logo=${field_statuses.logo_url || "n/a"}, missing=[${missingAtEnd.join(", ")}], elapsed=${totalElapsed}ms, run=${runId}`);
  console.log(`[enrichCompanyFields] field_statuses`, field_statuses);

  return {
    ok: true,
    method: "five_call_split",
    proposed,
    raw_response: light?.raw_response_text || "",
    field_statuses,
    elapsed_ms: totalElapsed,
    reviews_attempted_urls: reviews?.attempted_urls || [],
  };
}

module.exports = {
  DEFAULT_REVIEW_EXCLUDE_DOMAINS,
  fetchCuratedReviews,
  // @deprecated v3.0 — individual fetchers replaced by fetchStructuredFields()
  fetchHeadquartersLocation,
  fetchManufacturingLocations,
  fetchTagline,
  fetchIndustries,
  fetchProductKeywords,
  fetchLogo,
  // @deprecated v3.0 — replaced by fetchStructuredFields() + retryMissingStructuredFields()
  fetchAllFieldsUnified,
  fillMissingFieldsIndividually,
  // Five-call split pipeline (v5.0) — HQ + MFG + keywords + light + reviews
  fetchLocationFields,  // @deprecated v5.0 — replaced by fetchHeadquartersLocation + fetchManufacturingLocations
  fetchKeywordFields,
  fetchLightFields,
  // @deprecated v4.0 — replaced by fetchLocationFields + fetchKeywordFields + fetchLightFields
  fetchStructuredFields,
  retryMissingStructuredFields,
  parseStructuredResponse,
  verifyLogoUrl,
  // Enrichment orchestrator
  verifyEnrichmentFields,
  enrichCompanyFields,
  // Helpers for location normalization
  normalizeLocationWithStateAbbrev,
  normalizeCountryInLocation,
  inferCountryFromStateAbbreviation,
  // Admin refresh bypass flag
  setAdminRefreshBypass,
  isAdminRefreshBypass,
};
