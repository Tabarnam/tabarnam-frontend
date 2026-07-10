const { test, afterEach } = require("node:test");
const assert = require("node:assert");

const {
  lookupCompanyUrl,
  lookupCompanyUrlsBatch,
  normalizeUrl,
  isRejectedHost,
  hostOf,
  parseJsonLoose,
} = require("./_companyUrlLookup");

// The real xAI client honors a global stub before any network/test-mode
// short-circuit — use it to make lookups deterministic and offline.
function setStub(fn) {
  globalThis.__xaiLiveSearchStub = fn;
}
afterEach(() => { delete globalThis.__xaiLiveSearchStub; });

const asXaiText = (obj) => ({ ok: true, resp: { output_text: JSON.stringify(obj) } });

test("normalizeUrl coerces to https origin and rejects junk", () => {
  assert.strictEqual(normalizeUrl("goodbrand.com"), "https://goodbrand.com");
  assert.strictEqual(normalizeUrl("https://www.foo.com/path?q=1"), "https://www.foo.com");
  assert.strictEqual(normalizeUrl("not a url"), "");
  assert.strictEqual(normalizeUrl(""), "");
});

test("isRejectedHost blocks marketplaces, socials, and the source host", () => {
  assert.strictEqual(isRejectedHost("amazon.com"), true);
  assert.strictEqual(isRejectedHost("facebook.com"), true);
  assert.strictEqual(isRejectedHost(hostOf("https://mammothnation.com/x"), "mammothnation.com"), true);
  assert.strictEqual(isRejectedHost("goodbrand.com", "mammothnation.com"), false);
});

test("lookupCompanyUrl returns a normalized owned URL on a good hit", async () => {
  setStub(async () => asXaiText({ found: true, website_url: "goodbrand.com", confidence: 0.9 }));
  const r = await lookupCompanyUrl("GoodBrand", { sourceUrl: "https://mammothnation.com/" });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.website_url, "https://goodbrand.com");
  assert.strictEqual(r.confidence, 0.9);
});

test("lookupCompanyUrl rejects a marketplace URL as not-owned", async () => {
  setStub(async () => asXaiText({ found: true, website_url: "https://www.amazon.com/stores/x", confidence: 0.8 }));
  const r = await lookupCompanyUrl("MarketBrand", { sourceUrl: "https://mammothnation.com/" });
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.website_url, "");
  assert.strictEqual(r.error, "rejected_marketplace_host");
});

test("lookupCompanyUrl rejects the source marketplace itself", async () => {
  setStub(async () => asXaiText({ found: true, website_url: "https://mammothnation.com/collections/x", confidence: 0.7 }));
  const r = await lookupCompanyUrl("SourceBrand", { sourceUrl: "https://mammothnation.com/" });
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.error, "rejected_marketplace_host");
});

test("lookupCompanyUrl reports not_found when model gives up", async () => {
  setStub(async () => asXaiText({ found: false, website_url: "", confidence: 0 }));
  const r = await lookupCompanyUrl("UnknownBrand", {});
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.error, "not_found");
});

test("lookupCompanyUrl surfaces xAI failure without throwing", async () => {
  setStub(async () => ({ ok: false, error: "upstream_timeout" }));
  const r = await lookupCompanyUrl("SlowBrand", {});
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.error, "upstream_timeout");
});

test("parseJsonLoose handles fences, prose, and junk", () => {
  assert.deepStrictEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(parseJsonLoose('Here is the result: {"a":1} hope that helps'), { a: 1 });
  assert.strictEqual(parseJsonLoose("no json here"), null);
  assert.strictEqual(parseJsonLoose(""), null);
});

test("lookupCompanyUrl parses a fence-wrapped model response", async () => {
  setStub(async () => ({
    ok: true,
    resp: { output_text: '```json\n{"found": true, "website_url": "https://fencebrand.com", "confidence": 0.7}\n```' },
  }));
  const r = await lookupCompanyUrl("FenceBrand", {});
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.website_url, "https://fencebrand.com");
});

test("lookupCompanyUrl surfaces upstream HTTP status in the error", async () => {
  setStub(async () => ({ ok: false, error: "upstream_http_400", diagnostics: { upstream_http_status: 400 } }));
  const r = await lookupCompanyUrl("BadPayloadBrand", {});
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.error, "upstream_http_400 (http 400)");
});

test("lookupCompanyUrlsBatch preserves input order", async () => {
  setStub(async ({ prompt }) => {
    if (prompt.includes("AlphaCo")) return asXaiText({ found: true, website_url: "alpha.com", confidence: 1 });
    if (prompt.includes("BetaCo")) return asXaiText({ found: true, website_url: "beta.com", confidence: 1 });
    return asXaiText({ found: false, website_url: "", confidence: 0 });
  });
  const { results } = await lookupCompanyUrlsBatch(["AlphaCo", "GammaCo", "BetaCo"], { concurrency: 3 });
  assert.strictEqual(results.length, 3);
  assert.strictEqual(results[0].website_url, "https://alpha.com");
  assert.strictEqual(results[1].found, false);
  assert.strictEqual(results[2].website_url, "https://beta.com");
});
