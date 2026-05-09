// _homepagePrefetch.test.js
// Phase 2.12 — pure-helper tests for homepage pre-fetch. We mock
// globalThis.fetch so we don't make real network calls during testing.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  prefetchHomepageContext,
  extractTextFromHtml,
  safeWebsiteUrl,
  buildSubPageUrl,
} = require("./_homepagePrefetch");

// ── Pure-helper tests ───────────────────────────────────────────────────────

test("safeWebsiteUrl normalizes raw input", () => {
  assert.equal(safeWebsiteUrl("https://acme.com").hostname, "acme.com");
  assert.equal(safeWebsiteUrl("acme.com").hostname, "acme.com");
  assert.equal(safeWebsiteUrl("https://acme.com/path").hostname, "acme.com");
});

test("safeWebsiteUrl rejects invalid input", () => {
  assert.equal(safeWebsiteUrl(""), null);
  assert.equal(safeWebsiteUrl(null), null);
  assert.equal(safeWebsiteUrl("not a url"), null);
  assert.equal(safeWebsiteUrl("http://"), null);
});

test("buildSubPageUrl builds correct sub-page URLs", () => {
  const base = safeWebsiteUrl("https://acme.com");
  assert.equal(buildSubPageUrl(base, "/about"), "https://acme.com/about");
  assert.equal(buildSubPageUrl(base, "/"), "https://acme.com/");
  assert.equal(buildSubPageUrl(base, "/about-us"), "https://acme.com/about-us");
});

test("extractTextFromHtml strips tags and extracts title + meta description", () => {
  const html = `
    <html>
      <head>
        <title>Acme Corp — Quality Widgets</title>
        <meta name="description" content="We make widgets since 1972.">
        <script>var x = 1;</script>
        <style>body { color: red; }</style>
      </head>
      <body>
        <h1>Welcome</h1>
        <p>Acme has been making widgets for over 50 years.</p>
        <noscript>Enable JS</noscript>
      </body>
    </html>
  `;
  const text = extractTextFromHtml(html);
  assert.ok(/Title: Acme Corp — Quality Widgets/.test(text), "title preserved");
  assert.ok(/Description: We make widgets since 1972./.test(text), "meta description preserved");
  assert.ok(/Welcome/.test(text), "body content preserved");
  assert.ok(/Acme has been making widgets/.test(text), "body paragraph preserved");
  assert.ok(!/<script>/.test(text), "script tags stripped");
  assert.ok(!/var x = 1/.test(text), "script content stripped");
  assert.ok(!/<style>/.test(text), "style tags stripped");
  assert.ok(!/color: red/.test(text), "style content stripped");
  assert.ok(!/<noscript>/.test(text), "noscript stripped");
});

test("extractTextFromHtml decodes common HTML entities", () => {
  const html = "<p>Acme &amp; Co. &mdash; over 50 years &nbsp;old</p>";
  const text = extractTextFromHtml(html);
  assert.ok(text.includes("Acme & Co."), "&amp; decoded");
  assert.ok(/over 50 years\s+old/.test(text), "&nbsp; decoded to space");
});

test("extractTextFromHtml handles missing title and meta gracefully", () => {
  const html = "<html><body><p>Just body text.</p></body></html>";
  const text = extractTextFromHtml(html);
  assert.ok(text.includes("Just body text."));
  assert.ok(!text.startsWith("Title:"), "no Title prefix when title missing");
});

test("extractTextFromHtml returns empty string for invalid input", () => {
  assert.equal(extractTextFromHtml(""), "");
  assert.equal(extractTextFromHtml(null), "");
  assert.equal(extractTextFromHtml(undefined), "");
});

// ── prefetchHomepageContext (with mocked fetch) ─────────────────────────────

async function withMockFetch(handler, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("prefetchHomepageContext returns empty context for invalid websiteUrl", async () => {
  const result = await prefetchHomepageContext({ websiteUrl: "" });
  assert.equal(result.context, "");
  assert.equal(result.diagnostics.skip_reason, "invalid_website_url");
  assert.equal(result.diagnostics.pages_attempted, 0);
});

test("prefetchHomepageContext returns combined extracted text from successful fetches", async () => {
  await withMockFetch(
    async (url) => {
      const path = new URL(url).pathname;
      if (path === "/" || path === "/about") {
        return new Response(
          `<html><head><title>Test ${path}</title></head><body><p>Body for ${path}.</p></body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }
      return new Response("Not Found", { status: 404 });
    },
    async () => {
      const result = await prefetchHomepageContext({
        websiteUrl: "https://acme.com",
        subPaths: ["/", "/about"],
      });
      assert.ok(result.context.length > 0, "context must be non-empty on success");
      assert.ok(/Test \//.test(result.context), "homepage title in context");
      assert.ok(/Test \/about/.test(result.context), "about-page title in context");
      assert.equal(result.diagnostics.pages_attempted, 2);
      assert.equal(result.diagnostics.pages_ok, 2);
      assert.equal(result.diagnostics.pages_with_text, 2);
    }
  );
});

test("prefetchHomepageContext gracefully handles fetch errors (returns empty)", async () => {
  await withMockFetch(
    async () => {
      throw new Error("connection refused");
    },
    async () => {
      const result = await prefetchHomepageContext({
        websiteUrl: "https://offline-brand.example",
        subPaths: ["/"],
      });
      assert.equal(result.context, "", "empty context on fetch failure");
      assert.equal(result.diagnostics.pages_ok, 0);
      assert.ok(result.diagnostics.per_page[0].error.includes("connection refused"));
    }
  );
});

test("prefetchHomepageContext gracefully handles non-HTML content type", async () => {
  await withMockFetch(
    async () =>
      new Response("PDF binary data", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    async () => {
      const result = await prefetchHomepageContext({
        websiteUrl: "https://pdf-only.example",
        subPaths: ["/"],
      });
      assert.equal(result.context, "");
      assert.ok(result.diagnostics.per_page[0].error.startsWith("non_html_content_type:"));
    }
  );
});

test("prefetchHomepageContext gracefully handles HTTP error responses", async () => {
  await withMockFetch(
    async () => new Response("Forbidden", { status: 403 }),
    async () => {
      const result = await prefetchHomepageContext({
        websiteUrl: "https://blocked.example",
        subPaths: ["/"],
      });
      assert.equal(result.context, "");
      assert.equal(result.diagnostics.per_page[0].error, "http_403");
    }
  );
});

test("prefetchHomepageContext caps total context at maxChars", async () => {
  await withMockFetch(
    async () => {
      const longBody = "<html><body>" + "x".repeat(50000) + "</body></html>";
      return new Response(longBody, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    },
    async () => {
      const result = await prefetchHomepageContext({
        websiteUrl: "https://big-site.example",
        subPaths: ["/", "/about", "/about-us"],
        maxChars: 1000,
        perPageChars: 500,
      });
      assert.ok(result.context.length <= 1000, `context must be <= 1000 chars, got ${result.context.length}`);
      assert.equal(result.diagnostics.truncated, true);
    }
  );
});

test("prefetchHomepageContext respects parent abort signal", async () => {
  const ac = new AbortController();
  ac.abort("test abort");
  const result = await prefetchHomepageContext({
    websiteUrl: "https://acme.com",
    signal: ac.signal,
  });
  // Each fetch returns parent_aborted; context is empty.
  assert.equal(result.context, "");
});
