const assert = require("node:assert/strict");
const { test } = require("node:test");

const { normalizeQuery, compactQuery, parseQuery, foldDiacritics } = require("./_queryNormalizer");

// ── normalizeQuery ──────────────────────────────────────────────────────────

test("normalizeQuery lowercases and trims", () => {
  assert.equal(normalizeQuery("  Hello World  "), "hello world");
});

test("normalizeQuery replaces separators with space", () => {
  assert.equal(normalizeQuery("foo-bar_baz.qux/quux"), "foo bar baz qux quux");
});

test("normalizeQuery removes punctuation", () => {
  assert.equal(normalizeQuery("hello! (world)"), "hello world");
  assert.equal(normalizeQuery("it's a \"test\""), "its a test");
});

test("normalizeQuery collapses multiple spaces", () => {
  assert.equal(normalizeQuery("foo   bar     baz"), "foo bar baz");
});

test("normalizeQuery handles empty/null input", () => {
  assert.equal(normalizeQuery(""), "");
  assert.equal(normalizeQuery(null), "");
  assert.equal(normalizeQuery(undefined), "");
});

test("normalizeQuery handles backslash separator", () => {
  assert.equal(normalizeQuery("foo\\bar"), "foo bar");
});

// ── diacritic folding ──────────────────────────────────────────────────────

test("foldDiacritics folds common accented characters", () => {
  assert.equal(foldDiacritics("Béis"), "Beis");
  assert.equal(foldDiacritics("café"), "cafe");
  assert.equal(foldDiacritics("naïve"), "naive");
  assert.equal(foldDiacritics("Zoë"), "Zoe");
  assert.equal(foldDiacritics("niño"), "nino");
  assert.equal(foldDiacritics("résumé"), "resume");
});

test("foldDiacritics handles empty/null", () => {
  assert.equal(foldDiacritics(""), "");
  assert.equal(foldDiacritics(null), "");
  assert.equal(foldDiacritics(undefined), "");
});

test("normalizeQuery folds diacritics so accented and plain queries match", () => {
  assert.equal(normalizeQuery("Béis"), "beis");
  assert.equal(normalizeQuery("beis"), "beis");
  assert.equal(normalizeQuery("café"), "cafe");
  assert.equal(normalizeQuery("naïve"), "naive");
  assert.equal(normalizeQuery("Zoë"), "zoe");
  assert.equal(normalizeQuery("niño"), "nino");
  assert.equal(normalizeQuery("résumé"), "resume");
});

test("parseQuery folds diacritics consistently across all forms", () => {
  const withAccent = parseQuery("Béis");
  const withoutAccent = parseQuery("beis");
  assert.equal(withAccent.q_norm, "beis");
  assert.equal(withAccent.q_compact, "beis");
  assert.equal(withAccent.q_norm, withoutAccent.q_norm);
  assert.equal(withAccent.q_compact, withoutAccent.q_compact);
});

// ── compactQuery ────────────────────────────────────────────────────────────

test("compactQuery removes all spaces", () => {
  assert.equal(compactQuery("hello world test"), "helloworldtest");
});

test("compactQuery handles empty/null", () => {
  assert.equal(compactQuery(""), "");
  assert.equal(compactQuery(null), "");
});

// ── parseQuery ──────────────────────────────────────────────────────────────

test("parseQuery returns all five variants", () => {
  const result = parseQuery("Organic Companies");
  assert.equal(result.q_raw, "Organic Companies");
  assert.equal(result.q_norm, "organic companies");
  assert.equal(result.q_compact, "organiccompanies");
  assert.equal(result.q_stemmed, "organic company");
  assert.equal(result.q_stemmed_compact, "organiccompany");
});

test("parseQuery handles empty input", () => {
  const result = parseQuery("");
  assert.equal(result.q_raw, "");
  assert.equal(result.q_norm, "");
  assert.equal(result.q_compact, "");
  assert.equal(result.q_stemmed, "");
  assert.equal(result.q_stemmed_compact, "");
});

test("parseQuery normalizes separators before stemming", () => {
  const result = parseQuery("foo-bar_baz");
  assert.equal(result.q_norm, "foo bar baz");
  assert.equal(result.q_compact, "foobarbaz");
});
