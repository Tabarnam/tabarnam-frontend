// api/_grokEnrichment.js
// Overwrite file

const { xaiLiveSearch, extractTextFromXaiResponse } = require("./_xaiLiveSearch");
const { extractJsonFromText } = require("./_curatedReviewsXai");
const { buildSearchParameters } = require("./_buildSearchParameters");

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
      country: "United States",
      country_code: "US",
      // Use abbreviation (MO) in formatted string for display, not full name (Missouri)
      formatted: `${city.trim()}, ${codeUpper}, United States`
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

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return Math.max(min, Math.min(max, i));
}

// XAI stage timeout max: generous to allow deep, accurate XAI searches (3-5+ minutes per field).
function resolveXaiStageTimeoutMaxMs(fallback = 300_000) {
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

async function xaiLiveSearchWithRetry({ maxAttempts = 2, baseBackoffMs = 350, ...args } = {}) {
  const attempts = Math.max(1, Math.min(3, Math.trunc(Number(maxAttempts) || 2)));

  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await xaiLiveSearch({ ...args, attempt: i });
    if (last && last.ok) return last;

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
} = {}) {
  const rem = Number.isFinite(Number(remainingMs)) ? Number(remainingMs) : 0;
  const min = clampInt(minMs, { min: 250, max: 600_000, fallback: 2_500 });
  const max = clampInt(maxMs, { min, max: 600_000, fallback: resolveXaiStageTimeoutMaxMs() });
  const safety = clampInt(safetyMarginMs, { min: 0, max: 20_000, fallback: 1_200 });

  const raw = Math.max(0, Math.trunc(rem - safety));
  return Math.max(min, Math.min(max, raw));
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

async function verifyUrlReachable(url, { timeoutMs = 8000, soft404Bytes = 12_000 } = {}) {
  const attempted = safeUrl(url);
  if (!attempted) return { ok: false, url: attempted, status: 0, reason: "empty_url" };

  // HEAD first, but many sites block it.
  try {
    const headRes = await fetchWithTimeout(attempted, { method: "HEAD", timeoutMs });
    const status = Number(headRes.status || 0) || 0;
    if (status >= 200 && status < 300) {
      return { ok: true, url: attempted, status };
    }
    // Fall through to GET.
  } catch {
    // ignore and fall back to GET
  }

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
    const soft404 =
      !isTrustedBlog &&
      ((title && /\b(404|not found|page not found)\b/i.test(title)) ||
        /\b(404|page not found|sorry, we can\s*'t find)\b/i.test(head));

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
} = {}) {
  const started = Date.now();

  const name = asString(companyName).trim();
  const domain = normalizeDomain(normalizedDomain);

  const cacheKey = domain ? `reviews:${domain}` : "";
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

  const excludeDomains = normalizeExcludeDomains({ normalizedDomain: domain });

  const websiteUrlForPrompt = domain ? `https://${domain}` : "";

  // Declarative review prompt: ask for what we want, let Grok decide how to find it.
  // Client-side verification (URL reachability + YouTube oEmbed) provides a safety net.
  const attemptedExclusion = Array.isArray(attempted_urls) && attempted_urls.length > 0
    ? `\nPREVIOUSLY TRIED URLs (all failed verification — do NOT return any of these):\n${attempted_urls.map((u) => `- ${u}`).join("\n")}\nFind DIFFERENT sources instead.\n`
    : "";

  const prompt = `Find 5 real, publicly accessible third-party reviews of ${name} (${websiteUrlForPrompt || "(unknown website)"}).

Requirements:
- Each review must have a working URL to a specific article, video, or post
- Reviews must be about ${name} or its products (not just mentioning the company in passing)
- Prefer a mix of sources: YouTube videos, magazine articles, blog posts, news articles
- Do not return any URL that is broken, paywalled, or deleted
- Do not return reviews from: ${excludeDomains.join(", ")}
- If you can only find 3 verified reviews, return 3 — quality over quantity
${attemptedExclusion}
For each review, output in this exact plain-text format. Separate reviews with one blank line. No markdown.

Source: [publication or channel name]
Author: [author or channel name]
URL: [direct URL to the review article/video/post]
Title: [exact title as published]
Date: [publication date, any format]
Text: [1-3 sentence excerpt or summary of the review]`.trim();

  const stageTimeout = XAI_STAGE_TIMEOUTS_MS.reviews;

  // Budget clamp: if we can't safely run another upstream call, defer without terminalizing.
  // Skip budget check when test stub is active (allows tests with small budgets).
  const hasStub = globalThis && typeof globalThis.__xaiLiveSearchStub === "function";
  const remaining = budgetMs - (Date.now() - started);
  const minRequired = Math.min(stageTimeout.min + 1_200, RESUME_MIN_BUDGET_MS);
  console.log(`[grokEnrichment] fetchCuratedReviews: budgetMs=${budgetMs}, remaining=${remaining}, minRequired=${minRequired}, hasStub=${hasStub}`);
  if (!hasStub) {
    if (remaining < minRequired) {
      console.log(`[grokEnrichment] fetchCuratedReviews: DEFERRED - remaining (${remaining}) < minRequired (${minRequired})`);
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

  const searchBuild = buildSearchParameters({
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
    }),
    maxTokens: 2000,  // Increased to accommodate excerpts in response
    model: asString(model).trim() || "grok-4-latest",
    xaiUrl,
    xaiKey,
    search_parameters: searchBuild.search_parameters,
  });

  if (!r.ok) {
    const failure = classifyXaiFailure(r);
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

  // Parse response — try plain-text format first (Source:/Author:/URL:), fall back to JSON.
  const rawText = asString(extractTextFromXaiResponse(r.resp));
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
        title: getField("Title") || null,
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
    return {
      curated_reviews: [],
      reviews_stage_status: "invalid_response",
      diagnostics: {
        reason: "no_parseable_reviews",
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
      return {
        source_url: url,
        category,
        // Capture XAI-provided metadata for fallback
        source_name: asString(x.source_name || "").trim() || null,
        title: asString(x.title || "").trim() || null,
        excerpt: asString(x.excerpt || "").trim() || null,
      };
    })
    .filter((x) => x.source_url)
    .filter((x) => !excludeDomains.some((d) => x.source_url.includes(d)));

  if (candidates.length === 0) {
    const value = {
      curated_reviews: [],
      reviews_stage_status: "not_found",
      diagnostics: { candidate_count: 0, verified_count: 0 },
      search_telemetry: searchBuild.telemetry,
      excluded_hosts: searchBuild.excluded_hosts,
    };
    // Don't cache 0-candidate results — resume worker should retry with fresh XAI call
    return value;
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
    if (
      !isYT &&
      host &&
      usedHosts.has(host) &&
      deduped.some((x) => normalizeHostForDedupe(urlHost(x.source_url)) !== host)
    ) {
      continue;
    }

    this_attempt_urls.push(c.source_url);
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
      console.log(`[grokEnrichment] reviews: URL failed verification: ${c.source_url} (${verified.reason})`);
      continue;
    }

    // Use Grok-provided metadata; fall back to HTML meta only for missing fields
    const html = typeof verified.html_preview === "string" ? verified.html_preview : "";
    const meta = html ? buildReviewMetadataFromHtml(c.source_url, html) : {};

    verified_reviews.push({
      source_name: isYouTubeUrl(c.source_url) ? "YouTube" : (c.source_name || meta.source_name || null),
      author: c.source_name || meta.author || null,
      source_url: verified.final_url || c.source_url,
      title: c.title || meta.title || null,
      date: meta.date || null,
      excerpt: c.excerpt || meta.excerpt || null,
    });
    if (host) usedHosts.add(host);
  }

  const curated_reviews = verified_reviews.slice(0, 5);
  const youtubeCount = curated_reviews.filter((r) => isYouTubeUrl(r?.source_url)).length;
  const blogCount = curated_reviews.length - youtubeCount;

  // Lowered from 5 to 3: aligns with resume-worker threshold (handler.js line 2436)
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
        blog_verified: blogCount,
        exhausted: isExhausted,
      },
      search_telemetry: searchBuild.telemetry,
      excluded_hosts: searchBuild.excluded_hosts,
    };
    if (cacheKey && curated_reviews.length > 0) writeStageCache(cacheKey, value);
    return value;
  }

  const value = {
    curated_reviews,
    reviews_stage_status: "ok",
    diagnostics: {
      candidate_count: candidates.length,
      verified_count: curated_reviews.length,
      youtube_verified: youtubeCount,
      blog_verified: blogCount,
    },
    attempted_urls: this_attempt_urls,
    search_telemetry: searchBuild.telemetry,
    excluded_hosts: searchBuild.excluded_hosts,
  };
  if (cacheKey) writeStageCache(cacheKey, value);
  return value;
}

async function fetchHeadquartersLocation({ companyName, normalizedDomain, budgetMs = 20000, xaiUrl, xaiKey } = {}) {
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

  const prompt = `For the company ${name} (${websiteUrlForPrompt || "(unknown website)"}) determine the headquarters location.

Task: Determine the company's HEADQUARTERS location.

Rules:
- Conduct thorough research. Cross-reference multiple sources.
- Use web search (do not rely only on the company website).
- Check LinkedIn, SEC filings, Crunchbase, official press releases, business registrations, state corporation records.
- Do deep dives for HQ location if necessary.
- Having the actual city is crucial — do not return just the state or country if city-level data exists.
- Use initials for state or province (e.g., "Austin, TX" not "Austin, Texas").
- Format: "City, ST" for US/Canada, "City, Country" for international.
- If only country is known, return "Country".
- No explanatory info – just the location.
- No guessing or hallucinating. Only report verified information.
- Output STRICT JSON only.

Return:
{
  "headquarters_location": "...",
  "location_source_urls": { "hq_source_urls": ["https://...", "https://..."] }
}
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
    }),
    maxTokens: 300,
    model: resolveSearchModel(),
    xaiUrl,
    xaiKey,
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

  // Infer country from US state or Canadian province abbreviation (e.g., "Chicago, IL" → "Chicago, IL, United States")
  const inferred = inferCountryFromStateAbbreviation(value);
  const valueOut = {
    headquarters_location: inferred ? inferred.formatted : value,
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

async function fetchManufacturingLocations({ companyName, normalizedDomain, budgetMs = 20000, xaiUrl, xaiKey } = {}) {
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

  const prompt = `For the company ${name} (${websiteUrlForPrompt || "(unknown website)"}) determine the manufacturing locations.

Task: Identify ALL known MANUFACTURING locations for this company worldwide.

Rules:
- Conduct thorough research to identify ALL known manufacturing locations worldwide.
- Include every city and country found. Deep-dive on any US sites to confirm actual cities.
- Check press releases, job postings, facility announcements, regulatory filings, news articles, LinkedIn.
- List them exhaustively without missing any.
- Having the actual cities within the United States is crucial. Be accurate.
- Use initials for state or province (e.g., "Los Angeles, CA" not "Los Angeles, California").
- Format: "City, ST" for US/Canada, "City, Country" for international.
- Return an array of one or more locations. Include multiple cities when applicable.
- If only country-level is available, country-only entries are acceptable.
- No explanatory info – just locations.
- If manufacturing is not publicly disclosed after thorough searching, return ["Not disclosed"].
- Provide the supporting URLs you used for the manufacturing determination.
- No guessing or hallucinating. Only report verified information.
- Output STRICT JSON only.

Return:
{
  "manufacturing_locations": ["City, ST", "City, Country"],
  "location_source_urls": { "mfg_source_urls": ["https://...", "https://..."] }
}
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
    }),
    maxTokens: 400,
    model: resolveSearchModel(),
    xaiUrl,
    xaiKey,
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
    .map(normalizeLocationWithStateAbbrev);  // Normalize state names to abbreviations

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

  const prompt = `For the company ${name} (${websiteUrlForPrompt || "(unknown website)"}) provide the tagline.

Task: Provide the company's official tagline or slogan.

Rules:
- Use web search.
- Return the company's actual marketing tagline/slogan.
- A sentence fragment is acceptable.
- Do NOT return navigation labels, promotional text, or legal text.
- Do NOT hallucinate or embellish. Accuracy is paramount.
- If no tagline is found, return empty string.
- Output STRICT JSON only.

Return:
{ "tagline": "..." }
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

  const prompt = `For the company ${name} (${websiteUrlForPrompt || "(unknown website)"}) identify the industries.

Task: Identify the company's industries.

Rules:
- Use web search.
- Return an array of industries/categories that best describe what the company makes or sells.
- Provide not industry codes but the type of business they do.
- Be thorough and complete in identifying all relevant industries.
- Avoid store navigation terms (e.g. "New Arrivals", "Shop", "Sale") and legal terms.
- Prefer industry labels that can be mapped to standard business taxonomies.
- No guessing or hallucinating. Only report verified information.
- Output STRICT JSON only.

Return:
{ "industries": ["Industry 1", "Industry 2", "..."] }
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

  const valueOut = { industries: cleaned.slice(0, 5), industries_status: "ok" };
  if (cacheKey) writeStageCache(cacheKey, valueOut);
  return valueOut;
}

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

  const prompt = `For the company ${name} (${websiteUrlForPrompt || "(unknown website)"}) provide the product keywords.

Task: Provide an EXHAUSTIVE, COMPLETE, and ALL-INCLUSIVE list of ALL PRODUCTS this company sells.

Hard rules:
- Browse the company website AND use web search. Check product pages, collections, "Shop" sections, "All Products" pages.
- List every individual product, product line, flavor, variety, and SKU you can find.
- For companies with product variants (flavors, sizes, formulations), list EACH variant separately.
- Keywords should be exhaustive – if a customer could search for it and find this company's product, include it.
- Return ONLY actual products/product lines. Do NOT include:
  Navigation labels: Shop All, Collections, New, Best Sellers, Sale, Limited Edition, All
  Site features: Account, Cart, Store Locator, FAQ, Shipping, Returns, Contact, About, Blog
  Generic category labels unless they ARE an actual product line name
  Bundle/pack descriptors unless they are a named product (e.g. "Starter Kit" is OK if it's a real product name)
- The list must be materially more complete than what appears in the site's top navigation.
- If you are uncertain about completeness, expand your search. Check category pages, seasonal items, discontinued-but-listed products.
- Do NOT return a short/partial list without marking it incomplete.
- No guessing or hallucinating. Only report verified product information.
- Output STRICT JSON only.

Return:
{
  "product_keywords": ["Product 1", "Product 2", "..."],
  "completeness": "complete" | "incomplete",
  "incomplete_reason": null | "..."
}
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

  const prompt = `For the company ${name} (${websiteUrlForPrompt || "(unknown website)"}) find the company logo.

Task: Find the direct URL to this company's official logo image.

Requirements:
- The logo must be the company's official brand logo or wordmark
- Look for it in the website header, navigation, footer, or about page
- The URL should be a direct link to an image file (PNG, SVG, JPG, WebP)
- Do NOT return favicon.ico or generic placeholder images
- Do NOT return product images, hero banners, or promotional graphics
- The image should be the primary brand identifier used across the site
- If multiple logo variants exist (light/dark, horizontal/stacked), prefer the main/primary version
- Verify the URL actually returns an image

Output STRICT JSON only:
{
  "logo_url": "https://..." | null,
  "logo_source": "header" | "nav" | "footer" | "about" | "meta" | "schema" | null,
  "confidence": "high" | "medium" | "low"
}`.trim();

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
    }),
    maxTokens: 250,
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
  const logoSource = asString(out?.logo_source).trim().toLowerCase() || null;
  const confidence = asString(out?.confidence).trim().toLowerCase() || "low";

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

  const prompt = `For the company ${name} (${websiteUrlForPrompt || "(unknown website)"}) please provide their tagline, HQ, manufacturing, industries, keywords (products), and reviews.

LOCATIONS: Do deep dives for hq and manufacturing locations if necessary. Including city or cities. Having the actual cities within the United States is crucial. No explanatory info - just locations. Use initials for state or province in location info.

INDUSTRIES: Return as a JSON array of industry strings.

KEYWORDS: Keywords should be exhaustive, complete and all-inclusive list of all the products that the company produces.

REVIEWS: Find 5 real, publicly accessible third-party reviews with working URLs. Each must be about this company or its products. Prefer a mix of sources (YouTube, magazines, blogs). If only 3 verified reviews exist, return 3 — quality over quantity. Do not return broken, paywalled, or deleted URLs. Fields: "source_name", "author", "source_url" (direct URL, not homepage), "title", "date", "excerpt".

Return STRICT JSON only:
{
  "tagline": "...",
  "headquarters_location": "City, ST",
  "manufacturing_locations": ["City, ST", "City, Country"],
  "industries": ["Industry 1", "Industry 2"],
  "product_keywords": ["Product 1", "Product 2"],
  "reviews": [
    {
      "source_name": "Channel or Publication Name",
      "author": "Author Name",
      "source_url": "https://...",
      "title": "Exact Title",
      "date": "YYYY-MM-DD or approximate",
      "excerpt": "Brief excerpt or summary"
    }
  ]
}`.trim();

  const r = await xaiLiveSearchWithRetry({
    prompt,
    timeoutMs: clampStageTimeoutMs({
      remainingMs: budgetMs,
      minMs: 60_000,
      maxMs: 300_000,
      safetyMarginMs: 5_000,
    }),
    maxTokens: 4000,
    model: resolveSearchModel(model),
    xaiUrl,
    xaiKey,
    search_parameters: { mode: "on" },
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
  const parsed = parseJsonFromXaiResponse(r.resp);

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

  const hq_raw = asString(parsed.headquarters_location || parsed.hq || "").trim();
  const hq_normalized = hq_raw ? normalizeLocationWithStateAbbrev(hq_raw) : "";
  field_statuses.headquarters = hq_normalized ? "ok" : "empty";

  const mfg_raw = Array.isArray(parsed.manufacturing_locations) ? parsed.manufacturing_locations : [];
  const mfg_cleaned = mfg_raw
    .map((x) => asString(x).trim())
    .filter(Boolean)
    .map(normalizeLocationWithStateAbbrev);
  field_statuses.manufacturing = mfg_cleaned.length > 0 ? "ok" : "empty";

  const industries_raw = Array.isArray(parsed.industries) ? parsed.industries : [];
  const industries_cleaned = industries_raw.map((x) => asString(x).trim()).filter(Boolean);
  field_statuses.industries = industries_cleaned.length > 0 ? "ok" : "empty";

  const kw_raw = Array.isArray(parsed.product_keywords)
    ? parsed.product_keywords
    : Array.isArray(parsed.keywords)
      ? parsed.keywords
      : [];
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
        if (meta.title && !review.title) review.title = meta.title;
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
  return missing;
}

/**
 * Fill specific missing fields using individual prompt functions.
 */
async function fillMissingFieldsIndividually(missingFields, {
  companyName,
  normalizedDomain,
  budgetMs = 120000,
  xaiUrl,
  xaiKey,
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
        promises.push(fetchCuratedReviews(args));
        fieldNames.push("reviews");
        break;
    }
  }

  if (promises.length === 0) return { filled, field_statuses };

  const results = await Promise.allSettled(promises);

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
          const reviewTarget = 5;
          field_statuses.reviews = val.curated_reviews.length >= reviewTarget ? "ok" : "incomplete";
        } else {
          field_statuses.reviews = val.reviews_stage_status || "empty";
        }
        break;
    }
  }

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
  budgetMs = 240000,
  xaiUrl,
  xaiKey,
  fieldsToEnrich,
  skipDedicatedDeepening = false,
} = {}) {
  const started = Date.now();
  const getRemainingMs = () => Math.max(0, budgetMs - (Date.now() - started));

  // Map long MANDATORY_ENRICH_FIELDS names → short findMissingFields names
  const FIELD_SHORT_TO_LONG = {
    tagline: "tagline", headquarters: "headquarters_location",
    manufacturing: "manufacturing_locations", industries: "industries",
    keywords: "product_keywords", reviews: "reviews",
  };
  const filterMissingByTarget = (missingShortNames) =>
    Array.isArray(fieldsToEnrich)
      ? missingShortNames.filter((short) => fieldsToEnrich.includes(FIELD_SHORT_TO_LONG[short] || short))
      : missingShortNames;

  const domain = normalizeDomain(normalizedDomain || websiteUrl);

  // Phase 1: Unified prompt
  console.log(`[enrichCompanyFields] Phase 1: unified prompt for "${companyName}" (${domain}), budget=${budgetMs}ms`);
  const unified = await fetchAllFieldsUnified({
    companyName,
    websiteUrl,
    normalizedDomain: domain,
    budgetMs: Math.min(getRemainingMs() - 30000, 300000), // Reserve 30s for verification + fallback
    xaiUrl,
    xaiKey,
  });

  if (unified.ok && unified.parsed_fields) {
    // Phase 2: Verify
    console.log(`[enrichCompanyFields] Phase 2: verifying fields, remaining=${getRemainingMs()}ms`);
    const { verified, verification_status } = await verifyEnrichmentFields(
      unified.parsed_fields,
      { companyName, budgetMs: Math.min(getRemainingMs() - 15000, 120000) }
    );

    // Phase 3: Dedicated deepening for keywords, reviews, HQ, and mfg.
    // skipDedicatedDeepening: when true, return Phase 1+2 results as-is (used by
    // PASS1a for a fast Cosmos save before Azure kills the process).
    let fallback_statuses = {};
    let missing = [];

    if (!skipDedicatedDeepening) {
      // Phase 1 unified prompt produces shallow keywords (nav labels) and unreliable reviews.
      // Dedicated fetchers have stronger prompts, more tokens, and longer timeouts.
      // Save Phase 2 verified reviews as fallback before zeroing — if Phase 3
      // dedicated call returns 0 (XAI hallucinated URLs), we still keep these.
      const phase2VerifiedReviews = Array.isArray(verified.reviews) ? [...verified.reviews] : [];
      // Discard Phase 1 results for these fields so dedicated calls always run.
      verified.product_keywords = [];
      verified.reviews = [];
      verified.headquarters_location = "";
      verified.manufacturing_locations = [];

      const missing = findMissingFields(verified);
      // Force dedicated calls even if findMissingFields doesn't list them
      const ALWAYS_DEEPEN = ["keywords", "reviews", "headquarters", "manufacturing"];
      for (const field of ALWAYS_DEEPEN) {
        if (!missing.includes(field)) missing.push(field);
      }
      const filteredMissing = filterMissingByTarget(missing);

      if (filteredMissing.length > 0 && getRemainingMs() > 30000) {
        console.log(`[enrichCompanyFields] Phase 3: dedicated deepening [${filteredMissing.join(", ")}], remaining=${getRemainingMs()}ms`);
        const { filled, field_statuses: fStatuses } = await fillMissingFieldsIndividually(
          filteredMissing,
          { companyName, normalizedDomain: domain, budgetMs: getRemainingMs() - 5000, xaiUrl, xaiKey }
        );
        Object.assign(verified, filled);
        fallback_statuses = fStatuses;
      }

      // If Phase 3 dedicated reviews returned nothing, fall back to Phase 2 verified reviews.
      // Phase 2 verifies Phase 1 unified-prompt review URLs; Phase 3 makes a fresh XAI call
      // that may hallucinate different URLs. When Phase 3 finds 0, the Phase 2 results are
      // still valid and should be preserved rather than discarding everything.
      if ((!Array.isArray(verified.reviews) || verified.reviews.length === 0) && phase2VerifiedReviews.length > 0) {
        verified.reviews = phase2VerifiedReviews;
        fallback_statuses.reviews = phase2VerifiedReviews.length >= 5 ? "ok" : "incomplete";
        console.log(`[enrichCompanyFields] Phase 3 reviews empty — using ${phase2VerifiedReviews.length} Phase 2 verified review(s) as fallback`);
      }
    } else {
      console.log(`[enrichCompanyFields] skipDedicatedDeepening=true — returning Phase 1+2 results, remaining=${getRemainingMs()}ms`);
    }

    // Merge field statuses (only string values — skip detail objects like reviews_verification_detail)
    const field_statuses = { ...unified.field_statuses };
    for (const [k, v] of Object.entries(verification_status)) {
      if (typeof v === "string") field_statuses[k] = v;
    }
    for (const [k, v] of Object.entries(fallback_statuses)) {
      // Dedicated deepening results always override Phase 1 statuses
      field_statuses[k] = v;
    }

    const totalElapsed = Date.now() - started;
    console.log(`[enrichCompanyFields] Done (unified). field_statuses=${JSON.stringify(field_statuses)}, missing_after_unified=[${missing.join(", ")}], reviews_in_proposed=${Array.isArray(verified.reviews) ? verified.reviews.length : 0}, elapsed=${totalElapsed}ms`);

    return {
      ok: true,
      method: "unified",
      proposed: verified,
      raw_response: unified.raw_response_text,
      field_statuses,
      missing_after_unified: missing,
      elapsed_ms: totalElapsed,
      reviews_attempted_urls: verification_status.reviews_attempted_urls || [],
    };
  }

  // Unified failed completely - fall back to all individual calls in parallel
  console.log(`[enrichCompanyFields] Unified failed (${unified.error || "unknown"}), falling back to individual calls, remaining=${getRemainingMs()}ms`);

  const args = { companyName, normalizedDomain: domain, budgetMs: getRemainingMs() - 5000, xaiUrl, xaiKey };

  const allFields = [
    "tagline", "headquarters", "manufacturing", "industries", "keywords", "reviews",
  ];
  const targetFallback = filterMissingByTarget(allFields);
  const { filled, field_statuses } = await fillMissingFieldsIndividually(
    targetFallback,
    args
  );

  const totalElapsed = Date.now() - started;
  console.log(`[enrichCompanyFields] Done (individual_fallback). field_statuses=${JSON.stringify(field_statuses)}, unified_error=${unified.error || "none"}, elapsed=${totalElapsed}ms`);

  return {
    ok: Object.values(field_statuses).some((s) => s === "ok"),
    method: "individual_fallback",
    proposed: filled,
    raw_response: unified.raw_response_text || "",
    field_statuses,
    unified_error: unified.error || null,
    elapsed_ms: totalElapsed,
  };
}

module.exports = {
  DEFAULT_REVIEW_EXCLUDE_DOMAINS,
  fetchCuratedReviews,
  fetchHeadquartersLocation,
  fetchManufacturingLocations,
  fetchTagline,
  fetchIndustries,
  fetchProductKeywords,
  fetchLogo,
  // Unified enrichment engine
  fetchAllFieldsUnified,
  verifyEnrichmentFields,
  enrichCompanyFields,
  // Helpers for location normalization
  normalizeLocationWithStateAbbrev,
  inferCountryFromStateAbbreviation,
  // Admin refresh bypass flag
  setAdminRefreshBypass,
  isAdminRefreshBypass,
};
