const assert = require("node:assert/strict");
const { test } = require("node:test");

const { sanitizeKeywords, isRealValue } = require("./_requiredFields");

test("sanitizeKeywords strips navigation/collection noise and preserves products", () => {
  const stats = sanitizeKeywords({
    product_keywords: [
      "SHOP ALL",
      "Store Locator",
      "Best Sellers",
      "New Arrivals",
      "icon-x",
      "close",
      "instagram",
      "order",
      "view",
      "All-Natural Goat Milk Soap",
      "Shampoo Bar",
      "Privacy Policy",
    ].join(", "),
    keywords: [],
  });

  assert.deepEqual(stats.sanitized, ["All-Natural Goat Milk Soap", "Shampoo Bar"]);
  assert.equal(stats.total_raw, 12);
  assert.equal(stats.sanitized_count, 2);
});

test("sanitizeKeywords dedupes case-insensitively", () => {
  const stats = sanitizeKeywords({
    product_keywords: "Shampoo Bar, shampoo bar, SHAMPOO BAR",
    keywords: [],
  });

  assert.deepEqual(stats.sanitized, ["Shampoo Bar"]);
});

test("sanitizeKeywords keeps SKU-like ALL CAPS tokens that contain digits", () => {
  const stats = sanitizeKeywords({
    product_keywords: "SKU 123, BEST SELLERS",
    keywords: [],
  });

  assert.deepEqual(stats.sanitized, ["SKU 123"]);
});

// ── Phase 4.17: glue-word substring rejection bug fix ───────────────────────
//
// Prior to Phase 4.17 the sanitizer's KEYWORD_DISALLOW_TERMS list contained
// "product", "products", "free", "why", "because", "what", "leave", "matters"
// and matched them via substring. That rejected legit category entries like
// "Coconut Products" (observed on Kalustyan's), "Skincare Products",
// "Gluten-Free Pasta", etc. Phase 4.17 moves these to KEYWORD_EXACT_DISALLOW
// so the bare words are still rejected but multi-word categories pass.

test("Phase 4.17: 'X Products' multi-word category keywords are preserved", () => {
  const stats = sanitizeKeywords({
    product_keywords: "Coconut Products, Skincare Products, Cleaning Products, Bath Products",
    keywords: [],
  });
  assert.deepEqual(
    stats.sanitized,
    ["Coconut Products", "Skincare Products", "Cleaning Products", "Bath Products"],
    "multi-word categories ending in 'Products' must not be rejected"
  );
});

test("Phase 4.17: bare 'products' keyword is still rejected (exact-match)", () => {
  const stats = sanitizeKeywords({
    product_keywords: "products, Coconut Products",
    keywords: [],
  });
  assert.deepEqual(
    stats.sanitized,
    ["Coconut Products"],
    "bare 'products' is junk; 'Coconut Products' is legit"
  );
});

test("Phase 4.17: 'Free' as part of multi-word product names is preserved", () => {
  const stats = sanitizeKeywords({
    product_keywords: "Gluten-Free Pasta, Sugar-Free Granola, Tariff-Free Bundle",
    keywords: [],
  });
  assert.deepEqual(
    stats.sanitized,
    ["Gluten-Free Pasta", "Sugar-Free Granola", "Tariff-Free Bundle"],
    "multi-word product names containing 'Free' must not be rejected"
  );
});

test("Phase 4.17: bare 'free' / 'why' / 'because' are still rejected (exact-match)", () => {
  const stats = sanitizeKeywords({
    product_keywords: "free, why, because, what, leave, matters",
    keywords: [],
  });
  assert.deepEqual(
    stats.sanitized,
    [],
    "all bare glue words must be rejected as standalone keywords"
  );
});

// ── isRealValue: data-wins-over-flag for HQ ──────────────────────────────────

test("isRealValue hq returns true for real location string even with hq_unknown=true", () => {
  assert.equal(isRealValue("headquarters_location", "Houston, TX, United States", { hq_unknown: true }), true);
});

test("isRealValue hq returns true for City, State format with hq_unknown=true", () => {
  assert.equal(isRealValue("headquarters_location", "Houston, TX", { hq_unknown: true }), true);
});

test("isRealValue hq returns false for empty string with hq_unknown=true", () => {
  assert.equal(isRealValue("headquarters_location", "", { hq_unknown: true }), false);
});

test("isRealValue hq returns false for sentinel N/A with hq_unknown=true", () => {
  assert.equal(isRealValue("headquarters_location", "N/A", { hq_unknown: true }), false);
});

test("isRealValue hq returns false for null with hq_unknown=true", () => {
  assert.equal(isRealValue("headquarters_location", null, { hq_unknown: true }), false);
});

test("isRealValue hq returns true for structured object with real data and hq_unknown=true", () => {
  assert.equal(
    isRealValue("headquarters_location", { city: "Houston", state: "TX", country: "US" }, { hq_unknown: true }),
    true
  );
});

// ── isRealValue: data-wins-over-flag for mfg ─────────────────────────────────

test("isRealValue mfg returns true for real location array even with mfg_unknown=true", () => {
  assert.equal(isRealValue("manufacturing_locations", ["Guadalajara, Mexico"], { mfg_unknown: true }), true);
});

test("isRealValue mfg returns true for multiple locations with mfg_unknown=true", () => {
  assert.equal(
    isRealValue("manufacturing_locations", ["Guadalajara, Mexico", "Mexico City, Mexico"], { mfg_unknown: true }),
    true
  );
});

test("isRealValue mfg returns false for empty array with mfg_unknown=true", () => {
  assert.equal(isRealValue("manufacturing_locations", [], { mfg_unknown: true }), false);
});

test("isRealValue mfg returns false for placeholder-only array with mfg_unknown=true", () => {
  assert.equal(isRealValue("manufacturing_locations", ["Unknown"], { mfg_unknown: true }), false);
});

test("isRealValue mfg returns false for null with mfg_unknown=true", () => {
  assert.equal(isRealValue("manufacturing_locations", null, { mfg_unknown: true }), false);
});

// ── isRealValue: baseline behavior without _unknown flags ────────────────────

test("isRealValue hq returns true for valid location without _unknown flag", () => {
  assert.equal(isRealValue("headquarters_location", "New York, NY", {}), true);
});

test("isRealValue mfg returns true for valid locations without _unknown flag", () => {
  assert.equal(isRealValue("manufacturing_locations", ["Shanghai, China"], {}), true);
});
