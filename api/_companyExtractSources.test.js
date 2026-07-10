const { test } = require("node:test");
const assert = require("node:assert");

const { extractCompanies, toOrigin } = require("./_companyExtractSources");

// Build a fake fetch that serves Shopify products.json pages from a fixture.
function makeShopifyFetch(pages) {
  // pages: array of product arrays, one per page (1-indexed via ?page=)
  return async (url) => {
    const u = new URL(url);
    const page = Number(u.searchParams.get("page") || "1");
    const products = pages[page - 1] || [];
    return {
      status: 200,
      ok: true,
      async text() {
        return JSON.stringify({ products });
      },
    };
  };
}

test("toOrigin normalizes bare domains and rejects junk", () => {
  assert.strictEqual(toOrigin("mammothnation.com")?.origin, "https://mammothnation.com");
  assert.strictEqual(toOrigin("https://x.com/path")?.origin, "https://x.com");
  assert.strictEqual(toOrigin("not a url at all "), null);
  assert.strictEqual(toOrigin(""), null);
});

test("extractCompanies pulls distinct Shopify vendors across pages", async () => {
  const fetchImpl = makeShopifyFetch([
    [
      { title: "A", vendor: "Chill-N-Reel®" },
      { title: "B", vendor: "Artas'n Meats" },
      { title: "C", vendor: "Artas'n Meats" },
    ],
    [
      { title: "D", vendor: "Cheese Brothers, Inc." },
      { title: "E", vendor: "Chill-N-Reel®" }, // dup across pages
    ],
    [], // end of pagination
  ]);

  const res = await extractCompanies("mammothnation.com", { fetchImpl });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.source, "shopify");
  assert.strictEqual(res.count, 3);

  const names = res.companies.map((c) => c.name).sort();
  assert.deepStrictEqual(names, ["Artas'n Meats", "Cheese Brothers, Inc.", "Chill-N-Reel®"]);

  const artas = res.companies.find((c) => c.name === "Artas'n Meats");
  assert.strictEqual(artas.product_count, 2);
  const chill = res.companies.find((c) => c.name === "Chill-N-Reel®");
  assert.strictEqual(chill.product_count, 2); // counted across both pages
});

test("extractCompanies reports unsupported for non-Shopify sites", async () => {
  const fetchImpl = async () => ({
    status: 200,
    ok: true,
    async text() {
      return "<!DOCTYPE html><html>not shopify</html>";
    },
  });
  const res = await extractCompanies("example.com", { fetchImpl });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.source, "unsupported");
  assert.ok(res.message);
});

test("extractCompanies rejects invalid URLs", async () => {
  const res = await extractCompanies("not a url", { fetchImpl: async () => ({}) });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "invalid_url");
});

test("extractCompanies surfaces rate limiting from the probe", async () => {
  const fetchImpl = async () => ({ status: 429, ok: false, async text() { return ""; } });
  const res = await extractCompanies("mammothnation.com", { fetchImpl, rateLimitBackoffMs: 1 });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "rate_limited");
});
