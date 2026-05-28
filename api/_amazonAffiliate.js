const AMAZON_ASSOCIATE_TAG = "tabarnam08-20";

function normalizeHostname(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

const AMAZON_ROOT_DOMAINS = [
  "amazon.com",
  "amazon.ca",
  "amazon.co.uk",
  "amazon.de",
  "amazon.fr",
  "amazon.it",
  "amazon.es",
  "amazon.co.jp",
  "amazon.com.au",
  "amazon.in",
  "amazon.com.mx",
  "amazon.com.br",
  "amazon.sg",
  "amazon.ae",
  "amazon.sa",
  "amazon.se",
  "amazon.nl",
  "amazon.pl",
  "amazon.eg",
  "amazon.tr",
];

function isAmazonHostname(hostname) {
  const h = normalizeHostname(hostname);
  if (!h) return false;
  return AMAZON_ROOT_DOMAINS.some((root) => h === root || h.endsWith(`.${root}`));
}

function safeParseUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;

  const hasProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed) || trimmed.startsWith("//");

  try {
    if (trimmed.startsWith("//")) return new URL(`https:${trimmed}`);
    if (hasProtocol) return new URL(trimmed);
    if (trimmed.startsWith("/") || trimmed.startsWith("#")) return null;
    return new URL(`https://${trimmed}`);
  } catch {
    return null;
  }
}

function deleteSearchParamCaseInsensitive(params, name) {
  const target = String(name || "").toLowerCase();
  const keysToDelete = [];
  for (const key of params.keys()) {
    if (String(key).toLowerCase() === target) keysToDelete.push(key);
  }
  for (const key of keysToDelete) params.delete(key);
}

/**
 * For database storage: ensure we DO NOT persist Amazon associate tags.
 * Only affects Amazon URLs; all others returned unchanged.
 */
function stripAmazonAffiliateTagForStorage(inputUrl) {
  const url = safeParseUrl(inputUrl);
  if (!url) return inputUrl;
  if (!isAmazonHostname(url.hostname)) return inputUrl;

  deleteSearchParamCaseInsensitive(url.searchParams, "tag");
  return url.toString();
}

// Amazon link shorteners — these freeze the Associate tag inside Amazon's
// server-side redirect, so the render-time helper can't rewrite it. They must
// be expanded to the full canonical URL before storage.
const AMAZON_SHORTENER_HOSTS = ["amzn.to", "a.co", "amzn.com", "amzn.eu", "amzn.asia", "amzn.in"];
const AFFILIATE_PARAMS = ["tag", "linkcode", "linkid", "ref_", "ref", "ascsubtag"];

function isAmazonShortenerUrl(inputUrl) {
  const url = safeParseUrl(inputUrl);
  if (!url) return false;
  const h = normalizeHostname(url.hostname);
  return AMAZON_SHORTENER_HOSTS.some((s) => h === s || h.endsWith(`.${s}`));
}

// Strip tracking/affiliate params while preserving the destination:
//  - Self-contained pages (/dp/ASIN, /stores/page/ID, /gp/product/) → path only.
//  - Search/browse pages (/s?k=...) → keep the query, drop affiliate-identity params.
// The render-time helper (withAmazonAffiliate) re-stamps the current tag either way.
function cleanExpandedAmazonUrl(inputUrl) {
  const url = safeParseUrl(inputUrl);
  if (!url) return inputUrl;
  const path = url.pathname;
  const selfContained =
    /\/dp\//i.test(path) || /^\/gp\/(product|aw\/d)\//i.test(path) || /^\/stores\b/i.test(path);
  if (selfContained) return `${url.origin}${path}`;

  for (const k of [...url.searchParams.keys()]) {
    if (AFFILIATE_PARAMS.includes(k.toLowerCase())) url.searchParams.delete(k);
  }
  const qs = url.searchParams.toString();
  return qs ? `${url.origin}${path}?${qs}` : `${url.origin}${path}`;
}

// Follow redirects (HEAD) until we leave the shortener hosts, returning the
// full destination URL. Returns null on failure (dead link, timeout, no fetch).
async function expandAmazonShortLink(shortUrl, maxHops = 6) {
  if (typeof fetch !== "function") return null;
  let current = shortUrl;
  for (let i = 0; i < maxHops; i += 1) {
    let res;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      res = await fetch(current, {
        method: "HEAD",
        redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; TabarnamLinkFixer/1.0)" },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return null;
      current = new URL(loc, current).toString();
      if (!isAmazonShortenerUrl(current)) return current;
    } else {
      const u = safeParseUrl(current);
      return u && isAmazonHostname(u.hostname) ? current : null;
    }
  }
  return null;
}

// Save-time guard: if the URL is an Amazon shortener (amzn.to, a.co, ...), expand
// it to the full canonical amazon.com URL and strip tracking params so the render
// layer controls the tag. Non-shortener URLs are returned unchanged. On any
// failure the original is returned — this never loses or corrupts data.
async function normalizeAmazonUrlForStorage(rawUrl) {
  const url = String(rawUrl || "").trim();
  if (!url || !isAmazonShortenerUrl(url)) return rawUrl;
  const expanded = await expandAmazonShortLink(url);
  if (!expanded) return rawUrl;
  return cleanExpandedAmazonUrl(expanded);
}

module.exports = {
  AMAZON_ASSOCIATE_TAG,
  isAmazonHostname,
  isAmazonShortenerUrl,
  stripAmazonAffiliateTagForStorage,
  normalizeAmazonUrlForStorage,
};
