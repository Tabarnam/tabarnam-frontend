const { xaiLiveSearch, extractTextFromXaiResponse } = require("./_xaiLiveSearch");
const { extractJsonFromText } = require("./_curatedReviewsXai");
const { buildSearchParameters } = require("./_buildSearchParameters");

const DEFAULT_REVIEW_EXCLUDE_DOMAINS = [
  "amazon.",
  "amzn.to",
  "google.",
  "g.co",
  "goo.gl",
  "yelp.",
];

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return Math.max(min, Math.min(max, i));
}

// XAI stage timeout max: 10 minutes to allow thorough, accurate XAI searches.
// Accuracy is paramount - we'd rather leave a field blank than have false info.
function resolveXaiStageTimeoutMaxMs(fallback = 600_000) {
  const raw = Number(process.env.XAI_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return fallback;
  // Extended upper bound to 10 minutes - take however long needed for accuracy.
  return clampInt(raw, { min: 2_500, max: 600_000, fallback });
}

// Extended stage timeouts to 10 minutes max - accuracy is paramount.
// We'd rather leave a field blank after 10 minutes than have false information.
// Min values kept low for test compatibility; max extended to allow thorough searches in production.
const XAI_STAGE_TIMEOUTS_MS = Object.freeze({
  reviews: { min: 15_000, max: 600_000 },
  location: { min: 15_000, max: 600_000 },
  light: { min: 10_000, max: 300_000 },
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

// Extended timeout constraints to allow thorough XAI searches (up to 10 minutes per field).
function clampStageTimeoutMs({ remainingMs, minMs = 2_500, maxMs = resolveXaiStageTimeoutMaxMs(), safetyMarginMs = 1_200 } = {}) {
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
    return (m && (m[1] || m[2] || m[3])) ? asString(m[1] || m[2] || m[3]).trim() : null;
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
    const res = await fetchWithTimeout(attempted, { method: "GET", timeoutMs, headers: { "User-Agent": "Mozilla/5.0" } });
    const status = Number(res.status || 0) || 0;
    if (status < 200 || status >= 300) {
      return { ok: false, url: attempted, status, reason: `http_${status}` };
    }

    const ct = asString(res.headers?.get ? res.headers.get("content-type") : "").toLowerCase();
    const isHtml = ct.includes("text/html") || ct.includes("application/xhtml");
    if (!isHtml) return { ok: true, url: attempted, status };

    const text = await res.text();
    const head = text.slice(0, soft404Bytes);
    const title = parseHtmlTitle(head);
    const soft404 =
      (title && /\b(404|not found|page not found)\b/i.test(title)) ||
      /\b(404|page not found|sorry, we can\s*'t find)\b/i.test(head);

    if (soft404) return { ok: false, url: attempted, status, reason: "soft_404" };

    return { ok: true, url: attempted, status, html_preview: head };
  } catch (e) {
    return { ok: false, url: attempted, status: 0, reason: asString(e?.message || e || "fetch_failed") };
  }
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

  // Accuracy is paramount - NO FALSE INFO EVER under any circumstance.
  // We'd rather leave the field blank than have false information.
  const prompt = `For the company (${websiteUrlForPrompt || "(unknown website)"}) please provide reviews.

Task: Find EXACTLY 4 unique third-party reviews for this specific company.

CRITICAL - ACCURACY IS PARAMOUNT:
- Do NOT hallucinate or embellish review titles, sources, URLs, excerpts, or anything else.
- Every URL MUST be verified as functional before including.
- Reviews MUST be specifically about this company or its products - not similar companies.
- If you cannot find 4 legitimate, verified reviews after thorough searching, return fewer rather than fabricating any.
- NO FALSE INFORMATION EVER under any circumstance.

Hard rules:
- Use extensive web search. Take however long needed to get it right.
- 2 reviews must be YouTube videos focused specifically on this company or one of its products.
- 2 reviews must be magazine or blog reviews (NOT the company website).
- Check that each URL is functional before including.
- Provide MORE than 4 candidates (up to 20) so we can verify URLs.
- Exclude sources from these domains or subdomains: ${excludeDomains.join(", ")}

For each review provide:
- source_name: The publication or channel name
- title: The exact title of the article or video (do NOT paraphrase or embellish)
- excerpt: A brief abstract or direct quote from the review (no ellipses)
- source_url: The verified, working URL
- category: "youtube" or "blog"

Reviews should be formatted as: Source Name   Title of Article or Video
Include an abstract or quote from the review.
End with: URL:   [the verified link]

Output STRICT JSON only (use key "reviews_url_candidates"; legacy name: "review_candidates"):
{
  "reviews_url_candidates": [
    { "source_name": "...", "title": "...", "excerpt": "...", "source_url": "https://...", "category": "youtube" },
    { "source_name": "...", "title": "...", "excerpt": "...", "source_url": "https://...", "category": "blog" }
  ]
}`.trim();

  const stageTimeout = XAI_STAGE_TIMEOUTS_MS.reviews;

  // Budget clamp: if we can't safely run another upstream call, defer without terminalizing.
  const remaining = budgetMs - (Date.now() - started);
  const minRequired = stageTimeout.min + 1_200;
  if (remaining < minRequired) {
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
    maxTokens: 2000,
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
      return { source_url: url, category, source_name: x.source_name, title: x.title, excerpt: x.excerpt };
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

  const perUrlTimeoutMs = clampInt(remaining / 6, { min: 2500, max: 9000, fallback: 8000 });

  for (const c of deduped) {
    if (Date.now() - started > budgetMs - 1500) break;
    if (verified_youtube.length >= 2 && verified_blog.length >= 2) break;

    const needsYoutube = verified_youtube.length < 2;
    const needsBlog = verified_blog.length < 2;

    if (c.category === "youtube" && !needsYoutube) continue;
    if (c.category === "blog" && !needsBlog) continue;

    const host = normalizeHostForDedupe(urlHost(c.source_url));
    if (c.category === "blog" && usedBlogHosts.has(host) && deduped.some((x) => x.category === "blog" && normalizeHostForDedupe(urlHost(x.source_url)) !== host)) {
      // Prefer unique blog/magazine domains when possible.
      continue;
    }

    attempted_urls.push(c.source_url);
    const verified = await verifyUrlReachable(c.source_url, { timeoutMs: perUrlTimeoutMs });
    if (!verified.ok) continue;

    const html = typeof verified.html_preview === "string" ? verified.html_preview : "";
    const meta = buildReviewMetadataFromHtml(c.source_url, html);

    const review = {
      source_name: c.source_name || (isYouTubeUrl(c.source_url) ? "YouTube" : meta.source_name),
      author: meta.author,
      source_url: meta.source_url,
      title: c.title || meta.title,
      date: meta.date,
      excerpt: c.excerpt || meta.excerpt,
    };

    if (c.category === "youtube") {
      verified_youtube.push(review);
    } else {
      verified_blog.push(review);
      if (host) usedBlogHosts.add(host);
    }
  }

  const curated_reviews = [...verified_youtube.slice(0, 2), ...verified_blog.slice(0, 2)];
  const hasTwoYoutube = curated_reviews.filter((r) => isYouTubeUrl(r?.source_url)).length >= 2;
  const hasTwoBlog = curated_reviews.length - curated_reviews.filter((r) => isYouTubeUrl(r?.source_url)).length >= 2;

  const ok = curated_reviews.length === 4 && hasTwoYoutube && hasTwoBlog;

  if (!ok) {
    const reasonParts = [];
    if (!hasTwoYoutube) reasonParts.push("missing_youtube_reviews");
    if (!hasTwoBlog) reasonParts.push("missing_blog_reviews");
    if (curated_reviews.length < 4) reasonParts.push("insufficient_verified_reviews");

    const value = {
      curated_reviews,
      reviews_stage_status: "incomplete",
      incomplete_reason: reasonParts.join(",") || "insufficient_verified_reviews",
      attempted_urls,
      diagnostics: {
        candidate_count: candidates.length,
        verified_count: curated_reviews.length,
        youtube_verified: verified_youtube.length,
        blog_verified: verified_blog.length,
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
      youtube_verified: verified_youtube.length,
      blog_verified: verified_blog.length,
    },
    attempted_urls,
    search_telemetry: searchBuild.telemetry,
    excluded_hosts: searchBuild.excluded_hosts,
  };
  if (cacheKey) writeStageCache(cacheKey, value);
  return value;
}

async function fetchHeadquartersLocation({
  companyName,
  normalizedDomain,
  budgetMs = 20000,
  xaiUrl,
  xaiKey,
} = {}) {
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

  // Accuracy is paramount - NO FALSE INFO EVER under any circumstance.
  const prompt = `For the company (${websiteUrlForPrompt || "(unknown website)"}) please provide the HEADQUARTERS location.

CRITICAL - ACCURACY IS PARAMOUNT:
- Do deep dives for HQ location if necessary.
- Having the actual city within the United States is crucial.
- Do NOT guess or fabricate locations.
- If you cannot determine the HQ location with certainty after thorough searching, return empty rather than guessing.
- NO FALSE INFORMATION EVER under any circumstance.

Task: Determine the company's HEADQUARTERS location.

Rules:
- Use extensive web search (do not rely only on the company website).
- Do deep dives if necessary - take however long needed to get it right.
- Prefer authoritative sources like LinkedIn, official filings, SEC documents, reputable business directories.
- Return best available HQ as a single formatted string: "City, State/Province, Country".
  - If state/province is not applicable, use "City, Country".
  - If only country is known, return "Country".
- For US companies, the specific city and state is crucial.
- Provide the supporting URLs you used for the HQ determination.
- Output STRICT JSON only.

Return:
{
  "headquarters_location": "City, State, Country",
  "location_source_urls": { "hq_source_urls": ["https://...", "https://..."] }
}
`.trim();

  const stageTimeout = XAI_STAGE_TIMEOUTS_MS.location;

  const remaining = budgetMs - (Date.now() - started);
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

  if (!out || typeof out !== "object" || Array.isArray(out) || !Object.prototype.hasOwnProperty.call(out, "headquarters_location")) {
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

  const hq_source_urls_raw =
    Array.isArray(out?.location_source_urls?.hq_source_urls) ? out.location_source_urls.hq_source_urls : out?.source_urls;

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
    const valueOut = { headquarters_location: "Not disclosed", hq_status: "not_disclosed", source_urls, location_source_urls };
    if (cacheKey) writeStageCache(cacheKey, valueOut);
    return valueOut;
  }

  const valueOut = { headquarters_location: value, hq_status: "ok", source_urls, location_source_urls };
  if (cacheKey) writeStageCache(cacheKey, valueOut);
  return valueOut;
}

async function fetchManufacturingLocations({
  companyName,
  normalizedDomain,
  budgetMs = 20000,
  xaiUrl,
  xaiKey,
} = {}) {
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

  // Accuracy is paramount - NO FALSE INFO EVER under any circumstance.
  const prompt = `For the company (${websiteUrlForPrompt || "(unknown website)"}) please provide MANUFACTURING locations.

CRITICAL - ACCURACY IS PARAMOUNT:
- Do deep dives for manufacturing locations if necessary.
- Having the actual cities within the United States is crucial.
- Do NOT guess or fabricate locations.
- If you cannot determine manufacturing locations with certainty after thorough searching, return ["Not disclosed"] rather than guessing.
- NO FALSE INFORMATION EVER under any circumstance.

Task: Determine the company's MANUFACTURING locations.

Rules:
- Use extensive web search (do not rely only on the company website).
- Do deep dives if necessary - take however long needed to get it right.
- Return an array of one or more locations. Include city + state/country when known; include multiple cities when applicable.
- For US locations, the specific city and state is crucial.
- If only country-level is available after exhaustive search, country-only entries are acceptable.
- If manufacturing is not publicly disclosed after thorough searching, return ["Not disclosed"].
- Provide the supporting URLs you used for the manufacturing determination.
- Output STRICT JSON only.

Return:
{
  "manufacturing_locations": ["City, State, Country"],
  "location_source_urls": { "mfg_source_urls": ["https://...", "https://..."] }
}
`.trim();

  const stageTimeout = XAI_STAGE_TIMEOUTS_MS.location;

  const remaining = budgetMs - (Date.now() - started);
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

  const maxTimeoutMs = Math.min(stageTimeout.max, resolveXaiStageTimeoutMaxMs());

  const r = await xaiLiveSearchWithRetry({
    prompt,
    timeoutMs: clampStageTimeoutMs({
      remainingMs: remaining,
      minMs: stageTimeout.min,
      maxMs: maxTimeoutMs,
      safetyMarginMs: 1_200,
    }),
    maxTokens: 500,
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

  if (!out || typeof out !== "object" || Array.isArray(out) || !Object.prototype.hasOwnProperty.call(out, "manufacturing_locations")) {
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

  const mfg_source_urls_raw =
    Array.isArray(out?.location_source_urls?.mfg_source_urls) ? out.location_source_urls.mfg_source_urls : out?.source_urls;

  const source_urls = Array.isArray(mfg_source_urls_raw)
    ? mfg_source_urls_raw.map((x) => safeUrl(x)).filter(Boolean).slice(0, 12)
    : [];

  const location_source_urls = { mfg_source_urls: source_urls };

  const arr = Array.isArray(out?.manufacturing_locations) ? out.manufacturing_locations : [];
  const cleaned = arr.map((x) => asString(x).trim()).filter(Boolean);

  if (cleaned.length === 0) {
    const valueOut = { manufacturing_locations: [], mfg_status: "not_found", source_urls, location_source_urls };
    if (cacheKey) writeStageCache(cacheKey, valueOut);
    return valueOut;
  }

  if (cleaned.length === 1 && cleaned[0].toLowerCase().includes("not disclosed")) {
    const valueOut = { manufacturing_locations: ["Not disclosed"], mfg_status: "not_disclosed", source_urls, location_source_urls };
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

  const prompt = `For the company (${websiteUrlForPrompt || "(unknown website)"}) please provide the tagline/slogan.

CRITICAL - ACCURACY IS PARAMOUNT:
- Do NOT guess or fabricate taglines.
- Only return the actual official tagline/slogan used by the company.
- If you cannot find an official tagline, return empty rather than making one up.
- NO FALSE INFORMATION EVER under any circumstance.

Task: Provide ONLY the company tagline/slogan.

Rules:
- Use web search.
- Return a short marketing-style tagline (a sentence fragment is fine).
- Do NOT return navigation labels, promos, or legal text.
- Output STRICT JSON only.

Return:
{ "tagline": "..." }
`.trim();

  const stageTimeout = XAI_STAGE_TIMEOUTS_MS.light;

  const remaining = budgetMs - (Date.now() - started);
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

  if (!out || typeof out !== "object" || Array.isArray(out) || (!Object.prototype.hasOwnProperty.call(out, "tagline") && !Object.prototype.hasOwnProperty.call(out, "slogan"))) {
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

  // Accuracy is paramount - industries should be in paragraph form with commas separating them.
  const prompt = `For the company (${websiteUrlForPrompt || "(unknown website)"}) please provide the industries.

CRITICAL - ACCURACY IS PARAMOUNT:
- Do NOT guess or fabricate industries.
- Only return actual industries the company operates in.
- NO FALSE INFORMATION EVER under any circumstance.

Task: Identify the company's industries.

Rules:
- Use web search.
- Return a list of industries/categories that best describe what the company makes/sells.
- Industries should be in paragraph form with each industry separated by commas.
- Use commas to separate industries - no commas within an industry name.
- Avoid store navigation terms (e.g. "New Arrivals", "Shop", "Sale") and legal terms.
- Prefer industry labels that can be mapped to an internal taxonomy.
- Output STRICT JSON only.

Return:
{ "industries": ["Industry 1", "Industry 2", "Industry 3"] }
`.trim();

  const stageTimeout = XAI_STAGE_TIMEOUTS_MS.light;

  const remaining = budgetMs - (Date.now() - started);
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

  const valueOut = { industries: cleaned.slice(0, 10), industries_status: "ok" };
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

  // Keywords should be exhaustive, complete and all-inclusive of all products.
  const prompt = `For the company (${websiteUrlForPrompt || "(unknown website)"}) please provide the keywords (products).

CRITICAL - ACCURACY IS PARAMOUNT:
- Keywords should be EXHAUSTIVE, COMPLETE and ALL-INCLUSIVE (all the products that the company produces).
- Do NOT guess or fabricate product names.
- NO FALSE INFORMATION EVER under any circumstance.
- Take however long needed to get a complete list.

Task: Provide an EXHAUSTIVE list of the PRODUCTS (SKUs/product names/product lines) this company sells.

Hard rules:
- Use extensive web search (not just the company website).
- Keywords should be in paragraph form with each item separated by commas.
- NO commas within a product name - only use commas to separate products.
- Do NOT include dosages, GMP certifications, or 3rd party testing info.
- Return ONLY products/product lines. Do NOT include navigation/UX taxonomy such as: Shop All, Collections, New, Best Sellers, Sale, Account, Cart, Store Locator, FAQ, Shipping, Returns, Contact, About, Blog.
- Do NOT include generic category labels unless they are actual product lines.
- The list should be materially more complete than the top nav.
- If you are uncertain about completeness, expand the search and keep going until you can either:
  (a) justify completeness, OR
  (b) explicitly mark it incomplete with a reason.
- Do NOT return a short/partial list without marking it incomplete.
- Output STRICT JSON only.

Return:
{
  "product_keywords": ["Product 1", "Product 2", "Product 3"],
  "completeness": "complete" | "incomplete",
  "incomplete_reason": null | "..."
}
`.trim();

  const stageTimeout = XAI_STAGE_TIMEOUTS_MS.light;

  const remaining = budgetMs - (Date.now() - started);
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

  const maxTimeoutMs = Math.min(stageTimeout.max, resolveXaiStageTimeoutMaxMs());

  const r = await xaiLiveSearchWithRetry({
    prompt,
    timeoutMs: clampStageTimeoutMs({
      remainingMs: remaining,
      minMs: stageTimeout.min,
      maxMs: maxTimeoutMs,
      safetyMarginMs: 1_200,
    }),
    maxTokens: 1500,
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

  const list = Array.isArray(out?.product_keywords) ? out.product_keywords : Array.isArray(out?.keywords) ? out.keywords : [];

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

module.exports = {
  DEFAULT_REVIEW_EXCLUDE_DOMAINS,
  fetchCuratedReviews,
  fetchHeadquartersLocation,
  fetchManufacturingLocations,
  fetchTagline,
  fetchIndustries,
  fetchProductKeywords,
};
