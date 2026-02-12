const assert = require("node:assert/strict");
const { test } = require("node:test");

const { computeProfileCompleteness } = require("./_profileCompleteness");

test("computeProfileCompleteness returns 100 for fully complete company", () => {
  const result = computeProfileCompleteness({
    tagline: "Best widgets ever",
    industries: ["Manufacturing", "Technology"],
    product_keywords: "widget, gadget, tool, device, component, part, assembly, module, kit, element, unit, piece, system, block, adapter",
    headquarters_location: "Austin, TX",
    manufacturing_locations: ["Detroit, MI"],
    curated_reviews: [{ title: "Great" }],
  });
  assert.equal(result.profile_completeness, 100);
  assert.equal(result.profile_completeness_version, 1);
});

test("computeProfileCompleteness returns 0 for empty company", () => {
  const result = computeProfileCompleteness({});
  assert.equal(result.profile_completeness, 0);
});

test("computeProfileCompleteness scores tagline as 20 points", () => {
  const with_ = computeProfileCompleteness({ tagline: "Something" });
  const without = computeProfileCompleteness({});
  assert.equal(with_.profile_completeness - without.profile_completeness, 20);
});

test("computeProfileCompleteness scores industries as 15 points", () => {
  const with_ = computeProfileCompleteness({ industries: ["Tech"] });
  const without = computeProfileCompleteness({});
  assert.equal(with_.profile_completeness - without.profile_completeness, 15);
});

test("computeProfileCompleteness keyword tiers: 3 keywords = 8 pts", () => {
  const result = computeProfileCompleteness({ product_keywords: "a, b, c" });
  assert.equal(result.profile_completeness, 8);
  assert.equal(result.profile_completeness_meta.keywords_count, 3);
});

test("computeProfileCompleteness keyword tiers: 8 keywords = 15 pts", () => {
  const result = computeProfileCompleteness({ product_keywords: "a, b, c, d, e, f, g, h" });
  assert.equal(result.profile_completeness, 15);
});

test("computeProfileCompleteness keyword tiers: 15 keywords = 20 pts", () => {
  const kw = Array.from({ length: 15 }, (_, i) => `kw${i}`).join(", ");
  const result = computeProfileCompleteness({ product_keywords: kw });
  assert.equal(result.profile_completeness, 20);
});

test("computeProfileCompleteness scores HQ as 15 points", () => {
  const result = computeProfileCompleteness({ headquarters_location: "NYC" });
  assert.equal(result.profile_completeness, 15);
});

test("computeProfileCompleteness scores manufacturing as 15 points", () => {
  const result = computeProfileCompleteness({ manufacturing_locations: ["Detroit"] });
  assert.equal(result.profile_completeness, 15);
});

test("computeProfileCompleteness scores reviews as 15 points", () => {
  const result = computeProfileCompleteness({ curated_reviews: [{ title: "Good" }] });
  assert.equal(result.profile_completeness, 15);
});

test("computeProfileCompleteness detects reviews from review_count", () => {
  const result = computeProfileCompleteness({ review_count: 5 });
  assert.equal(result.profile_completeness_meta.has_reviews, true);
});

test("computeProfileCompleteness handles null input", () => {
  const result = computeProfileCompleteness(null);
  assert.equal(result.profile_completeness, 0);
});

test("computeProfileCompleteness meta includes all fields", () => {
  const result = computeProfileCompleteness({});
  const meta = result.profile_completeness_meta;
  assert.equal(meta.has_tagline, false);
  assert.equal(meta.industries_count, 0);
  assert.equal(meta.keywords_count, 0);
  assert.equal(meta.has_hq, false);
  assert.equal(meta.has_mfg, false);
  assert.equal(meta.has_reviews, false);
});
