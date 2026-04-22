/**
 * Query normalizer for search functionality
 * Provides functions to normalize search queries in consistent ways
 */

/**
 * Fold diacritics (accented characters) to their base ASCII letter.
 * "Béis" → "Beis", "café" → "cafe", "naïve" → "naive", "niño" → "nino".
 *
 * Uses Unicode NFD normalization to decompose accented characters into
 * [base letter][combining mark], then strips the combining marks.
 * This is critical because JavaScript's \w regex class is ASCII-only,
 * so accented characters would otherwise be treated as punctuation and
 * deleted entirely instead of folded.
 */
export function foldDiacritics(s: string): string {
  if (!s || typeof s !== "string") return "";
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Normalize a search query by:
 * 1. Converting to lowercase
 * 2. Trimming whitespace
 * 3. Folding diacritics (é → e, ñ → n, etc.)
 * 4. Replacing [_-.,/\\]+ with space
 * 5. Removing other punctuation
 * 6. Collapsing multiple spaces to one
 */
export function normalizeQuery(raw: string): string {
  if (!raw || typeof raw !== "string") return "";

  // 1. Lowercase and trim
  let norm = raw.toLowerCase().trim();
  if (!norm) return "";

  // 2. Fold diacritics so "Béis" and "beis" normalize to the same string
  norm = foldDiacritics(norm);

  // 3. Replace [_-.,/\\]+ with space (one or more of these chars -> single space)
  norm = norm.replace(/[_\-.,/\\]+/g, " ");

  // 4. Remove other punctuation (but keep spaces). Explicit ASCII class,
  //    since we've already folded non-ASCII letters above.
  norm = norm.replace(/[^a-z0-9\s]/g, "");

  // 5. Collapse multiple spaces to single space
  norm = norm.replace(/\s+/g, " ").trim();

  return norm;
}

/**
 * Create a compact form by removing all spaces from normalized query
 */
export function compactQuery(normalized: string): string {
  if (!normalized || typeof normalized !== "string") return "";
  return normalized.replace(/\s+/g, "");
}

/**
 * Strip common English plural suffixes from a word.
 * Mirrors api/_stemmer.js — must stay in sync.
 */
export function simpleStem(word: string): string {
  if (!word || typeof word !== "string") return word || "";
  const w = word.toLowerCase();
  if (w.length < 4) return w;

  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("shes")) return w.slice(0, -2);
  if (w.endsWith("ches")) return w.slice(0, -2);
  if (w.endsWith("xes")) return w.slice(0, -2);
  if (w.endsWith("zes")) return w.slice(0, -2);
  if (w.endsWith("ses")) return w.slice(0, -1);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) {
    return w.slice(0, -1);
  }
  return w;
}

/**
 * Stem each word in a normalized (space-separated) string.
 */
export function stemWords(normalized: string): string {
  if (!normalized || typeof normalized !== "string") return "";
  return normalized.split(/\s+/).map(simpleStem).filter(Boolean).join(" ");
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
export function extractSearchTermFromUrl(input: string): string {
  const trimmed = input.trim();
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

  let namePart: string;
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
 * Split a raw query on commas into distinct "concepts", then normalize each
 * concept independently. Users type comma-separated queries when they want
 * all of the listed concepts to match — e.g. "air compressor, tires" means
 * "find an air compressor that also relates to tires", not "any of these
 * three words". Empty segments are dropped.
 *
 *   "air compressor, tires"   → ["air compressor", "tires"]
 *   "foo"                     → ["foo"]
 *   " , , "                   → []
 *   "Béis, foo"               → ["beis", "foo"]    (diacritics folded)
 */
export function parseQueryConcepts(raw: string): string[] {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((seg) => normalizeQuery(seg))
    .filter((seg) => seg.length > 0);
}

/**
 * Parse a raw query into raw, normalized, compact, and stemmed forms.
 * If the input looks like a URL, the brand name is extracted first.
 */
export interface QueryNormalizationResult {
  q_raw: string;              // Exact query from URL/input
  q_norm: string;             // Normalized with spaces
  q_compact: string;          // Normalized without spaces
  q_stemmed: string;          // Stemmed with spaces
  q_stemmed_compact: string;  // Stemmed without spaces
  q_concepts: string[];       // Comma-separated concepts; each requires a match
}

export function parseQuery(raw: unknown): QueryNormalizationResult {
  const q_raw = typeof raw === "string" ? raw : "";

  // If the user pasted a URL, extract the brand name before normalizing
  const effective = extractSearchTermFromUrl(q_raw);

  const q_norm = normalizeQuery(effective);
  const q_compact = compactQuery(q_norm);
  const q_stemmed = stemWords(q_norm);
  const q_stemmed_compact = compactQuery(q_stemmed);
  // Parse concepts from the original (pre-URL-extraction) raw so commas in
  // the user's input survive. URL pastes don't contain commas in practice.
  const q_concepts = parseQueryConcepts(q_raw);

  return { q_raw, q_norm, q_compact, q_stemmed, q_stemmed_compact, q_concepts };
}
