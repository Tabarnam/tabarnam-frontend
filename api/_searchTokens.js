// Phase 4.36 — shared helper for building indexed `search_tokens` WHERE
// clauses against Cosmos. Used by both `search-companies` (public /results
// page) and `admin-companies-v2` (admin Companies dashboard) so the two
// endpoints can't drift on tokenization rules.
//
// The `search_tokens` array on every company doc is populated at write
// time by `_computeSearchText.js:patchCompanyWithSearchText()`. Tokens are
// already lowercased, diacritic-folded, and stem-augmented before being
// stored — meaning the query side just needs to apply the SAME
// normalization to the user's input and look for `ARRAY_CONTAINS` matches.
//
// Why this is fast: `ARRAY_CONTAINS(c.search_tokens, @tok)` is a true
// indexed lookup on the array's default index — O(log N) per partition,
// bounded RU. Compare to `CONTAINS(LOWER(c.company_name), @q)` which is an
// unindexed substring scan, O(n) per partition × all partitions.

const { normalizeQuery } = require("./_queryNormalizer");
const { simpleStem } = require("./_stemmer");

// Words dropped from the QUERY side (stored tokens keep them so docs that
// happen to contain "of" still match a "company of foo" query). Mirrors
// the inline set in `api/search-companies/index.js` so admin search treats
// the same query strings identically.
const SEARCH_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "by",
  "with", "at", "from", "as", "is", "are", "be",
]);

const MIN_TOKEN_LENGTH = 2;

/**
 * Split a normalized query into content words ready for token matching.
 * Drops stopwords and anything shorter than MIN_TOKEN_LENGTH.
 *
 * @param {string} normalizedQuery output of normalizeQuery()
 * @returns {string[]}
 */
function tokenizeQuery(normalizedQuery) {
  if (typeof normalizedQuery !== "string") return [];
  return normalizedQuery
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= MIN_TOKEN_LENGTH && !SEARCH_STOPWORDS.has(w));
}

/**
 * Build a single SQL fragment that matches docs whose `search_tokens`
 * array contains EVERY content word of the (already-normalized) query OR
 * its stem. Returns `null` when the query has no usable tokens — caller
 * should skip the indexed pass and fall through to a different strategy.
 *
 * The returned shape:
 *   { whereClause: "((@tok0 OR @tok0s) AND (@tok1 OR @tok1s) ...)",
 *     parameters: [{ name: "@tok0", value: "..." }, ...] }
 *
 * Callers compose this with their own soft-delete / sort / TOP clauses.
 * Parameter names use the provided prefix so multiple builds can coexist
 * in one SQL statement without colliding (e.g. one per synonym phrase).
 *
 * @param {string} normalizedQuery  output of normalizeQuery()
 * @param {object} [opts]
 * @param {string} [opts.paramPrefix="tok"]  prefix for generated @param names
 * @param {number} [opts.startIndex=0]  starting numeric suffix for params
 * @returns {{ whereClause: string, parameters: Array<{name:string,value:string}>, nextIndex: number } | null}
 */
function buildTokenMatchSql(normalizedQuery, opts = {}) {
  const words = tokenizeQuery(normalizedQuery);
  if (words.length === 0) return null;

  const paramPrefix = String(opts.paramPrefix || "tok");
  let idx = Number.isFinite(opts.startIndex) ? Math.trunc(opts.startIndex) : 0;

  const parameters = [];
  const wordClauses = [];

  for (const word of words) {
    // Each query word: match the word OR its stem. The doc-side
    // `search_tokens` already contains both, so this catches
    // plurals / inflections in either direction.
    const variants = new Set([word]);
    const stem = simpleStem(word);
    if (stem && stem.length >= MIN_TOKEN_LENGTH) variants.add(stem);

    const ors = [];
    for (const v of variants) {
      const paramName = `@${paramPrefix}${idx++}`;
      parameters.push({ name: paramName, value: v });
      ors.push(`ARRAY_CONTAINS(c.search_tokens, ${paramName})`);
    }
    wordClauses.push(`(${ors.join(" OR ")})`);
  }

  // Strict-AND across content words — every word of the (cleaned) query
  // must be present (as itself or its stem) in the doc's tokens.
  const whereClause = `(${wordClauses.join(" AND ")})`;

  return { whereClause, parameters, nextIndex: idx };
}

/**
 * Convenience: take a raw user-typed query, normalize, tokenize, and
 * build the WHERE clause in one call. Returns null when the cleaned
 * query has nothing usable.
 */
function buildTokenMatchSqlFromRaw(rawQuery, opts = {}) {
  const norm = normalizeQuery(String(rawQuery || ""));
  if (!norm) return null;
  return buildTokenMatchSql(norm, opts);
}

module.exports = {
  SEARCH_STOPWORDS,
  MIN_TOKEN_LENGTH,
  tokenizeQuery,
  buildTokenMatchSql,
  buildTokenMatchSqlFromRaw,
};
