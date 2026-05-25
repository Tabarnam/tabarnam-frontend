/**
 * In-memory typo correction.
 *
 * Pre-Cosmos correction of user-typed product words. When the user types
 * "paintt" or "puzle" or "jerkey", we silently rewrite the query to
 * "paint" / "puzzle" / "jerky" BEFORE issuing the Cosmos query, so the
 * normal Pass 1 (word-boundary CONTAINS) path finds the results that the
 * fuzzy fallback can't surface (the fuzzy fallback only looks at company
 * NAMES via STARTSWITH; it misses product-word typos in compound names
 * like "Miller Paint Company").
 *
 * Source of truth for "known words" is the same affinity index that the
 * relevance scorer already uses — `terms` keys = every token appearing
 * in ≥ 3 companies. That covers common product words ("paint", "puzzle",
 * "candle", "jerky") without including the long tail of one-off brand
 * names (which the existing fuzzy fallback handles via name STARTSWITH).
 *
 * The dictionary is cached at module scope and refreshed lazily every 15
 * minutes — the same TTL the affinity index uses. With alwaysReady=1
 * keeping a worker pinned, this load happens rarely and is amortized
 * across all subsequent requests.
 *
 * Lookup is O(small) per query word: candidates are bucketed by first
 * character + length, so we only Damerau-Levenshtein a few dozen tokens
 * per query word instead of all ~30k dictionary entries.
 */

const { loadIndustryAffinityIndex } = require("./_industryAffinityIndex");
const { damerauLevenshtein } = require("./_fuzzyMatch");

// Tokens shorter than this are too ambiguous to safely auto-correct
// ("bar" → "baz" / "bag" / "bat" / etc.) — leave them alone and let the
// existing search path handle them as typed.
const MIN_TOKEN_LEN = 4;

// We auto-correct only at edit distance exactly 1. Distance 0 means no
// typo (skip). Distance ≥ 2 risks correcting one word into something the
// user didn't mean — better to leave it and let the user see zero results
// (so they re-type) than to silently mis-correct.
const MAX_EDIT_DISTANCE = 1;

// Module-scope cache. Same TTL as the affinity index this draws from.
const CACHE_TTL_MS = 15 * 60 * 1000;
let _dictCache = null;
let _dictCacheAt = 0;
let _inFlight = null;

/**
 * Turn the affinity index's `terms` map (term -> industries) into a
 * bucketed lookup table optimised for edit-distance-1 search.
 *
 * Buckets:
 *   `${firstChar}|${len}` — candidates that share the query word's first
 *     letter and have a similar length (matches most edits)
 *   `*|${len}` — all candidates of a given length, used to catch the
 *     rarer case where the typo IS in the first character
 *
 * The double-bucketing means a single query word check scans at most
 * ~50-200 candidates instead of the whole dictionary.
 */
function buildBuckets(terms) {
  const byKey = new Map();
  if (!terms || typeof terms !== "object") return byKey;
  for (const term of Object.keys(terms)) {
    if (typeof term !== "string" || term.length < MIN_TOKEN_LEN) continue;
    const lower = term.toLowerCase();
    const firstChar = lower[0];
    const len = lower.length;

    const key = `${firstChar}|${len}`;
    let bucket = byKey.get(key);
    if (!bucket) { bucket = []; byKey.set(key, bucket); }
    bucket.push(lower);

    const lenKey = `*|${len}`;
    let lenBucket = byKey.get(lenKey);
    if (!lenBucket) { lenBucket = []; byKey.set(lenKey, lenBucket); }
    lenBucket.push(lower);
  }
  return byKey;
}

/**
 * Returns the cached dictionary, refreshing from the affinity index if
 * stale. Best-effort: any failure returns the previous cache (or null on
 * cold start) so a Cosmos hiccup never breaks search.
 */
async function getDictionary(container, { log = console.log } = {}) {
  if (!container) return _dictCache;
  const now = Date.now();
  if (_dictCache && now - _dictCacheAt < CACHE_TTL_MS) return _dictCache;
  if (_inFlight) return _inFlight;

  _inFlight = (async () => {
    try {
      const index = await loadIndustryAffinityIndex(container);
      if (!index || !index.terms) return _dictCache;
      const buckets = buildBuckets(index.terms);
      _dictCache = {
        buckets,
        termCount: Object.keys(index.terms).length,
        freshAt: Date.now(),
      };
      _dictCacheAt = Date.now();
      return _dictCache;
    } catch (err) {
      return _dictCache;
    } finally {
      _inFlight = null;
    }
  })();

  return _inFlight;
}

/**
 * Find the best correction for a single token. Returns null when:
 *   - The token is shorter than MIN_TOKEN_LEN
 *   - The token IS already in the dictionary (so it's not a typo)
 *   - No candidate is exactly distance 1 away
 *   - Multiple candidates are tied at distance 1 (ambiguous — refuse to guess)
 *
 * Otherwise returns the unique distance-1 dictionary token.
 */
function correctToken(token, dictionary) {
  if (!dictionary || !dictionary.buckets) return null;
  if (!token || typeof token !== "string") return null;
  const t = token.toLowerCase();
  if (t.length < MIN_TOKEN_LEN) return null;

  const buckets = dictionary.buckets;
  const firstChar = t[0];
  const L = t.length;

  // Collect candidate tokens by first-char + length, and by length-only
  // (to catch first-character edits). Dedupe via Set since the buckets
  // overlap.
  const candidates = new Set();
  for (const len of [L - 1, L, L + 1]) {
    const bucket = buckets.get(`${firstChar}|${len}`);
    if (bucket) for (const c of bucket) candidates.add(c);
  }
  const lenBucket = buckets.get(`*|${L}`);
  if (lenBucket) for (const c of lenBucket) candidates.add(c);

  // The query word is in the dictionary as-is → not a typo.
  if (candidates.has(t)) return null;

  // Collect every distance-1 candidate, then disambiguate by length.
  // Rationale: "paintt" is distance 1 from BOTH "paint" (delete the
  // trailing t) and "paints" (substitute t→s). Shorter wins because the
  // base form is overwhelmingly the more likely intent (singular over
  // plural, verb over derivative). Only when MULTIPLE candidates tie at
  // the shortest length do we refuse to guess — that's a real ambiguity
  // ("ruck" is 1 edit from both "rack" and "rock", same length).
  const matches = [];
  for (const candidate of candidates) {
    if (Math.abs(candidate.length - L) > MAX_EDIT_DISTANCE) continue;
    if (damerauLevenshtein(t, candidate) === MAX_EDIT_DISTANCE) {
      matches.push(candidate);
    }
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  matches.sort((a, b) => a.length - b.length);
  // Unique shortest wins; tie at the shortest length → genuinely ambiguous.
  return matches[0].length < matches[1].length ? matches[0] : null;
}

/**
 * Tokenize the normalized query, correct each eligible token, return the
 * corrected query string. Returns null if NO tokens were changed — the
 * caller can use null as a signal that the original query stands.
 */
function correctQuery(q_norm, dictionary) {
  if (!q_norm || typeof q_norm !== "string") return null;
  if (!dictionary) return null;

  const tokens = q_norm.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let changed = false;
  const out = tokens.map((token) => {
    const correction = correctToken(token, dictionary);
    if (correction && correction !== token.toLowerCase()) {
      changed = true;
      return correction;
    }
    return token;
  });

  return changed ? out.join(" ") : null;
}

// Test hook — reset module cache between cases.
function _resetCache() {
  _dictCache = null;
  _dictCacheAt = 0;
  _inFlight = null;
}

module.exports = {
  getDictionary,
  buildBuckets,
  correctToken,
  correctQuery,
  MIN_TOKEN_LEN,
  MAX_EDIT_DISTANCE,
  _resetCache,
};
