/**
 * Query normalizer for search functionality (backend)
 * Provides functions to normalize search queries in consistent ways
 */

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
 * Parse a raw query into raw, normalized, and compact forms
 */
function parseQuery(raw) {
  const q_raw = typeof raw === "string" ? raw : "";
  const q_norm = normalizeQuery(q_raw);
  const q_compact = compactQuery(q_norm);
  
  return { q_raw, q_norm, q_compact };
}

module.exports = {
  normalizeQuery,
  compactQuery,
  parseQuery,
};
