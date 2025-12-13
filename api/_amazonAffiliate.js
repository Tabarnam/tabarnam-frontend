const AMAZON_ASSOCIATE_TAG = "tabarnam00-20";

function normalizeHostname(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

function isAmazonHostname(hostname) {
  const h = normalizeHostname(hostname);
  return h === "amazon.com" || h.endsWith(".amazon.com");
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

module.exports = {
  AMAZON_ASSOCIATE_TAG,
  isAmazonHostname,
  stripAmazonAffiliateTagForStorage,
};
