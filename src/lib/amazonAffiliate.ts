export const AMAZON_ASSOCIATE_TAG = "tabarnam00-20";

function hasProtocol(input: string) {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(input) || input.startsWith("//");
}

function normalizeHostname(hostname: string) {
  return hostname.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
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

export function isAmazonHostname(hostname: string) {
  const h = normalizeHostname(hostname);
  if (!h) return false;
  return AMAZON_ROOT_DOMAINS.some((root) => h === root || h.endsWith(`.${root}`));
}

function safeParseUrl(raw: string): { url: URL; hadProtocol: boolean } | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;

  const had = hasProtocol(trimmed);

  try {
    if (trimmed.startsWith("//")) {
      return { url: new URL(`https:${trimmed}`), hadProtocol: true };
    }

    if (had) {
      return { url: new URL(trimmed), hadProtocol: true };
    }

    // If the string is a relative URL, leave it untouched.
    if (trimmed.startsWith("/") || trimmed.startsWith("#")) return null;

    return { url: new URL(`https://${trimmed}`), hadProtocol: false };
  } catch {
    return null;
  }
}

function deleteSearchParamCaseInsensitive(params: URLSearchParams, name: string) {
  const target = name.toLowerCase();
  const keysToDelete: string[] = [];
  for (const key of params.keys()) {
    if (key.toLowerCase() === target) keysToDelete.push(key);
  }
  for (const key of keysToDelete) params.delete(key);
}

/**
 * Removes any existing Amazon Associates tag parameter from an Amazon URL.
 * Non-Amazon URLs are returned unchanged.
 */
export function stripAmazonAffiliateTag(inputUrl: string) {
  const parsed = safeParseUrl(inputUrl);
  if (!parsed) return inputUrl;

  const { url } = parsed;
  if (!isAmazonHostname(url.hostname)) return inputUrl;

  deleteSearchParamCaseInsensitive(url.searchParams, "tag");
  return url.toString();
}

/**
 * Ensures any outbound Amazon link includes the required Associate tag.
 * - Only applies to Amazon retail domains (including subdomains)
 * - Strips any existing tag= before appending the correct one
 * - Preserves all other query params
 */
export function withAmazonAffiliate(inputUrl: string) {
  const parsed = safeParseUrl(inputUrl);
  if (!parsed) return inputUrl;

  const { url } = parsed;
  if (!isAmazonHostname(url.hostname)) return inputUrl;

  deleteSearchParamCaseInsensitive(url.searchParams, "tag");
  url.searchParams.append("tag", AMAZON_ASSOCIATE_TAG);
  return url.toString();
}
