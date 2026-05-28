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

const { damerauLevenshtein } = require("./_fuzzyMatch");

// Affinity-index doc IDs — kept here for back-compat in case a cached
// version exists. The primary dictionary source is now a direct scan of
// the companies container (see buildDictionaryFromScan), because the
// affinity index doc is not guaranteed to exist in production (it's
// built on demand by an admin endpoint that may not be reachable).
const INDEX_DOC_ID = "_index_industry_affinity";
const INDEX_PARTITION_KEY = "_index";
let _lastLoadError = null;
let _backgroundLoadStarted = false;

// Minimum companies a token must appear in to make the dictionary.
// Higher = more conservative (no rare/unique tokens) → safer against
// "correcting" a real-but-rare brand name into the wrong common word.
// Lower = more coverage. 2 means "at least one OTHER company shares this
// token", which excludes most one-off brand names while still capturing
// product words like "paint", "puzzle", "candle", "jerky".
const MIN_COMPANIES_PER_TOKEN = 2;

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
/**
 * Build the dictionary by scanning the companies container directly.
 *
 * Projects only the few fields we need for tokenization (names, keywords,
 * industries) so the per-doc payload stays small. Iterates the async
 * iterator in batches of 200 (a single roundtrip per batch). The
 * resulting map is `token -> count` (counts let callers tune the
 * MIN_COMPANIES_PER_TOKEN threshold later without re-scanning).
 *
 * Cost on a 23k-doc catalog: ~3-7 seconds on a warm Cosmos connection.
 * That's why this runs in the background — see startBackgroundLoad.
 */
function tokenizeField(src, sink) {
  if (typeof src !== "string" || !src) return;
  for (const raw of src.toLowerCase().split(/[\s\-_/.,;:!?()&]+/)) {
    // Strip remaining non-letter chars (digits, apostrophes) and check length.
    const token = raw.replace(/[^a-z]/g, "");
    if (token.length < MIN_TOKEN_LEN) continue;
    sink(token);
  }
}

async function buildDictionaryFromScan(container) {
  const tokenCount = Object.create(null);
  // Every token that appears in a company NAME field, at ANY frequency.
  // This is the "don't you dare correct this" protection set: a brand
  // deliberately spelled "Pillowz" / "Froot" / "Lyft" / "Flickr" must
  // never be rewritten into the common word ("pillow" / "fruit" / "lift" /
  // "flicker"). Built from name fields only — keyword/industry typos are
  // fair game to correct, but a real brand name is sacred.
  const nameTokens = new Set();

  const sql = {
    query:
      "SELECT c.company_name, c.display_name, c.name, " +
      "c.keywords, c.product_keywords, c.industries " +
      "FROM c WHERE NOT STARTSWITH(c.id, '_') " +
      "AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted = false) " +
      "AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')",
  };

  const iterator = container.items.query(sql, { maxItemCount: 200 });

  for await (const { resources } of iterator.getAsyncIterator()) {
    for (const company of resources || []) {
      // Protection set: name fields only, any frequency.
      tokenizeField(company.company_name, (t) => nameTokens.add(t));
      tokenizeField(company.display_name, (t) => nameTokens.add(t));
      tokenizeField(company.name, (t) => nameTokens.add(t));

      // Correction dictionary: all searchable fields, deduped per-company,
      // frequency-counted.
      const seenInCompany = new Set();
      const sources = [
        company.company_name,
        company.display_name,
        company.name,
        ...(Array.isArray(company.keywords) ? company.keywords : []),
        ...(Array.isArray(company.product_keywords) ? company.product_keywords : []),
        ...(Array.isArray(company.industries) ? company.industries : []),
      ];
      for (const src of sources) {
        tokenizeField(src, (token) => {
          if (seenInCompany.has(token)) return;
          seenInCompany.add(token);
          tokenCount[token] = (tokenCount[token] || 0) + 1;
        });
      }
    }
  }

  // Apply the company-frequency threshold to the correction dictionary.
  const kept = Object.create(null);
  for (const [token, count] of Object.entries(tokenCount)) {
    if (count >= MIN_COMPANIES_PER_TOKEN) kept[token] = count;
  }
  return { terms: kept, nameTokens };
}

async function getDictionary(container) {
  if (!container) return _dictCache;
  if (typeof container.items !== "object") return _dictCache;
  const now = Date.now();
  if (_dictCache && now - _dictCacheAt < CACHE_TTL_MS) return _dictCache;
  if (_inFlight) return _inFlight;

  _inFlight = (async () => {
    try {
      // Prefer a pre-built affinity index if it happens to exist (much
      // faster than the full scan), but DON'T require it — fall through
      // to the scan path when it's missing or unreadable. NOTE: the
      // affinity-index path has no name-token protection set, so a brand
      // protected by the scan path wouldn't be protected here. In practice
      // the affinity index doc doesn't exist in production (the scan path
      // always runs), so this is acceptable; if that changes, the index
      // builder should emit a nameTokens set too.
      let terms = null;
      let nameTokens = null;
      let source = "scan";
      try {
        const { resource } = await container
          .item(INDEX_DOC_ID, INDEX_PARTITION_KEY)
          .read();
        if (resource && resource.terms && typeof resource.terms === "object") {
          terms = resource.terms;
          source = "affinity_index";
        }
      } catch {
        // Not fatal — try the scan path.
      }

      if (!terms) {
        const scanned = await buildDictionaryFromScan(container);
        terms = scanned.terms;
        nameTokens = scanned.nameTokens;
        source = "scan";
      }

      const termCount = Object.keys(terms).length;
      if (termCount === 0) {
        _lastLoadError = "dictionary build returned 0 terms";
        return _dictCache;
      }
      const buckets = buildBuckets(terms);
      _dictCache = {
        buckets,
        nameTokens: nameTokens || new Set(),
        termCount,
        nameTokenCount: nameTokens ? nameTokens.size : 0,
        source,
        freshAt: Date.now(),
      };
      _dictCacheAt = Date.now();
      _lastLoadError = null;
      return _dictCache;
    } catch (err) {
      _lastLoadError = err?.code
        ? `${err.code}: ${err.message || ""}`
        : (err?.message || String(err));
      return _dictCache;
    } finally {
      _inFlight = null;
    }
  })();

  return _inFlight;
}

/**
 * Kick off a dictionary load in the background. Fire-and-forget — the
 * caller does NOT await this. Subsequent calls are no-ops until the
 * cache TTL expires. Use this to pre-warm the cache so a user's first
 * request doesn't pay the ~5s full-scan cost.
 */
function startBackgroundLoad(container) {
  if (_backgroundLoadStarted) return;
  if (!container || typeof container.items !== "object") return;
  _backgroundLoadStarted = true;
  // The promise is intentionally orphaned. Errors are captured in
  // _lastLoadError by getDictionary, so silent failures here aren't
  // truly silent — they surface in the per-request diag.
  getDictionary(container).catch(() => {});
}

function getLastLoadError() {
  return _lastLoadError;
}

function getCacheInfo() {
  return _dictCache
    ? { termCount: _dictCache.termCount, source: _dictCache.source, ageMs: Date.now() - _dictCacheAt }
    : null;
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

  // Protection: never "correct" a token that is itself a real company-name
  // token. A brand deliberately spelled "Pillowz" / "Froot" / "Lyft" must
  // not be rewritten into the common word "pillow" / "fruit" / "lift" —
  // doing so loses the exact brand the user searched for. (2026-05-25:
  // "pillowz" was being rewritten to "pillow", burying the Pillowz brand.)
  if (dictionary.nameTokens && dictionary.nameTokens.has(t)) return null;

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
  _lastLoadError = null;
  _backgroundLoadStarted = false;
}

module.exports = {
  getDictionary,
  getLastLoadError,
  getCacheInfo,
  startBackgroundLoad,
  buildBuckets,
  buildDictionaryFromScan,
  correctToken,
  correctQuery,
  MIN_TOKEN_LEN,
  MAX_EDIT_DISTANCE,
  MIN_COMPANIES_PER_TOKEN,
  INDEX_DOC_ID,
  INDEX_PARTITION_KEY,
  _resetCache,
};
