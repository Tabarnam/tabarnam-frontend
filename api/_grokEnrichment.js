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
  reviews: { min: 120_000, max: 180_000 },     // 2-3 minutes for reviews (URL verification is slow)
  keywords: { min: 60_000, max: 120_000 },     // 1-2 minutes for keywords
  location: { min: 60_000, max: 120_000 },     // 1-2 minutes for location searches (HQ, mfg)
  light: { min: 30_000, max: 60_000 },         // 30s-1 min for simpler fields (tagline, industries)
});

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

  // Enhanced prompt for reviews - stronger verification and more candidates
  const prompt = `For the company ${name} (${websiteUrlForPrompt || "(unknown website)"}) find third-party reviews.

Task: Find at least 3 unique third-party reviews about this company or its products.

CRITICAL REQUIREMENTS:
- Each review MUST actually be about "${name}" - verify the page content mentions this company
- Every URL MUST be functional and load correctly - test each one
- Do NOT return 404 pages, redirects, or paywalled content
- Do NOT hallucinate or invent URLs - accuracy is paramount

Review Sources (any mix acceptable):
- YouTube videos featuring this company or its products
- Magazine articles or blog posts reviewing this company
- News coverage or interviews about this company

For YouTube videos:
- The video MUST exist and be publicly accessible
- The video title and content MUST mention "${name}" or its products
- Do NOT return music videos, unrelated content, or deleted videos
- Provide the full watch URL (not playlist or channel URLs)

For blogs/magazines:
- The article MUST specifically review or feature "${name}"
- Verify the page loads and contains actual content about this company
- Prefer established publications over obscure blogs

Provide 20-30 candidates to ensure sufficient verified results.
Exclude sources from these domains: ${excludeDomains.join(", ")}

For each review, include:
- source_name: Exact channel name (YouTube) or publication name (blog)
- source_url: Direct URL to the video/article (NOT search results)
- category: "youtube" or "blog"
- title: Exact title of the video/article (do NOT paraphrase)
- excerpt: Direct quote from the review (1-2 sentences, no ellipses)

Output STRICT JSON only:
{
  "reviews_url_candidates": [
    {
      "source_url": "https://www.youtube.com/watch?v=...",
      "source_name": "Channel Name",
      "category": "youtube",
      "title": "Exact Video Title",
      "excerpt": "Direct quote from the review..."
    },
    {
      "source_url": "https://...",
      "source_name": "Publication Name",
      "category": "blog",
      "title": "Exact Article Title",
      "excerpt": "Direct quote from the review..."
    }
  ]
}`.trim();

  const stageTimeout = XAI_STAGE_TIMEOUTS_MS.reviews;

  // Budget clamp: if we can't safely run another upstream call, defer without terminalizing.
  // Skip budget check when test stub is active (allows tests with small budgets).
  const hasStub = globalThis && typeof globalThis.__xaiLiveSearchStub === "function";
  const remaining = budgetMs - (Date.now() - started);
  const minRequired = stageTimeout.min + 1_200;
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
      minMs: stageTimeout.min,
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

  const parsed = parseJsonFromXaiResponse(r.resp);

  const rawCandidates =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Array.isArray(parsed.reviews_url_candidates)
        ? parsed.reviews_url_candidates
        : Array.isArray(parsed.review_candidates)
          ? parsed.review_candidates
          : null
      : null;

  if (!rawCandidates) {
    const rawText = asString(extractTextFromXaiResponse(r.resp));
    return {
      curated_reviews: [],
      reviews_stage_status: "invalid_json",
      diagnostics: {
        reason: "missing_reviews_url_candidates",
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
    if (cacheKey) writeStageCache(cacheKey, value);
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

  const attempted_urls = [];
  const verified_youtube = [];
  const verified_blog = [];
  const usedBlogHosts = new Set();

  // Use longer timeout for blogs (magazines often slower than YouTube)
  const youtubeTimeoutMs = clampInt(remaining / 8, { min: 2500, max: 8000, fallback: 6000 });
  const blogTimeoutMs = clampInt(remaining / 5, { min: 4000, max: 12000, fallback: 10000 });

  // Track unverified blog candidates for fallback
  const unverifiedBlogCandidates = [];

  for (const c of deduped) {
    if (Date.now() - started > budgetMs - 1500) break;
    // Need 3 total reviews (any combination of YouTube + blog)
    const totalVerified = verified_youtube.length + verified_blog.length;
    if (totalVerified >= 3) break;

    const host = normalizeHostForDedupe(urlHost(c.source_url));
    if (
      c.category === "blog" &&
      host &&
      usedBlogHosts.has(host) &&
      deduped.some((x) => x.category === "blog" && normalizeHostForDedupe(urlHost(x.source_url)) !== host)
    ) {
      // Prefer unique blog/magazine domains when possible.
      continue;
    }

    attempted_urls.push(c.source_url);
    const perUrlTimeoutMs = c.category === "youtube" ? youtubeTimeoutMs : blogTimeoutMs;
    let verified = await verifyUrlReachable(c.source_url, { timeoutMs: perUrlTimeoutMs });

    // Retry once for blogs if first attempt failed (but not soft-404)
    if (!verified.ok && c.category === "blog" && verified.reason !== "soft_404") {
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

    // Blog-specific: Check if the page actually mentions the company name
    if (verified.ok && c.category === "blog") {
      const html = typeof verified.html_preview === "string" ? verified.html_preview : "";
      if (html) {
        const relevanceCheck = validateBlogContentRelevance(html, name);
        if (!relevanceCheck.relevant) {
          console.log(`[grokEnrichment] reviews: Blog doesn't mention company: ${c.source_url}`);
          verified = { ok: false, reason: "company_not_mentioned" };
        }
      }
    }

    if (!verified.ok) {
      // Track unverified blogs for potential fallback
      if (c.category === "blog") {
        unverifiedBlogCandidates.push({ ...c, verification_reason: verified.reason });
      }
      continue;
    }

    const html = typeof verified.html_preview === "string" ? verified.html_preview : "";
    const meta = buildReviewMetadataFromHtml(c.source_url, html);

    // Use XAI-provided data as fallback when HTML metadata is missing
    const review = {
      source_name: isYouTubeUrl(c.source_url) ? "YouTube" : (c.source_name || meta.source_name),
      author: meta.author || c.source_name,
      source_url: meta.source_url,
      title: c.title || meta.title,  // XAI title as fallback
      date: meta.date,
      excerpt: c.excerpt || meta.excerpt,  // XAI excerpt as fallback
    };

    if (c.category === "youtube") {
      verified_youtube.push(review);
    } else {
      verified_blog.push(review);
      if (host) usedBlogHosts.add(host);
    }
  }

  // Fallback: If we need more reviews and have unverified blogs, use them
  const totalVerifiedSoFar = verified_youtube.length + verified_blog.length;
  if (totalVerifiedSoFar < 3 && unverifiedBlogCandidates.length > 0) {
    const needed = 3 - totalVerifiedSoFar;
    for (let i = 0; i < Math.min(needed, unverifiedBlogCandidates.length); i++) {
      const fallback = unverifiedBlogCandidates[i];
      console.log(`[grokEnrichment] reviews: using unverified fallback blog: ${fallback.source_url}`);
      verified_blog.push({
        source_name: normalizeHostForDedupe(urlHost(fallback.source_url)) || "Unknown",
        author: null,
        source_url: fallback.source_url,
        title: null,
        date: null,
        excerpt: null,
        verification_warning: "unverified_fallback",
      });
    }
  }

  // Best 3 reviews (prefer YouTube, then blogs)
  const curated_reviews = [...verified_youtube, ...verified_blog].slice(0, 3);
  const youtubeCount = curated_reviews.filter((r) => isYouTubeUrl(r?.source_url)).length;
  const blogCount = curated_reviews.length - youtubeCount;

  const ok = curated_reviews.length >= 3;

  if (!ok) {
    const reasonParts = [];
    if (curated_reviews.length < 3) reasonParts.push("insufficient_verified_reviews");
    if (youtubeCount === 0 && blogCount === 0) reasonParts.push("no_verified_reviews");

    // Mark as exhausted after good-faith attempt: tried 5+ URLs, or have 1+ verified and tried 3+ URLs
    // This prevents infinite retries when XAI returns mostly invalid YouTube videos
    const isExhausted = attempted_urls.length >= 5 ||
      (curated_reviews.length > 0 && attempted_urls.length >= 3);

    const value = {
      curated_reviews,
      reviews_stage_status: "incomplete",
      incomplete_reason: reasonParts.join(",") || "insufficient_verified_reviews",
      attempted_urls,
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
    if (cacheKey) writeStageCache(cacheKey, value);
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
    attempted_urls,
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

  const prompt = `For the company (${websiteUrlForPrompt || "(unknown website)"}) determine the headquarters location.

Task: Determine the company's HEADQUARTERS location.

Rules:
- Use web search (do not rely only on the company website).
- Do deep dives for HQ location if necessary.
- Having the actual city within the United States is crucial. Be accurate.
- Use initials for state or province (e.g., "Austin, TX" not "Austin, Texas").
- Format: "City, ST" for US/Canada, "City, Country" for international.
- If only country is known, return "Country".
- No explanatory info – just the location.
- Prefer authoritative sources like LinkedIn, official filings, reputable business directories.
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
    const minRequired = stageTimeout.min + 1_200;
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
      minMs: stageTimeout.min,
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

  const prompt = `For the company (${websiteUrlForPrompt || "(unknown website)"}) determine the manufacturing locations.

Task: Determine the company's MANUFACTURING locations.

Rules:
- Use web search (do not rely only on the company website).
- Do deep dives for manufacturing locations if necessary.
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
    const minRequired = stageTimeout.min + 1_200;
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
      minMs: stageTimeout.min,
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

  const prompt = `For the company (${websiteUrlForPrompt || "(unknown website)"}) provide the tagline.

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
    const minRequired = stageTimeout.min + 1_200;
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
      minMs: stageTimeout.min,
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

  const prompt = `For the company (${websiteUrlForPrompt || "(unknown website)"}) identify the industries.

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
    const minRequired = stageTimeout.min + 1_200;
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
      minMs: stageTimeout.min,
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

  const prompt = `For the company (${websiteUrlForPrompt || "(unknown website)"}) provide the product keywords.

Task: Provide an EXHAUSTIVE, COMPLETE, and ALL-INCLUSIVE list of the PRODUCTS (SKUs/product names/product lines) this company sells.

Hard rules:
- Use web search (not just the company website).
- Keywords should be exhaustive, complete and all-inclusive – ALL the products that the company produces.
- Return ONLY products/product lines. Do NOT include navigation/UX taxonomy such as: Shop All, Collections, New, Best Sellers, Sale, Account, Cart, Store Locator, FAQ, Shipping, Returns, Contact, About, Blog.
- Do NOT include generic category labels unless they are actual product lines.
- The list should be materially more complete than the top nav.
- If you are uncertain about completeness, expand the search and keep going until you can either:
  (a) justify completeness, OR
  (b) explicitly mark it incomplete with a reason.
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
    const minRequired = stageTimeout.min + 1_200;
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
      minMs: stageTimeout.min,
      maxMs: maxTimeoutMs,
      safetyMarginMs: 1_200,
    }),
    maxTokens: 600,  // Increased to accommodate exhaustive product lists
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
    const minRequired = stageTimeout.min + 1_200;
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
      minMs: stageTimeout.min,
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

  const valueOut = {
    logo_url: validUrl,
    logo_status: "ok",
    logo_source: logoSource,
    logo_confidence: confidence,
  };
  if (cacheKey) writeStageCache(cacheKey, valueOut);
  return valueOut;
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
  // Helpers for location normalization
  normalizeLocationWithStateAbbrev,
  inferCountryFromStateAbbreviation,
  // Admin refresh bypass flag
  setAdminRefreshBypass,
  isAdminRefreshBypass,
};
