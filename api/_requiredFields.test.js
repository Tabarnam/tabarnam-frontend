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
