const assert = require("node:assert/strict");
const { test } = require("node:test");

const { stripCdnResizeParams } = require("./_logoImport")._test;

// ── Shopify CDN resize param stripping ───────────────────────────────────────

test("stripCdnResizeParams strips width/height/crop from Shopify CDN URL", () => {
  const url =
    "https://cdn.shopify.com/s/files/1/0123/4567/8901/files/blue_nofill.png?crop=center&height=32&width=32";
  const result = stripCdnResizeParams(url);
  assert.equal(result.includes("width="), false);
  assert.equal(result.includes("height="), false);
  assert.equal(result.includes("crop="), false);
  // Path must be preserved
  assert.ok(result.includes("/blue_nofill.png"));
  assert.ok(result.startsWith("https://cdn.shopify.com/"));
});

test("stripCdnResizeParams strips w/h shorthand params from Shopify CDN URL", () => {
  const url = "https://cdn.shopify.com/s/files/logo.png?w=100&h=100&fit=cover";
  const result = stripCdnResizeParams(url);
  assert.equal(result.includes("w="), false);
  assert.equal(result.includes("h="), false);
  assert.equal(result.includes("fit="), false);
});

test("stripCdnResizeParams preserves non-resize params on Shopify CDN URL", () => {
  const url = "https://cdn.shopify.com/s/files/logo.png?v=1234567890&width=32";
  const result = stripCdnResizeParams(url);
  assert.ok(result.includes("v=1234567890"));
  assert.equal(result.includes("width="), false);
});

test("stripCdnResizeParams handles Shopify CDN subdomain variations", () => {
  const url = "https://assets.shopify.com/path/image.png?height=64&width=64";
  const result = stripCdnResizeParams(url);
  assert.equal(result.includes("height="), false);
  assert.equal(result.includes("width="), false);
});

// ── Non-CDN URLs unchanged ───────────────────────────────────────────────────

test("stripCdnResizeParams leaves non-CDN URL with query params unchanged", () => {
  const url = "https://example.com/logo.png?width=200&height=100";
  const result = stripCdnResizeParams(url);
  assert.equal(result, url);
});

test("stripCdnResizeParams leaves URL with no params unchanged", () => {
  const url = "https://cdn.shopify.com/s/files/logo.png";
  const result = stripCdnResizeParams(url);
  assert.equal(result, url);
});

test("stripCdnResizeParams leaves non-CDN URL without params unchanged", () => {
  const url = "https://example.com/images/logo.svg";
  const result = stripCdnResizeParams(url);
  assert.equal(result, url);
});

// ── SVG fm= stripping (backward compat) ─────────────────────────────────────

test("stripCdnResizeParams strips fm= from SVG URL on any host", () => {
  const url = "https://images.ctfassets.net/brand/logo.svg?fm=webp";
  const result = stripCdnResizeParams(url);
  assert.equal(result.includes("fm="), false);
  assert.ok(result.includes("/logo.svg"));
});

test("stripCdnResizeParams does not strip fm= from non-SVG URL on non-CDN host", () => {
  const url = "https://example.com/logo.png?fm=webp";
  const result = stripCdnResizeParams(url);
  assert.equal(result, url);
});

// ── Edge cases ───────────────────────────────────────────────────────────────

test("stripCdnResizeParams handles invalid URL gracefully", () => {
  const result = stripCdnResizeParams("not-a-url");
  assert.equal(result, "not-a-url");
});

test("stripCdnResizeParams handles empty string", () => {
  const result = stripCdnResizeParams("");
  assert.equal(result, "");
});
