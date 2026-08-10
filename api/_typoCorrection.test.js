const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildBuckets,
  correctToken,
  correctQuery,
  getDictionary,
  _resetCache,
} = require("./_typoCorrection");

function dictWith(terms) {
  const map = {};
  for (const t of terms) map[t] = {};
  return { buckets: buildBuckets(map) };
}

// Like dictWith but also supplies a name-token protection set — tokens
// that are real company-name words and must never be auto-corrected.
function dictWithNames(terms, nameTokens) {
  const map = {};
  for (const t of terms) map[t] = {};
  return { buckets: buildBuckets(map), nameTokens: new Set(nameTokens) };
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

test("correctToken: does NOT correct a token that is a real company-name token (Pillowz)", () => {
  // "pillow" is in the correction dictionary; "pillowz" is 1 edit away.
  // But "pillowz" is ALSO a real brand name token → must be protected.
  const d = dictWithNames(["pillow"], ["pillowz", "pillow"]);
  assert.equal(correctToken("pillowz", d), null);
});

test("correctToken: still corrects a typo when it's NOT a protected name token", () => {
  // "pillowx" is a genuine typo (not a brand). It should correct to "pillow".
  const d = dictWithNames(["pillow"], ["pillowz", "pillow"]);
  assert.equal(correctToken("pillowx", d), "pillow");
});

test("correctToken: protects deliberately-misspelled brands (froot, lyft)", () => {
  const d = dictWithNames(
    ["fruit", "lift"],
    ["froot", "lyft", "fruit", "lift"]
  );
  assert.equal(correctToken("froot", d), null); // brand, don't correct
  assert.equal(correctToken("lyft", d), null);  // brand, don't correct
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

// ── stale-while-revalidate ──────────────────────────────────────────────────
// Rebuilding scans the whole companies container (seconds in prod). A STALE
// cache must be served immediately and refreshed in the BACKGROUND — never
// awaited in a request path. Regression guard for the "first search after the
// 15-min expiry takes a few seconds" stall.

function slowScanContainer(delayMs, counter) {
  return {
    items: {
      query: () => ({
        getAsyncIterator: async function* () {
          counter.scans++;
          await new Promise((r) => setTimeout(r, delayMs));
          // ≥ MIN_COMPANIES_PER_TOKEN (2) companies share these tokens, so the
          // frequency threshold keeps them and the build returns a real dict.
          yield {
            resources: [
              { company_name: "Alpha Coffee Roasters", keywords: ["coffee", "beans"], industries: ["Coffee"] },
              { company_name: "Bravo Coffee Roasters", keywords: ["coffee", "beans"], industries: ["Coffee"] },
            ],
          };
        },
      }),
    },
    item: () => ({ read: async () => ({ resource: null }) }),
  };
}

test("getDictionary: a STALE cache is served immediately and refreshed in the background", async () => {
  _resetCache();
  const counter = { scans: 0 };
  const SCAN_MS = 150;
  const container = slowScanContainer(SCAN_MS, counter);

  // Cold build populates the cache (this one legitimately waits).
  const cold0 = Date.now();
  const built = await getDictionary(container);
  const coldMs = Date.now() - cold0;
  assert.ok(built && built.termCount > 0, "cold build populates the cache");
  assert.ok(coldMs >= SCAN_MS, `cold build performs the scan (${coldMs}ms)`);
  assert.equal(counter.scans, 1);

  // Force staleness by advancing the clock past the 15-minute TTL.
  const realNow = Date.now;
  Date.now = () => realNow() + 16 * 60 * 1000;
  let staleMs;
  let served;
  try {
    const t0 = realNow();
    served = await getDictionary(container);
    staleMs = realNow() - t0;
  } finally {
    Date.now = realNow;
  }

  assert.ok(served && served.termCount > 0, "stale call still returns a usable dictionary");
  assert.ok(
    staleMs < SCAN_MS,
    `stale call must NOT wait for the rescan (took ${staleMs}ms, scan is ${SCAN_MS}ms)`
  );
  assert.equal(counter.scans, 2, "but it DOES kick a background refresh");

  // Let the background refresh settle so it doesn't leak into other tests.
  await new Promise((r) => setTimeout(r, SCAN_MS * 2));
});
