const assert = require("node:assert/strict");
const { test } = require("node:test");

const { stripCdnResizeParams, collectInlineSvgCandidates, maybeResolveSvgSpriteReference } = require("./_logoImport")._test;

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

// ── Inline SVG extraction ────────────────────────────────────────────────────

test("collectInlineSvgCandidates extracts SVG from header block", () => {
  const html = `
    <header>
      <svg width="128" height="35" viewBox="0 0 128 35" fill="none">
        <path d="M10 20 L30 20" fill="#141414"/>
      </svg>
      <img src="/product.png" alt="Product">
    </header>
  `;
  const candidates = collectInlineSvgCandidates(html, "https://example.com", {});
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].is_inline_svg, true);
  assert.equal(candidates[0].source, "header");
  assert.equal(candidates[0].strong_signal, true);
  assert.ok(candidates[0].url.startsWith("data:image/svg+xml;base64,"));
  assert.equal(candidates[0].width, 128);
  assert.equal(candidates[0].height, 35);
});

test("collectInlineSvgCandidates skips tiny decorative SVGs (< 24x24)", () => {
  const html = `
    <header>
      <svg width="16" height="16" viewBox="0 0 16 16"><path d="M0 0"/></svg>
      <svg width="12" height="12"><circle r="6"/></svg>
    </header>
  `;
  const candidates = collectInlineSvgCandidates(html, "https://example.com", {});
  assert.equal(candidates.length, 0);
});

test("collectInlineSvgCandidates scores wordmark-shaped SVGs higher", () => {
  const html = `
    <header>
      <svg width="200" height="50" viewBox="0 0 200 50"><path d="M0 0"/></svg>
      <svg width="100" height="100" viewBox="0 0 100 100"><path d="M0 0"/></svg>
    </header>
  `;
  const candidates = collectInlineSvgCandidates(html, "https://example.com", {});
  assert.equal(candidates.length, 2);
  // Wordmark (200x50, aspect ratio 4:1) should score higher than square (100x100)
  const wordmark = candidates.find((c) => c.width === 200);
  const square = candidates.find((c) => c.width === 100);
  assert.ok(wordmark);
  assert.ok(square);
  assert.ok(wordmark.score > square.score, `wordmark score ${wordmark.score} should be > square score ${square.score}`);
});

test("collectInlineSvgCandidates returns empty for blocks with no SVGs", () => {
  const html = `
    <header>
      <img src="/logo.png" alt="Logo">
      <a href="/">Home</a>
    </header>
  `;
  const candidates = collectInlineSvgCandidates(html, "https://example.com", {});
  assert.equal(candidates.length, 0);
});

test("collectInlineSvgCandidates extracts from nav blocks too", () => {
  const html = `
    <nav>
      <svg width="120" height="40" viewBox="0 0 120 40"><path d="M0 0"/></svg>
    </nav>
  `;
  const candidates = collectInlineSvgCandidates(html, "https://example.com", {});
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].width, 120);
});

test("collectInlineSvgCandidates uses viewBox when explicit dimensions missing", () => {
  const html = `
    <header>
      <svg viewBox="0 0 180 60"><path d="M0 0"/></svg>
    </header>
  `;
  const candidates = collectInlineSvgCandidates(html, "https://example.com", {});
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].width, 180);
  assert.equal(candidates[0].height, 60);
});

test("collectInlineSvgCandidates boosts score for logo keyword in SVG", () => {
  const html = `
    <header>
      <svg width="128" height="35" class="logo-icon"><path d="M0 0"/></svg>
    </header>
  `;
  const candidates = collectInlineSvgCandidates(html, "https://example.com", {});
  assert.equal(candidates.length, 1);
  // Base score 225 (180 + 45) + logo signal 80 = 305
  assert.ok(candidates[0].score >= 280, `expected score >= 280, got ${candidates[0].score}`);
});

// ── SVG sprite detection (maybeResolveSvgSpriteReference) ────────────────────

test("maybeResolveSvgSpriteReference detects <use href> as sprite", async () => {
  const svg = `<svg viewBox="0 0 738 123"><use href="/svgs/logo.svg#logo-id"></use></svg>`;
  const result = await maybeResolveSvgSpriteReference(svg, "https://example.com", null);
  assert.equal(result.wasSprite, true);
  // Can't resolve without a real server, so it should fail gracefully
  assert.equal(result.ok, false);
  assert.ok(result.reason, "should have a failure reason");
});

test("maybeResolveSvgSpriteReference returns wasSprite:false for self-contained SVG", async () => {
  const svg = `<svg viewBox="0 0 100 50"><path d="M10 20 L90 20" fill="#000"/></svg>`;
  const result = await maybeResolveSvgSpriteReference(svg, "https://example.com", null);
  assert.equal(result.wasSprite, false);
});

test("maybeResolveSvgSpriteReference detects <use xlink:href> (legacy syntax)", async () => {
  const svg = `<svg viewBox="0 0 200 60"><use xlink:href="/icons/sprite.svg#brand-logo"></use></svg>`;
  const result = await maybeResolveSvgSpriteReference(svg, "https://example.com", null);
  assert.equal(result.wasSprite, true);
});

test("maybeResolveSvgSpriteReference rejects internal-only fragment ref", async () => {
  const svg = `<svg viewBox="0 0 100 50"><use href="#local-symbol"></use></svg>`;
  const result = await maybeResolveSvgSpriteReference(svg, "https://example.com", null);
  assert.equal(result.wasSprite, true);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "svg_sprite_internal_ref_only");
});

test("maybeResolveSvgSpriteReference handles invalid href gracefully", async () => {
  const svg = `<svg viewBox="0 0 100 50"><use href="://broken"></use></svg>`;
  const result = await maybeResolveSvgSpriteReference(svg, "https://example.com", null);
  assert.equal(result.wasSprite, true);
  assert.equal(result.ok, false);
});
