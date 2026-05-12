"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  stripUnicodeEscapeLeaks,
  isQualityNounPhraseEntry,
  cleanNounPhraseArray,
  cleanProductKeywordsString,
  shapeEnrichedFromParsed,
} = require("./_canonicalImport");

const {
  normalizeCuratedReviewSchema,
  dedupeCuratedReviews,
} = require("./import-start/_importStartCompanyUtils");

// ── Phase 3.7 — Unicode escape leaks (Slap Ya Mama bug) ──────────────────────
//
// Empirical (Slap Ya Mama 2026-05-11): model emitted
// `industries: ["Cajun Seasonings ⚡"]` — emoji decoration from the homepage
// preserved as literal escape text. Same pattern for any Unicode dingbat /
// symbol the source page uses for visual flair.

test("Phase 3.7: stripUnicodeEscapeLeaks removes emoji escape sequences", () => {
  assert.equal(stripUnicodeEscapeLeaks("Cajun Seasonings \\u26A1"), "Cajun Seasonings");
  assert.equal(stripUnicodeEscapeLeaks("Hot Sauces \\u26A1"), "Hot Sauces");
});

test("Phase 3.7: stripUnicodeEscapeLeaks tolerates strings without escapes", () => {
  assert.equal(stripUnicodeEscapeLeaks("Plain Industry Label"), "Plain Industry Label");
  assert.equal(stripUnicodeEscapeLeaks(""), "");
});

test("Phase 3.7: stripUnicodeEscapeLeaks strips trailing whitespace and commas left after escape removal", () => {
  assert.equal(stripUnicodeEscapeLeaks("Some Label \\u26A1, "), "Some Label");
});

test("Phase 3.7: stripUnicodeEscapeLeaks tolerates non-string input", () => {
  assert.equal(stripUnicodeEscapeLeaks(null), null);
  assert.equal(stripUnicodeEscapeLeaks(undefined), undefined);
  assert.deepEqual(stripUnicodeEscapeLeaks([]), []);
});

// ── Phase 3.7 — Industry quality filter (Simple Mills "baking" bug) ──────────

test("Phase 3.7: isQualityNounPhraseEntry rejects lowercase single-word entries by default", () => {
  // "baking" appeared in Simple Mills industries — clearly truncated bleed.
  assert.equal(isQualityNounPhraseEntry("baking"), false);
  assert.equal(isQualityNounPhraseEntry("cookware"), false);
  // Title-cased versions are fine.
  assert.equal(isQualityNounPhraseEntry("Baking"), true);
  // Multi-word lowercase still fine (real product keyword shape).
  assert.equal(isQualityNounPhraseEntry("hot sauce"), true);
});

test("Phase 3.7: isQualityNounPhraseEntry allows lowercase single-word when opted in", () => {
  // For product_keywords ("hot sauce", "cookware" are legitimate).
  assert.equal(isQualityNounPhraseEntry("baking", { allowLowercaseSingleWord: true }), true);
  assert.equal(isQualityNounPhraseEntry("cookware", { allowLowercaseSingleWord: true }), true);
});

test("Phase 3.7: isQualityNounPhraseEntry rejects too-short or non-letter entries", () => {
  assert.equal(isQualityNounPhraseEntry("a"), false);
  assert.equal(isQualityNounPhraseEntry("ab"), false);
  assert.equal(isQualityNounPhraseEntry("123"), false);
  assert.equal(isQualityNounPhraseEntry("•"), false);
  assert.equal(isQualityNounPhraseEntry(""), false);
});

test("Phase 3.7: cleanNounPhraseArray dedupes case-insensitively and preserves first occurrence", () => {
  const out = cleanNounPhraseArray([
    "Cajun Seasonings",
    "Hot Sauces",
    "cajun seasonings",  // dup
    "Hot Sauces",         // dup
    "baking",             // single-word lowercase → dropped
    "Snack Crackers",
  ]);
  assert.deepEqual(out, ["Cajun Seasonings", "Hot Sauces", "Snack Crackers"]);
});

test("Phase 3.7: cleanNounPhraseArray applies unicode-escape stripping per entry", () => {
  const out = cleanNounPhraseArray([
    "Cajun Seasonings \\u26A1",
    "Hot Sauces",
  ]);
  assert.deepEqual(out, ["Cajun Seasonings", "Hot Sauces"]);
});

test("Phase 3.7: cleanProductKeywordsString splits, cleans, rejoins", () => {
  const cleaned = cleanProductKeywordsString(
    "Cajun seasonings \\u26A1, hot sauce, , Hot Sauce, baking"
  );
  // Allows lowercase single-word ("baking"), strips escape, dedupes "hot sauce"/"Hot Sauce".
  assert.equal(cleaned, "Cajun seasonings, hot sauce, baking");
});

test("Phase 3.7: cleanProductKeywordsString handles empty input", () => {
  assert.equal(cleanProductKeywordsString(""), "");
  assert.equal(cleanProductKeywordsString("   "), "");
});

// ── Phase 3.7 — shapeEnrichedFromParsed integrates the cleanup ──────────────

test("Phase 3.7: shapeEnrichedFromParsed cleans all string + array fields", () => {
  const parsed = {
    tagline: "Tagline: My Tagline \\u26A1",
    headquarters_location: "HQ: Newport Beach, CA, USA",
    manufacturing_locations: ["USA", "Canada"],
    industries: ["Cajun Seasonings \\u26A1", "baking", "Hot Sauces"],
    product_keywords: "hot sauce \\u26A1, fish fry, ,",
    reviews: [],
  };
  const out = shapeEnrichedFromParsed(parsed);
  // Tagline: label stripped + unicode stripped.
  assert.equal(out.tagline, "My Tagline");
  // HQ: label stripped.
  assert.equal(out.headquarters_location, "Newport Beach, CA, USA");
  // Industries: unicode stripped + "baking" filtered.
  assert.deepEqual(out.industries, ["Cajun Seasonings", "Hot Sauces"]);
  // Manufacturing: country-only allowed (allowLowercaseSingleWord = true).
  assert.deepEqual(out.manufacturing_locations, ["USA", "Canada"]);
  // Product keywords: unicode stripped + lowercase single-word allowed + empty tokens dropped.
  assert.equal(out.product_keywords, "hot sauce, fish fry");
});

// ── Phase 3.7 — curated_reviews schema normalization ─────────────────────────

test("Phase 3.7: normalizeCuratedReviewSchema maps source_name → source", () => {
  const out = normalizeCuratedReviewSchema({
    source_name: "YouTube",
    author: "Some Reviewer",
    url: "https://www.youtube.com/watch?v=abc",
    title: "Review",
    date: "2024-01-01",
    text: "great",
  });
  assert.equal(out.source, "YouTube");
  assert.equal(out.source_name, undefined, "source_name alias should be pruned");
});

test("Phase 3.7: normalizeCuratedReviewSchema maps excerpt/abstract/content → text", () => {
  // Legacy editorial-reviews path emits all four fields with the same value.
  // After normalization we keep ONLY `text`.
  const out = normalizeCuratedReviewSchema({
    source_name: "Blog",
    author: "Author",
    url: "https://blog.example/post",
    title: "Title",
    date: "2024",
    text: "",
    excerpt: "Excerpt content",
    abstract: "Abstract content",
    content: "Content content",
  });
  // text was empty → falls through to excerpt (first non-empty).
  assert.equal(out.text, "Excerpt content");
  assert.equal(out.excerpt, undefined);
  assert.equal(out.abstract, undefined);
  assert.equal(out.content, undefined);
});

test("Phase 3.7: normalizeCuratedReviewSchema preserves text when present (doesn't override)", () => {
  const out = normalizeCuratedReviewSchema({
    source: "X",
    author: "Y",
    url: "https://x.example/p",
    title: "T",
    date: "D",
    text: "Real text here",
    excerpt: "Excerpt to ignore",
  });
  assert.equal(out.text, "Real text here");
});

test("Phase 3.7: dedupeCuratedReviews normalizes mixed schemas and dedupes", () => {
  // Same review surfaced via two different paths with different schemas.
  // Without normalization, the dedupe key would differ between them.
  const reviews = [
    {
      source: "YouTube",
      author: "Reviewer A",
      url: "https://www.youtube.com/watch?v=abc",
      title: "Review A",
      date: "2024-01-01",
      text: "ok",
    },
    {
      source_name: "YouTube",   // different key for same source
      author: "Reviewer A",
      url: "https://www.youtube.com/watch?v=abc",
      title: "Review A",
      date: "2024-01-01",
      excerpt: "ok",            // different key for same text
    },
    {
      source: "Blog",
      author: "Reviewer B",
      url: "https://blog.example/post",
      title: "Review B",
      date: "2024-02-01",
      text: "good",
    },
  ];
  const out = dedupeCuratedReviews(reviews);
  assert.equal(out.length, 2, "duplicates across schemas must be collapsed");
  // All output entries use the canonical schema.
  for (const r of out) {
    assert.ok(typeof r.source === "string" && r.source.length > 0, "all entries must have `source` (not source_name)");
    assert.equal(r.source_name, undefined);
    assert.equal(r.excerpt, undefined);
    assert.equal(r.abstract, undefined);
    assert.equal(r.content, undefined);
  }
});

test("Phase 3.7: dedupeCuratedReviews tolerates null / malformed inputs", () => {
  assert.deepEqual(dedupeCuratedReviews(null), []);
  assert.deepEqual(dedupeCuratedReviews(undefined), []);
  assert.deepEqual(dedupeCuratedReviews([null, undefined, "not-an-object", 123]), []);
});
