const { test } = require("node:test");

const { sanitizeKeywords } = require("./_requiredFields");

test("sanitizeKeywords strips navigation/collection noise and preserves products", () => {
  const stats = sanitizeKeywords({
    product_keywords: [
      "SHOP ALL",
      "Store Locator",
      "Best Sellers",
      "New Arrivals",
      "All-Natural Goat Milk Soap",
      "Shampoo Bar",
      "Privacy Policy",
    ].join(", "),
    keywords: [],
  });

  assert.deepEqual(stats.sanitized, ["All-Natural Goat Milk Soap", "Shampoo Bar"]);
  assert.equal(stats.total_raw, 7);
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
