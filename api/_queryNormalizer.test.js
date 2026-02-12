const assert = require("node:assert/strict");
const { test } = require("node:test");

const { normalizeQuery, compactQuery, parseQuery } = require("./_queryNormalizer");

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
