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

const DEFAULT_MAX_PAGES = 60;          // 60 * 250 = 15k products hard ceiling
const SHOPIFY_PAGE_SIZE = 250;         // Shopify's max page size for products.json
const PAGE_PACING_MS = 400;            // gap between page fetches — be polite, avoid 429
const PAGE_TIMEOUT_MS = 15_000;        // per-request timeout
const OVERALL_BUDGET_MS = 90_000;      // total wall-clock budget for one extraction
const MAX_PAGE_RETRIES = 2;            // retries on a transient page failure (429 / 5xx / network) before giving up
const USER_AGENT =
  "Mozilla/5.0 (compatible; TabarnamBot/1.0; +https://tabarnam.com)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
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
    // retry a bounded number of times before surfacing the failure.
    if (res.status === 429 || res.status >= 500) {
      const rateLimited = res.status === 429;
      if (canRetry) {
        log?.(`[extract:shopify] page ${page} transient ${res.status} — backing off ${backoff}ms`);
        await sleep(backoff);
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
async function extractShopifyVendors(fetchImpl, origin, opts, firstPageProducts, log) {
  const maxPages = Math.max(1, Math.min(500, Number(opts.maxPages) || DEFAULT_MAX_PAGES));
  const pacingMs = Number.isFinite(opts.pacingMs) ? opts.pacingMs : PAGE_PACING_MS;
  const cfg = { rateLimitBackoffMs: opts.rateLimitBackoffMs };
  const deadline = Date.now() + OVERALL_BUDGET_MS;

  // Preserve first-seen original casing; dedupe on a case-folded key.
  const byKey = new Map(); // key -> { name, product_count }
  let pagesFetched = 0;
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

  for (let page = 1; page <= maxPages; page++) {
    let products;
    if (page === 1 && Array.isArray(firstPageProducts)) {
      products = firstPageProducts;
    } else {
      if (Date.now() > deadline) { truncated = true; truncatedReason = "time_budget"; break; }
      if (page > 1 && pacingMs > 0) await sleep(pacingMs);
      const res = await fetchShopifyPage(fetchImpl, origin, page, log, cfg);
      if (!res.ok) {
        truncated = true;
        truncatedReason = res.rateLimited ? "rate_limited" : `page_error_${res.status || 0}`;
        break;
      }
      products = res.products;
    }
    pagesFetched = page;
    if (!products || products.length === 0) break; // end of pagination
    ingest(products);
    if (page === maxPages) { truncated = true; truncatedReason = "max_pages"; }
  }

  const companies = [...byKey.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" })
  );

  return {
    source: "shopify",
    companies,
    pages_fetched: pagesFetched,
    truncated,
    truncated_reason: truncatedReason,
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

  if (probe.rateLimited) {
    return {
      ok: false,
      source: "unsupported",
      url: origin,
      companies: [],
      count: 0,
      error: "rate_limited",
      message:
        "The site rate-limited our detection probe. Wait a minute and try again.",
    };
  }

  // Not a recognized structured source. A site-specific extractor (Microlink
  // render + HTML parse) can be plugged in here per target site.
  return {
    ok: false,
    source: "unsupported",
    url: origin,
    companies: [],
    count: 0,
    message:
      `Could not auto-detect a structured company list for ${origin}. ` +
      `Currently only Shopify storefronts (which expose per-product vendors) ` +
      `are auto-extractable. A site-specific extractor can be added for this domain.`,
  };
}

module.exports = {
  extractCompanies,
  // exported for tests
  toOrigin,
  probeShopify,
  extractShopifyVendors,
  DEFAULT_MAX_PAGES,
  SHOPIFY_PAGE_SIZE,
};
