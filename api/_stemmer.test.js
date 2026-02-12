const assert = require("node:assert/strict");
const { test } = require("node:test");

const { simpleStem, stemWords } = require("./_stemmer");

// ── simpleStem suffix rules ─────────────────────────────────────────────────

test("simpleStem: ies → y (companies → company)", () => {
  assert.equal(simpleStem("companies"), "company");
  assert.equal(simpleStem("batteries"), "battery");
  assert.equal(simpleStem("industries"), "industry");
});

test("simpleStem: sses → ss (grasses → grass)", () => {
  assert.equal(simpleStem("grasses"), "grass");
});

test("simpleStem: shes → sh (washes → wash)", () => {
  assert.equal(simpleStem("washes"), "wash");
  assert.equal(simpleStem("dishes"), "dish");
});

test("simpleStem: ches → ch (watches → watch)", () => {
  assert.equal(simpleStem("watches"), "watch");
  assert.equal(simpleStem("matches"), "match");
});

test("simpleStem: xes → x (boxes → box)", () => {
  assert.equal(simpleStem("boxes"), "box");
});

test("simpleStem: zes → z (fizzes → fizz)", () => {
  assert.equal(simpleStem("fizzes"), "fizz");
});

test("simpleStem: ses → se (cases → case)", () => {
  assert.equal(simpleStem("cases"), "case");
  assert.equal(simpleStem("bases"), "base");
});

test("simpleStem: generic trailing s removal", () => {
  assert.equal(simpleStem("widgets"), "widget");
  assert.equal(simpleStem("tools"), "tool");
  assert.equal(simpleStem("products"), "product");
});

// ── simpleStem protected endings ────────────────────────────────────────────

test("simpleStem: preserves words ending in ss", () => {
  assert.equal(simpleStem("glass"), "glass");
  assert.equal(simpleStem("brass"), "brass");
});

test("simpleStem: preserves words ending in us", () => {
  assert.equal(simpleStem("status"), "status");
  assert.equal(simpleStem("campus"), "campus");
});

test("simpleStem: preserves words ending in is", () => {
  assert.equal(simpleStem("basis"), "basis");
  assert.equal(simpleStem("analysis"), "analysis");
  assert.equal(simpleStem("thesis"), "thesis");
});

// ── simpleStem short words ──────────────────────────────────────────────────

test("simpleStem: words < 4 chars are unchanged (lowercased)", () => {
  assert.equal(simpleStem("the"), "the");
  assert.equal(simpleStem("is"), "is");
  assert.equal(simpleStem("a"), "a");
  assert.equal(simpleStem("ABC"), "abc");
});

// ── simpleStem idempotency ──────────────────────────────────────────────────

test("simpleStem is idempotent", () => {
  const words = ["companies", "watches", "boxes", "products", "grasses", "cases", "batteries"];
  for (const w of words) {
    const once = simpleStem(w);
    const twice = simpleStem(once);
    assert.equal(once, twice, `Not idempotent for "${w}": "${once}" → "${twice}"`);
  }
});

// ── simpleStem edge cases ───────────────────────────────────────────────────

test("simpleStem handles empty/null", () => {
  assert.equal(simpleStem(""), "");
  assert.equal(simpleStem(null), "");
  assert.equal(simpleStem(undefined), "");
});

// ── stemWords ───────────────────────────────────────────────────────────────

test("stemWords stems each space-separated word", () => {
  assert.equal(stemWords("organic companies products"), "organic company product");
});

test("stemWords handles empty/null input", () => {
  assert.equal(stemWords(""), "");
  assert.equal(stemWords(null), "");
});
