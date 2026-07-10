// Company-name extraction sources for the /admin/extract-companies tool.
//
// Given a marketplace/directory URL, produce the list of companies (brands /
// vendors / sellers) that appear on it. The extraction strategy is pluggable
// per "source" so the same admin tool works across more than one site:
//
//   - "shopify"  → the site is a Shopify storefront. Every product carries a
//                  `vendor` field, and the distinct set of vendors IS the
//                  authoritative list of companies selling on the store. We
//                  paginate `/products.json` and collect distinct vendors.
//                  This is complete and reliable — no rendering or scraping.
//   - "unsupported" → we could not auto-detect a structured source. The caller
//                  surfaces guidance; a site-specific extractor (Microlink /
//                  HTML parse) can be added here later.
//
// Network access is injectable (`fetchImpl`) so the logic is unit-testable
// without hitting the real network.

const DEFAULT_MAX_PAGES = 250;         // 250 * 100 = 25k products hard ceiling
const DEFAULT_PAGE_LIMIT = 3;          // pages fetched per chunked request (keeps the UI ticker lively)
// Shopify allows limit up to 250, BUT large limits at deep offset make the
// store's products.json query TIME OUT (HTTP 500) — empirically Mammoth 500s
// deterministically at limit=250 offset≥4250, while limit=100 pages cleanly to
// the end of a 13k-product catalog. So we deliberately use a smaller page size
// to trade more requests for a complete, reliable crawl.
const SHOPIFY_PAGE_SIZE = 100;
const PAGE_PACING_MS = 600;            // gap between page fetches — be polite, avoid 429
const PAGE_TIMEOUT_MS = 15_000;        // per-request timeout
const OVERALL_BUDGET_MS = 90_000;      // per-chunk wall-clock budget
const MAX_PAGE_RETRIES = 3;            // retries on a transient page failure (429 / 5xx / network) before giving up
const MAX_RETRY_AFTER_MS = 15_000;     // cap on how long we'll honor a Retry-After header
const USER_AGENT =
  "Mozilla/5.0 (compatible; TabarnamBot/1.0; +https://tabarnam.com)";

// Site-specific: Mammoth Nation exposes its full partner (company) directory
// via a custom API — 935 companies in one call — which is the clean, complete
// source of "companies selling here", far better than mining 13k products.
const MAMMOTH_PARTNERS_API = "https://mn-api.mammothnation.app/partners";
const MAMMOTH_PARTNERS_PAGE_SIZE = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

// Parse a Retry-After header (seconds or HTTP-date) to milliseconds, capped.
// Tolerates both a fetch Headers object and a plain object (tests).
function parseRetryAfterMs(headers) {
  try {
    let raw = null;
    if (headers && typeof headers.get === "function") raw = headers.get("retry-after");
    else if (headers && typeof headers === "object") raw = headers["retry-after"] ?? headers["Retry-After"];
    if (raw == null) return 0;
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_AFTER_MS);
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Normalize a user-supplied URL to an https origin we can build endpoints on.
 * Returns { origin, href } or null when the input isn't a usable http(s) URL.
 */
function toOrigin(rawUrl) {
  let raw = asString(rawUrl).trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { origin: u.origin, href: u.href, hostname: u.hostname };
  } catch {
    return null;
  }
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch one Shopify products.json page, tolerant of transient failures.
 * Retries (with linear backoff) on rate limiting (429), server errors (5xx),
 * and network errors/timeouts — these are all transient and commonly clear on
 * a second try (empirically Mammoth 500s on later pages under paging load).
 * A hard 4xx (e.g. 404) is not retried.
 * `cfg.rateLimitBackoffMs` overrides the base backoff (tests pass a small value).
 * Returns { ok, products?, status, rateLimited? }.
 */
async function fetchShopifyPage(fetchImpl, origin, page, log, cfg = {}) {
  const baseBackoff = Number.isFinite(cfg.rateLimitBackoffMs) ? cfg.rateLimitBackoffMs : 2000;
  const url = `${origin}/products.json?limit=${SHOPIFY_PAGE_SIZE}&page=${page}`;
  for (let attempt = 0; attempt <= MAX_PAGE_RETRIES; attempt++) {
    const canRetry = attempt < MAX_PAGE_RETRIES;
    const backoff = baseBackoff * (attempt + 1);

    let res;
    try {
      res = await fetchWithTimeout(fetchImpl, url, PAGE_TIMEOUT_MS);
    } catch (e) {
      // Network error / timeout — transient; retry then give up.
      if (canRetry) {
        log?.(`[extract:shopify] page ${page} request failed (${e?.message || e}) — retrying in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      log?.(`[extract:shopify] page ${page} request failed: ${e?.message || e}`);
      return { ok: false, status: 0, error: asString(e?.message || e) };
    }

    // Transient upstream: rate limit (429) or server error (5xx). Back off and
    // retry a bounded number of times before surfacing the failure. On a 429,
    // honor the server's Retry-After hint (capped) over our linear backoff.
    if (res.status === 429 || res.status >= 500) {
      const rateLimited = res.status === 429;
      if (canRetry) {
        const retryAfterMs = rateLimited ? parseRetryAfterMs(res.headers) : 0;
        const wait = Math.max(backoff, retryAfterMs);
        log?.(`[extract:shopify] page ${page} transient ${res.status} — backing off ${wait}ms`);
        await sleep(wait);
        continue;
      }
      return { ok: false, status: res.status, rateLimited };
    }

    if (!res.ok) {
      return { ok: false, status: res.status };
    }

    // Past the last page, some stores return the storefront HTML instead of
    // JSON. Read as text and parse defensively so an HTML body doesn't throw.
    let text;
    try {
      text = await res.text();
    } catch (e) {
      return { ok: false, status: res.status, error: asString(e?.message || e) };
    }
    const trimmed = text.trim();
    if (!trimmed.startsWith("{")) {
      // Not JSON → treat as "no more products" (end of pagination).
      return { ok: true, products: [], nonJson: true };
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ok: true, products: [], nonJson: true };
    }
    return { ok: true, products: Array.isArray(parsed.products) ? parsed.products : [] };
  }
  // Unreachable — the loop always returns — but keep a safe fallback.
  return { ok: false, status: 0 };
}

// ── Site-specific: Mammoth Nation partners directory ────────────────────────

function isMammothHost(hostname) {
  return /(^|\.)mammothnation\.(com|app)$/i.test(asString(hostname));
}

/**
 * Pull the full Mammoth Nation partner (company) directory from its API.
 * Offset-paginated; dedupes by slug. Returns { ok, companies } or
 * { ok:false, error, message }.
 */
async function fetchMammothPartners(fetchImpl, log) {
  const bySlug = new Map();
  const deadline = Date.now() + OVERALL_BUDGET_MS;
  let offset = 0;
  let guard = 0;

  while (true) {
    if (Date.now() > deadline) break;
    const url = `${MAMMOTH_PARTNERS_API}?offset=${offset}&pageSize=${MAMMOTH_PARTNERS_PAGE_SIZE}`;
    let res;
    try {
      res = await fetchWithTimeout(fetchImpl, url, PAGE_TIMEOUT_MS);
    } catch (e) {
      return { ok: false, error: `request_failed: ${asString(e?.message || e)}`, message: "Could not reach the Mammoth partners API." };
    }
    if (!res.ok) {
      return { ok: false, error: `http_${res.status}`, message: `Mammoth partners API returned HTTP ${res.status}.` };
    }
    let payload;
    try {
      payload = await res.json();
    } catch {
      return { ok: false, error: "invalid_json", message: "Mammoth partners API returned invalid JSON." };
    }
    const data = Array.isArray(payload?.data) ? payload.data : [];
    for (const p of data) {
      const name = asString(p?.name).trim();
      if (!name) continue;
      const key = (asString(p?.slug).trim() || name).toLowerCase();
      if (!bySlug.has(key)) {
        bySlug.set(key, {
          name,
          product_count: null,
          // Card image Mammoth associates with the partner — useful downstream
          // (logo enrichment reference). No website URL is exposed by the API.
          image_url: asString(p?.lp_image).trim() || null,
        });
      }
    }
    log?.(`[extract:mammoth] offset ${offset} +${data.length} (total ${bySlug.size}/${payload?.pagination?.total ?? "?"})`);

    if (!payload?.pagination?.hasMore) break;
    offset += MAMMOTH_PARTNERS_PAGE_SIZE;
    if (++guard > 50) break; // safety
    if (PAGE_PACING_MS > 0) await sleep(PAGE_PACING_MS);
  }

  const companies = [...bySlug.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" })
  );
  return { ok: true, companies };
}

/**
 * Probe whether a URL is a Shopify storefront by requesting the first
 * products.json page. Returns the first page's products when it is (so the
 * caller doesn't re-fetch page 1), or null when it isn't Shopify.
 */
async function probeShopify(fetchImpl, origin, log, cfg = {}) {
  const first = await fetchShopifyPage(fetchImpl, origin, 1, log, cfg);
  if (first.ok && Array.isArray(first.products) && !first.nonJson) {
    // Confirm the products look like Shopify docs (have a `vendor` field).
    const looksShopify =
      first.products.length === 0 ||
      first.products.some((p) => p && typeof p === "object" && "vendor" in p);
    if (looksShopify) return { isShopify: true, firstPage: first.products };
  }
  if (first.rateLimited) {
    // Rate-limited on the probe — we can't confirm, surface it distinctly.
    return { isShopify: false, rateLimited: true };
  }
  return { isShopify: false };
}

/**
 * Extract distinct vendors from a Shopify store by paginating products.json.
 * `firstPageProducts` (from the probe) seeds page 1 to avoid a duplicate fetch.
 */
/**
 * Page a range [startPage, endPage] of a Shopify store, accumulating distinct
 * vendors. Shared by the single-shot extractor and the chunked one.
 * Termination signals:
 *   - ended: an empty page (end of catalog) was reached
 *   - truncated: a transient failure / time budget stopped us early
 * When neither fires (we simply reached endPage), the caller decides whether
 * there is a next chunk.
 * Returns { companies, lastPageFetched, ended, truncated, truncatedReason }.
 */
async function pageShopifyVendors(fetchImpl, origin, {
  startPage, endPage, pacingMs, rateLimitBackoffMs, firstPageProducts, deadline, log,
}) {
  const cfg = { rateLimitBackoffMs };
  const byKey = new Map(); // key -> { name, product_count }
  let lastPageFetched = startPage - 1;
  let ended = false;
  let truncated = false;
  let truncatedReason = null;

  const ingest = (products) => {
    for (const p of products) {
      const vendor = asString(p && p.vendor).trim();
      if (!vendor) continue;
      const key = vendor.toLowerCase();
      const existing = byKey.get(key);
      if (existing) existing.product_count += 1;
      else byKey.set(key, { name: vendor, product_count: 1 });
    }
  };

  for (let page = startPage; page <= endPage; page++) {
    let products;
    if (page === 1 && Array.isArray(firstPageProducts)) {
      products = firstPageProducts; // reuse the probe's page-1 fetch
    } else {
      if (deadline && Date.now() > deadline) { truncated = true; truncatedReason = "time_budget"; break; }
      if (page > startPage && pacingMs > 0) await sleep(pacingMs);
      const res = await fetchShopifyPage(fetchImpl, origin, page, log, cfg);
      if (!res.ok) {
        truncated = true;
        truncatedReason = res.rateLimited ? "rate_limited" : `page_error_${res.status || 0}`;
        break;
      }
      products = res.products;
    }
    lastPageFetched = page;
    if (!products || products.length === 0) { ended = true; break; } // end of pagination
    ingest(products);
  }

  const companies = [...byKey.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" })
  );

  return { companies, lastPageFetched, ended, truncated, truncatedReason };
}

async function extractShopifyVendors(fetchImpl, origin, opts, firstPageProducts, log) {
  const maxPages = Math.max(1, Math.min(500, Number(opts.maxPages) || DEFAULT_MAX_PAGES));
  const pacingMs = Number.isFinite(opts.pacingMs) ? opts.pacingMs : PAGE_PACING_MS;

  const { companies, lastPageFetched, ended, truncated, truncatedReason } = await pageShopifyVendors(
    fetchImpl, origin,
    {
      startPage: 1,
      endPage: maxPages,
      pacingMs,
      rateLimitBackoffMs: opts.rateLimitBackoffMs,
      firstPageProducts,
      deadline: Date.now() + OVERALL_BUDGET_MS,
      log,
    }
  );

  // Reached the page ceiling without ending or failing → possibly-incomplete.
  const hitMax = !ended && !truncated && lastPageFetched >= maxPages;
  return {
    source: "shopify",
    companies,
    pages_fetched: lastPageFetched,
    truncated: truncated || hitMax,
    truncated_reason: truncated ? truncatedReason : (hitMax ? "max_pages" : null),
  };
}

function rateLimitedResult(origin, extra = {}) {
  return {
    ok: false, source: "unsupported", url: origin, companies: [], count: 0,
    error: "rate_limited",
    message: "The site rate-limited our detection probe. Wait a minute and try again.",
    ...extra,
  };
}

function unsupportedResult(origin, extra = {}) {
  return {
    ok: false, source: "unsupported", url: origin, companies: [], count: 0,
    message:
      `Could not auto-detect a structured company list for ${origin}. ` +
      `Currently only Shopify storefronts (which expose per-product vendors) ` +
      `are auto-extractable. A site-specific extractor can be added for this domain.`,
    ...extra,
  };
}

/**
 * Detect the source of a URL and extract the company list.
 *
 * @param {string} rawUrl        the site to extract from
 * @param {object} [opts]
 * @param {number} [opts.maxPages]   cap on Shopify pages (default 60)
 * @param {function} [opts.fetchImpl] injectable fetch (defaults to global fetch)
 * @param {function} [opts.log]       optional logger(msg)
 * @returns {Promise<object>} {
 *     ok, source, url, companies: [{ name, product_count }],
 *     count, pages_fetched, truncated, truncated_reason, message?
 *   }
 */
async function extractCompanies(rawUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const log = typeof opts.log === "function" ? opts.log : null;

  if (!fetchImpl) {
    return { ok: false, source: "unsupported", error: "no_fetch_available", companies: [], count: 0 };
  }

  const parsed = toOrigin(rawUrl);
  if (!parsed) {
    return { ok: false, source: "unsupported", error: "invalid_url", companies: [], count: 0 };
  }
  const { origin } = parsed;

  if (isMammothHost(parsed.hostname)) {
    const r = await fetchMammothPartners(fetchImpl, log);
    if (!r.ok) {
      return { ok: false, source: "mammoth_partners", url: origin, companies: [], count: 0, error: r.error, message: r.message };
    }
    return { ok: true, source: "mammoth_partners", url: origin, companies: r.companies, count: r.companies.length, pages_fetched: 1, truncated: false, truncated_reason: null };
  }

  const probe = await probeShopify(fetchImpl, origin, log, {
    rateLimitBackoffMs: opts.rateLimitBackoffMs,
  });
  if (probe.isShopify) {
    const result = await extractShopifyVendors(fetchImpl, origin, opts, probe.firstPage, log);
    return {
      ok: true,
      url: origin,
      count: result.companies.length,
      ...result,
    };
  }

  if (probe.rateLimited) return rateLimitedResult(origin);

  // Not a recognized structured source. A site-specific extractor (Microlink
  // render + HTML parse) can be plugged in here per target site.
  return unsupportedResult(origin);
}

/**
 * Chunked extraction — fetch one bounded window of pages so the client can
 * loop and show live progress. Only page 1 runs the Shopify probe; later
 * chunks continue from `startPage`.
 *
 * @param {string} rawUrl
 * @param {object} [opts]
 * @param {number} [opts.startPage=1]   first page of this chunk
 * @param {number} [opts.pageLimit=3]   pages to fetch in this chunk
 * @param {function} [opts.fetchImpl]
 * @param {function} [opts.log]
 * @returns {Promise<object>} {
 *     ok, source, url, companies: [{name, product_count}] (this chunk only),
 *     from_page, to_page, next_page (null when done), done,
 *     truncated, truncated_reason, message?
 *   }
 */
async function extractCompaniesChunk(rawUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const log = typeof opts.log === "function" ? opts.log : null;

  if (!fetchImpl) return { ok: false, source: "unsupported", error: "no_fetch_available", companies: [], next_page: null, done: true };

  const parsed = toOrigin(rawUrl);
  if (!parsed) return { ok: false, source: "unsupported", error: "invalid_url", companies: [], next_page: null, done: true };
  const { origin } = parsed;

  const startPage = Math.max(1, Math.trunc(Number(opts.startPage) || 1));

  // Site-specific directory source (preferred). Mammoth returns its whole
  // company list from one API, so a single chunk is always "done".
  if (isMammothHost(parsed.hostname)) {
    if (startPage > 1) {
      return { ok: true, source: "mammoth_partners", url: origin, companies: [], from_page: startPage, to_page: startPage - 1, next_page: null, done: true, truncated: false };
    }
    const r = await fetchMammothPartners(fetchImpl, log);
    if (!r.ok) {
      return { ok: false, source: "mammoth_partners", url: origin, companies: [], next_page: null, done: true, error: r.error, message: r.message };
    }
    return { ok: true, source: "mammoth_partners", url: origin, companies: r.companies, from_page: 1, to_page: 1, next_page: null, done: true, truncated: false };
  }
  const pageLimit = Math.max(1, Math.min(20, Math.trunc(Number(opts.pageLimit) || DEFAULT_PAGE_LIMIT)));
  const pacingMs = Number.isFinite(opts.pacingMs) ? opts.pacingMs : PAGE_PACING_MS;
  const maxPages = DEFAULT_MAX_PAGES;

  let firstPageProducts = null;
  if (startPage === 1) {
    const probe = await probeShopify(fetchImpl, origin, log, { rateLimitBackoffMs: opts.rateLimitBackoffMs });
    if (!probe.isShopify) {
      return probe.rateLimited
        ? rateLimitedResult(origin, { next_page: null, done: true })
        : unsupportedResult(origin, { next_page: null, done: true });
    }
    firstPageProducts = probe.firstPage;
  }

  const endPage = Math.min(maxPages, startPage + pageLimit - 1);
  const { companies, lastPageFetched, ended, truncated, truncatedReason } = await pageShopifyVendors(
    fetchImpl, origin,
    { startPage, endPage, pacingMs, rateLimitBackoffMs: opts.rateLimitBackoffMs, firstPageProducts, deadline: Date.now() + OVERALL_BUDGET_MS, log }
  );

  const hitMax = !ended && !truncated && lastPageFetched >= maxPages;
  // "done" means the crawl genuinely finished: end of catalog or hard ceiling.
  // A transient truncation (rate limit / 5xx / time budget) is NOT done — we
  // surface a resume point so the client can Continue after a cooldown instead
  // of restarting from page 1.
  const done = ended || hitMax;
  return {
    ok: true,
    source: "shopify",
    url: origin,
    companies, // this chunk only
    from_page: startPage,
    to_page: lastPageFetched,
    // Next page to fetch. When done → null. When truncated → the page that
    // failed (lastPageFetched+1), i.e. where a Continue should resume.
    next_page: done ? null : lastPageFetched + 1,
    done,
    truncated: truncated || hitMax,
    truncated_reason: truncated ? truncatedReason : (hitMax ? "max_pages" : null),
  };
}

module.exports = {
  extractCompanies,
  extractCompaniesChunk,
  // exported for tests
  toOrigin,
  probeShopify,
  extractShopifyVendors,
  isMammothHost,
  fetchMammothPartners,
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_LIMIT,
  SHOPIFY_PAGE_SIZE,
};
