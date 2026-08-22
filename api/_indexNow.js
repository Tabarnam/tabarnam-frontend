/**
 * IndexNow — tell Bing, Yandex, Seznam and Naver that a page changed, instead
 * of waiting for them to come back and find out.
 *
 * Why this matters here specifically: the whole /made-in and /company tree is
 * server-rendered precisely because the non-Google crawlers don't run JS (see
 * _madeInRender.js). Having finally made those pages readable to Bing, the
 * remaining lag is discovery — a 14.5k-page sitemap gets recrawled on Bing's
 * schedule, which is slow and gets slower the deeper the URL. An import that
 * adds 24 companies today should not wait weeks for those 24 pages to be seen.
 *
 * Google does NOT participate in IndexNow, so nothing here affects Google
 * ranking or crawling. Sitemaps remain the only lever there.
 *
 * The protocol is deliberately trivial: publish a key at a well-known URL to
 * prove you control the host, then POST changed URLs with that key. There is
 * no account, no OAuth, and no per-site registration — the key file IS the
 * verification, which is why this can ship before Bing Webmaster Tools is set
 * up. It stays behind INDEXNOW_ENABLED anyway so the first ping is a decision
 * someone makes, not a side effect of a deploy.
 *
 * ⚠️ The key file must also be listed in navigationFallback.exclude in
 * public/staticwebapp.config.json. SWA rewrites unmatched paths to index.html,
 * so without that entry /<key>.txt serves the app shell, the key check fails,
 * and every submission is rejected. That exclude list names files one by one —
 * a wildcard won't save you. Same trap that rules out Google's HTML
 * verification file (use DNS TXT there instead).
 */

const ORIGIN = "https://tabarnam.com";
const HOST = "tabarnam.com";

// Not a secret — it is published at ${ORIGIN}/${INDEXNOW_KEY}.txt, which is the
// entire point of it. It lives here as a constant rather than an app setting
// because the key file is committed alongside it and the two must agree;
// _indexNow.test.js asserts they do, so a rotation can't half-land.
const INDEXNOW_KEY = "b75c1fe14e989379a630a7047010f2f5";
const KEY_LOCATION = `${ORIGIN}/${INDEXNOW_KEY}.txt`;

const ENDPOINT = "https://api.indexnow.org/indexnow";

// The protocol's own ceiling per request.
const MAX_URLS = 10000;

// Short and hard. This runs off the import save path, and the lesson from the
// backend 500 storms is that an outbound call without a timeout is how a Flex
// worker gets wedged. A missed ping costs nothing — the sitemap still carries
// the URL — so there is no retry either.
const TIMEOUT_MS = 4000;

function isEnabled() {
  const raw = String(process.env.INDEXNOW_ENABLED || "").toLowerCase().trim();
  return raw === "on" || raw === "true" || raw === "1";
}

/**
 * Absolute, deduped, same-host URLs. Anything else is dropped rather than
 * sent: IndexNow rejects the WHOLE submission if any URL is off-host, so one
 * bad entry would silently cost the entire batch.
 */
function normalizeUrls(urls) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(urls) ? urls : [urls]) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const absolute = trimmed.startsWith("http")
      ? trimmed
      : `${ORIGIN}${trimmed.startsWith("/") ? "" : "/"}${trimmed}`;
    let parsed;
    try {
      parsed = new URL(absolute);
    } catch {
      continue;
    }
    if (parsed.host !== HOST || parsed.protocol !== "https:") continue;
    const canonical = `${parsed.origin}${parsed.pathname}`;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
    if (out.length >= MAX_URLS) break;
  }
  return out;
}

/**
 * Submit changed URLs. Never throws and never rejects — every caller is on a
 * fire-and-forget path behind a user-visible save, and search-engine
 * housekeeping must never be able to fail an import.
 *
 * Submitting a URL that now 404s is legitimate and wanted: it is how a deleted
 * company page gets dropped from the index promptly rather than lingering.
 */
async function submitUrls(urls, { logger = console, fetchImpl = globalThis.fetch } = {}) {
  const log = typeof logger?.log === "function" ? logger.log.bind(logger) : console.log;
  const list = normalizeUrls(urls);
  if (!list.length) return { ok: true, submitted: 0, skipped: "no urls" };
  if (!isEnabled()) {
    return { ok: true, submitted: 0, skipped: "INDEXNOW_ENABLED is off" };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, submitted: 0, error: "no fetch available" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      signal: controller.signal,
      body: JSON.stringify({
        host: HOST,
        key: INDEXNOW_KEY,
        keyLocation: KEY_LOCATION,
        urlList: list,
      }),
    });
    // 200 accepted, 202 accepted-but-key-not-checked-yet. 422 is the one worth
    // reading in logs: it means the key file didn't validate, which on this
    // host almost always means the exclude-list entry is missing and SWA is
    // serving the app shell at the key URL.
    const ok = res?.status === 200 || res?.status === 202;
    log(`[indexnow] submitted ${list.length} url(s) → ${res?.status}`);
    return { ok, submitted: ok ? list.length : 0, status: res?.status ?? 0 };
  } catch (err) {
    log(`[indexnow] submit failed (non-fatal): ${err?.name === "AbortError" ? "timeout" : err?.message}`);
    return { ok: false, submitted: 0, error: err?.message || "failed" };
  } finally {
    clearTimeout(timer);
  }
}

/** `/company/<slug>` → absolute URL, for callers holding slugs rather than paths. */
function companyUrl(slug) {
  const s = String(slug || "").trim();
  return s ? `${ORIGIN}/company/${s}` : null;
}

/**
 * What the pins-upsert callers use: ping the company pages an upsert reported
 * as changed.
 *
 * Only company pages, deliberately. A new company also shifts the counts on
 * its /made-in place pages, but there are ~150 of those and they sit at the
 * top of the sitemap where crawlers already return often. The 14.5k company
 * pages are the long tail that actually waits — they are what this is for.
 */
async function submitCompanySlugs(slugs, opts) {
  const urls = (Array.isArray(slugs) ? slugs : []).map(companyUrl).filter(Boolean);
  return submitUrls(urls, opts);
}

module.exports = {
  INDEXNOW_KEY,
  KEY_LOCATION,
  MAX_URLS,
  TIMEOUT_MS,
  isEnabled,
  normalizeUrls,
  submitUrls,
  companyUrl,
  submitCompanySlugs,
};
