/**
 * Query normalizer for search functionality (backend)
 * Provides functions to normalize search queries in consistent ways
 */

const { stemWords } = require("./_stemmer");

/**
 * Normalize a search query by:
 * 1. Converting to lowercase
 * 2. Trimming whitespace
 * 3. Replacing [_-.,/\\]+ with space
 * 4. Removing other punctuation
 * 5. Collapsing multiple spaces to one
 */
function normalizeQuery(raw) {
  if (!raw || typeof raw !== "string") return "";
  
  // 1. Lowercase and trim
  let norm = raw.toLowerCase().trim();
  if (!norm) return "";
  
  // 2. Replace [_-.,/\\]+ with space (one or more of these chars -> single space)
  norm = norm.replace(/[_\-.,/\\]+/g, " ");
  
  // 3. Remove other punctuation (but keep spaces)
  norm = norm.replace(/[^\w\s]/g, "");
  
  // 4. Collapse multiple spaces to single space
  norm = norm.replace(/\s+/g, " ").trim();
  
  return norm;
}

/**
 * Create a compact form by removing all spaces from normalized query
 */
function compactQuery(normalized) {
  if (!normalized || typeof normalized !== "string") return "";
  return normalized.replace(/\s+/g, "");
}

/**
 * If the input looks like a URL, extract the "brand" portion of the domain
 * so users can paste a company URL and still get results.
 *
 *   "https://vitalyte.com/"              → "vitalyte"
 *   "https://shop.vitalyte.com/products" → "vitalyte"
 *   "www.acme-corp.co.uk"                → "acme-corp"
 *   "vitalyte.com"                       → "vitalyte"
 *   "vitalyte"                           → "vitalyte"  (unchanged)
 */
function extractSearchTermFromUrl(input) {
  const trimmed = (typeof input === "string" ? input : "").trim();
  if (!trimmed) return trimmed;

  const urlPattern = /^https?:\/\//i;
  const domainLike =
    /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(\/.*)?$/i;

  let hostname = "";
  if (urlPattern.test(trimmed)) {
    try {
      hostname = new URL(trimmed).hostname;
    } catch {
      return trimmed;
    }
  } else if (domainLike.test(trimmed)) {
    hostname = trimmed.split("/")[0];
  } else {
    return trimmed; // not a URL — return as-is
  }

  // Strip www. prefix
  hostname = hostname.replace(/^www\./, "");

  // Known two-part TLDs (co.uk, com.au, etc.)
  const twoPart = /\.(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/i;
  const parts = hostname.split(".");

  let namePart;
  if (twoPart.test(hostname) && parts.length >= 3) {
    namePart = parts[parts.length - 3];
  } else if (parts.length >= 2) {
    namePart = parts[parts.length - 2];
  } else {
    namePart = parts[0];
  }

  return namePart || trimmed;
}

/**
 * Parse a raw query into raw, normalized, compact, and stemmed forms.
 * If the input looks like a URL, the brand name is extracted first.
 */
function parseQuery(raw) {
  const q_raw = typeof raw === "string" ? raw : "";

  // If the user pasted a URL, extract the brand name before normalizing
  const effective = extractSearchTermFromUrl(q_raw);

  const q_norm = normalizeQuery(effective);
  const q_compact = compactQuery(q_norm);
  const q_stemmed = stemWords(q_norm);
  const q_stemmed_compact = compactQuery(q_stemmed);

  return { q_raw, q_norm, q_compact, q_stemmed, q_stemmed_compact };
}

module.exports = {
  normalizeQuery,
  compactQuery,
  parseQuery,
  extractSearchTermFromUrl,
  stemWords,
};
