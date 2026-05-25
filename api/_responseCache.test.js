const test = require("node:test");
const assert = require("node:assert/strict");

const { TTLCache, buildCacheKey } = require("./_responseCache");

// ── TTLCache ────────────────────────────────────────────────────────────

test("TTLCache: get returns null on miss and increments _misses", () => {
  const c = new TTLCache();
  assert.equal(c.get("nope"), null);
  assert.equal(c.stats().misses, 1);
  assert.equal(c.stats().hits, 0);
});

test("TTLCache: get returns the cached value on hit", () => {
  const c = new TTLCache();
  c.set("k", { items: [1, 2, 3] });
  assert.deepEqual(c.get("k"), { items: [1, 2, 3] });
  assert.equal(c.stats().hits, 1);
});

test("TTLCache: entries past their TTL are evicted on next get", async () => {
  const c = new TTLCache({ ttlMs: 30 });
  c.set("k", "old");
  // Wait beyond the TTL.
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(c.get("k"), null);
  assert.equal(c.stats().expirations, 1);
  assert.equal(c.size(), 0);
});

test("TTLCache: LRU eviction drops the least-recently-used entry when full", () => {
  const c = new TTLCache({ maxEntries: 3 });
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  c.get("a"); // mark 'a' as most recent
  c.set("d", 4); // should evict 'b' (now the oldest)
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("c"), 3);
  assert.equal(c.get("d"), 4);
  assert.equal(c.get("b"), null);
  assert.equal(c.stats().evictions, 1);
});

test("TTLCache: re-setting an existing key updates its recency", () => {
  const c = new TTLCache({ maxEntries: 2 });
  c.set("a", 1);
  c.set("b", 2);
  c.set("a", 11); // re-set 'a' — now 'b' is oldest
  c.set("c", 3); // should evict 'b'
  assert.equal(c.get("a"), 11);
  assert.equal(c.get("c"), 3);
  assert.equal(c.get("b"), null);
});

test("TTLCache: stats hit-rate is null until at least one access", () => {
  const c = new TTLCache();
  assert.equal(c.stats().hitRate, null);
});

test("TTLCache: clear empties the cache", () => {
  const c = new TTLCache();
  c.set("a", 1);
  c.set("b", 2);
  c.clear();
  assert.equal(c.size(), 0);
  assert.equal(c.get("a"), null);
});

// ── buildCacheKey ────────────────────────────────────────────────────────

test("buildCacheKey: produces stable output for equivalent param orders", () => {
  const a = buildCacheKey("https://x/api/search-companies?q=candle&sort=stars&take=25");
  const b = buildCacheKey("https://x/api/search-companies?take=25&sort=stars&q=candle");
  assert.equal(a, b);
});

test("buildCacheKey: lowercases case-insensitive values like q + sort", () => {
  const a = buildCacheKey("https://x/api/search-companies?q=Candle&sort=Stars");
  const b = buildCacheKey("https://x/api/search-companies?q=candle&sort=stars");
  assert.equal(a, b);
});

test("buildCacheKey: distinguishes different queries", () => {
  const a = buildCacheKey("https://x/api/search-companies?q=candle");
  const b = buildCacheKey("https://x/api/search-companies?q=puzzle");
  assert.notEqual(a, b);
});

test("buildCacheKey: buckets lat/lng to 2 decimals so close users share entries", () => {
  const a = buildCacheKey("https://x/api/search-companies?q=candle&lat=37.123456&lng=-122.456789");
  const b = buildCacheKey("https://x/api/search-companies?q=candle&lat=37.124000&lng=-122.456001");
  // Both round to 37.12 / -122.46 → identical key.
  assert.equal(a, b);
});

test("buildCacheKey: keeps lat/lng differences past 2-decimal precision distinct", () => {
  const a = buildCacheKey("https://x/api/search-companies?q=candle&lat=37.12&lng=-122.46");
  const b = buildCacheKey("https://x/api/search-companies?q=candle&lat=37.20&lng=-122.46");
  assert.notEqual(a, b);
});

test("buildCacheKey: ignores cache-busting params (_, t, nocache)", () => {
  const a = buildCacheKey("https://x/api/search-companies?q=candle&_=1234567890");
  const b = buildCacheKey("https://x/api/search-companies?q=candle&t=999");
  const c = buildCacheKey("https://x/api/search-companies?q=candle");
  assert.equal(a, c);
  assert.equal(b, c);
});

test("buildCacheKey: returns null when nocache=1 is present", () => {
  assert.equal(
    buildCacheKey("https://x/api/search-companies?q=candle&nocache=1"),
    null
  );
});

test("buildCacheKey: returns null for non-GET methods", () => {
  assert.equal(
    buildCacheKey("https://x/api/search-companies?q=candle", "POST"),
    null
  );
  assert.equal(
    buildCacheKey("https://x/api/search-companies?q=candle", "OPTIONS"),
    null
  );
});

test("buildCacheKey: returns null for URLs with no params", () => {
  assert.equal(buildCacheKey("https://x/api/search-companies"), null);
});

test("buildCacheKey: returns null for malformed URLs", () => {
  assert.equal(buildCacheKey("not a url"), null);
  assert.equal(buildCacheKey(null), null);
});

test("buildCacheKey: quick=1 and full request get DIFFERENT keys", () => {
  // Quick mode and full mode produce different response shapes, so they
  // must NOT share cache entries — otherwise a user requesting full
  // results could be served a partial quick response.
  const quick = buildCacheKey("https://x/api/search-companies?q=candle&quick=1");
  const full = buildCacheKey("https://x/api/search-companies?q=candle");
  assert.notEqual(quick, full);
});

test("buildCacheKey: countOnly=1 and items request get DIFFERENT keys", () => {
  const count = buildCacheKey("https://x/api/search-companies?q=candle&countOnly=1");
  const items = buildCacheKey("https://x/api/search-companies?q=candle");
  assert.notEqual(count, items);
});

test("buildCacheKey: skip+take changes the key (page navigation isn't cached as same)", () => {
  const page1 = buildCacheKey("https://x/api/search-companies?q=candle&skip=0&take=25");
  const page2 = buildCacheKey("https://x/api/search-companies?q=candle&skip=25&take=25");
  assert.notEqual(page1, page2);
});
