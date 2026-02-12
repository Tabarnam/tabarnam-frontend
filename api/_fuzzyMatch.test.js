const assert = require("node:assert/strict");
const { test } = require("node:test");

const { levenshtein, maxEditDistance, isFuzzyNameMatch, fuzzyScore } = require("./_fuzzyMatch");

// ── levenshtein ─────────────────────────────────────────────────────────────

test("levenshtein returns 0 for identical strings", () => {
  assert.equal(levenshtein("abc", "abc"), 0);
});

test("levenshtein returns length for empty vs non-empty", () => {
  assert.equal(levenshtein("", "abc"), 3);
  assert.equal(levenshtein("abc", ""), 3);
});

test("levenshtein returns 0 for two empty strings", () => {
  assert.equal(levenshtein("", ""), 0);
});

test("levenshtein computes single-char substitution", () => {
  assert.equal(levenshtein("cat", "bat"), 1);
});

test("levenshtein computes single-char insertion", () => {
  assert.equal(levenshtein("cat", "cats"), 1);
});

test("levenshtein computes single-char deletion", () => {
  assert.equal(levenshtein("cats", "cat"), 1);
});

test("levenshtein computes multi-edit distance", () => {
  assert.equal(levenshtein("kitten", "sitting"), 3);
});

test("levenshtein handles completely different strings", () => {
  assert.equal(levenshtein("abc", "xyz"), 3);
});

// ── maxEditDistance ──────────────────────────────────────────────────────────

test("maxEditDistance returns 0 for very short words (<=3)", () => {
  assert.equal(maxEditDistance(1), 0);
  assert.equal(maxEditDistance(2), 0);
  assert.equal(maxEditDistance(3), 0);
});

test("maxEditDistance returns 1 for short words (4-5)", () => {
  assert.equal(maxEditDistance(4), 1);
  assert.equal(maxEditDistance(5), 1);
});

test("maxEditDistance returns 2 for medium words (6-8)", () => {
  assert.equal(maxEditDistance(6), 2);
  assert.equal(maxEditDistance(7), 2);
  assert.equal(maxEditDistance(8), 2);
});

test("maxEditDistance returns 3 for long words (>8)", () => {
  assert.equal(maxEditDistance(9), 3);
  assert.equal(maxEditDistance(20), 3);
});

// ── isFuzzyNameMatch ────────────────────────────────────────────────────────

test("isFuzzyNameMatch returns true for exact match", () => {
  assert.equal(isFuzzyNameMatch("Acme Corp", "acme corp"), true);
});

test("isFuzzyNameMatch returns true for one-char typo", () => {
  assert.equal(isFuzzyNameMatch("Acme Corp", "acne corp"), true);
});

test("isFuzzyNameMatch returns true for space variations (compact match)", () => {
  assert.equal(isFuzzyNameMatch("Apple Systems", "applesystems"), true);
});

test("isFuzzyNameMatch returns false for very different strings", () => {
  assert.equal(isFuzzyNameMatch("Acme Corp", "Totally Different"), false);
});

test("isFuzzyNameMatch returns false for empty inputs", () => {
  assert.equal(isFuzzyNameMatch("", "test"), false);
  assert.equal(isFuzzyNameMatch("test", ""), false);
  assert.equal(isFuzzyNameMatch(null, "test"), false);
});

test("isFuzzyNameMatch respects custom threshold", () => {
  assert.equal(isFuzzyNameMatch("abc", "xyz", 0), false);
  assert.equal(isFuzzyNameMatch("abc", "xyz", 3), true);
});

// ── fuzzyScore ──────────────────────────────────────────────────────────────

test("fuzzyScore returns 50 for exact match (distance 0)", () => {
  assert.equal(fuzzyScore("acme", "acme"), 50);
});

test("fuzzyScore returns 35 for distance-1 match", () => {
  assert.equal(fuzzyScore("acmee", "acmes"), 35);
});

test("fuzzyScore returns at least 10 for valid match", () => {
  // Distance 3 on a long word: 50 - 3*15 = 5, clamped to 10
  const score = fuzzyScore("abcdefghij", "xbcdefghij");
  assert.ok(score >= 10);
});

test("fuzzyScore returns 0 for non-match", () => {
  assert.equal(fuzzyScore("abc", "xyz"), 0);
});

test("fuzzyScore returns 0 for empty inputs", () => {
  assert.equal(fuzzyScore("", "test"), 0);
  assert.equal(fuzzyScore(null, "test"), 0);
});

test("fuzzyScore tries compact match when full match fails", () => {
  const score = fuzzyScore("apple systems", "applesystems");
  assert.ok(score > 0);
});
