const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildBuckets,
  correctToken,
  correctQuery,
  _resetCache,
} = require("./_typoCorrection");

function dictWith(terms) {
  const map = {};
  for (const t of terms) map[t] = {};
  return { buckets: buildBuckets(map) };
}

test.beforeEach(() => _resetCache());

// ── correctToken ─────────────────────────────────────────────────────────

test("correctToken: returns null when the token is already in the dictionary", () => {
  const d = dictWith(["paint", "puzzle", "jerky"]);
  assert.equal(correctToken("paint", d), null);
  assert.equal(correctToken("puzzle", d), null);
});

test("correctToken: corrects an insertion typo (paintt → paint)", () => {
  const d = dictWith(["paint", "jerky"]);
  assert.equal(correctToken("paintt", d), "paint");
});

test("correctToken: corrects a deletion typo (puzle → puzzle)", () => {
  const d = dictWith(["puzzle", "candle"]);
  assert.equal(correctToken("puzle", d), "puzzle");
});

test("correctToken: corrects a transposition typo (porducts → products)", () => {
  const d = dictWith(["products", "production"]);
  assert.equal(correctToken("porducts", d), "products");
});

test("correctToken: corrects a substitution typo (cendle → candle)", () => {
  const d = dictWith(["candle", "candles"]);
  assert.equal(correctToken("cendle", d), "candle");
});

test("correctToken: returns null when no dictionary token is within edit distance 1", () => {
  const d = dictWith(["paint", "jerky"]);
  assert.equal(correctToken("xyzzy", d), null);
});

test("correctToken: returns null for tokens shorter than MIN_TOKEN_LEN", () => {
  const d = dictWith(["paint"]);
  assert.equal(correctToken("pa", d), null);
  assert.equal(correctToken("pai", d), null);
});

test("correctToken: refuses to guess when two SAME-LENGTH dictionary tokens tie at distance 1", () => {
  // Both "rack" and "rock" are 1 edit from "ruck" (a→u and o→u respectively).
  // Same length → genuine ambiguity → refuse to guess.
  const d = dictWith(["rack", "rock"]);
  assert.equal(correctToken("ruck", d), null);
});

test("correctToken: prefers the shorter dictionary token when distance-1 matches differ in length", () => {
  // "paintt" is distance 1 from both "paint" (delete t) AND "paints"
  // (substitute t→s). The base form ("paint") is overwhelmingly the more
  // likely intent. This is the exact case the user reported.
  const d = dictWith(["paint", "paints"]);
  assert.equal(correctToken("paintt", d), "paint");
});

test("correctToken: prefers the shorter form for singular/plural ambiguity", () => {
  const d = dictWith(["puzzle", "puzzles"]);
  assert.equal(correctToken("puzle", d), "puzzle");

  const d2 = dictWith(["candle", "candles"]);
  assert.equal(correctToken("cendle", d2), "candle");
});

test("correctToken: catches first-character edits (vandle → candle)", () => {
  const d = dictWith(["candle"]);
  assert.equal(correctToken("vandle", d), "candle");
});

test("correctToken: handles empty / null input safely", () => {
  const d = dictWith(["paint"]);
  assert.equal(correctToken("", d), null);
  assert.equal(correctToken(null, d), null);
  assert.equal(correctToken(undefined, d), null);
});

test("correctToken: returns null when dictionary is missing or malformed", () => {
  assert.equal(correctToken("paintt", null), null);
  assert.equal(correctToken("paintt", {}), null);
  assert.equal(correctToken("paintt", { buckets: null }), null);
});

// ── correctQuery ─────────────────────────────────────────────────────────

test("correctQuery: rewrites a single-word query with one typo", () => {
  const d = dictWith(["paint"]);
  assert.equal(correctQuery("paintt", d), "paint");
});

test("correctQuery: rewrites only the typo'd token in a multi-word query", () => {
  const d = dictWith(["paint", "brushes"]);
  assert.equal(correctQuery("paintt brushes", d), "paint brushes");
});

test("correctQuery: returns null when no token was changed (already-correct query)", () => {
  const d = dictWith(["paint"]);
  assert.equal(correctQuery("paint", d), null);
});

test("correctQuery: returns null when no token was changed (unknown word with no near match)", () => {
  const d = dictWith(["paint"]);
  assert.equal(correctQuery("zzzzz", d), null);
});

test("correctQuery: leaves short tokens alone (under MIN_TOKEN_LEN)", () => {
  const d = dictWith(["paint", "and"]);
  // "an" is below MIN_TOKEN_LEN, even though it's 1 edit from "and" — refuse.
  assert.equal(correctQuery("an", d), null);
});

test("correctQuery: handles empty / null input safely", () => {
  const d = dictWith(["paint"]);
  assert.equal(correctQuery("", d), null);
  assert.equal(correctQuery(null, d), null);
  assert.equal(correctQuery(undefined, d), null);
});

test("correctQuery: returns null when dictionary is missing", () => {
  assert.equal(correctQuery("paintt", null), null);
});

// ── buildBuckets ─────────────────────────────────────────────────────────

test("buildBuckets: skips tokens shorter than MIN_TOKEN_LEN", () => {
  const buckets = buildBuckets({ pa: {}, pai: {}, paint: {} });
  // Only "paint" (length 5) survives.
  const fLen5 = buckets.get("p|5");
  assert.deepEqual(fLen5, ["paint"]);
});

test("buildBuckets: lowercases dictionary entries", () => {
  const buckets = buildBuckets({ Paint: {}, JERKY: {} });
  assert.ok(buckets.get("p|5")?.includes("paint"));
  assert.ok(buckets.get("j|5")?.includes("jerky"));
});

test("buildBuckets: indexes each token by both first-char + length AND length-only", () => {
  const buckets = buildBuckets({ paint: {} });
  assert.deepEqual(buckets.get("p|5"), ["paint"]);
  assert.deepEqual(buckets.get("*|5"), ["paint"]);
});
