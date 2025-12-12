const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("./index.js");

function makeReq(url) {
  return {
    method: "GET",
    url,
    headers: new Headers(),
  };
}

function makeContainer(queryResponder) {
  return {
    items: {
      query: (spec) => ({
        fetchAll: async () => ({ resources: await queryResponder(spec) }),
      }),
    },
  };
}

test("/api/get-reviews?company=... returns ok/items even when empty", async () => {
  const reviewsContainer = makeContainer(async () => []);
  const companiesContainer = makeContainer(async () => []);

  const res = await _test.getReviewsHandler(
    makeReq("https://example.test/api/get-reviews?company=Yeti"),
    { log() {} },
    { reviewsContainer, companiesContainer }
  );

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.company, "Yeti");
  assert.ok(Array.isArray(body.items));
  assert.equal(body.items.length, 0);
});

test("/api/get-reviews?normalized_domain=... resolves company name and succeeds", async () => {
  const reviewsContainer = makeContainer(async () => []);
  const companiesContainer = makeContainer(async (spec) => {
    const q = String(spec?.query || "");
    if (q.includes("LOWER(c.normalized_domain)")) {
      return [{ company_name: "Obrilo" }];
    }
    if (q.includes("c.curated_reviews") && q.includes("WHERE c.company_name")) {
      return [{ company_name: "Obrilo", curated_reviews: [] }];
    }
    return [];
  });

  const res = await _test.getReviewsHandler(
    makeReq("https://example.test/api/get-reviews?normalized_domain=obrilo.com"),
    { log() {} },
    { reviewsContainer, companiesContainer }
  );

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.company, "Obrilo");
  assert.ok(Array.isArray(body.items));
});

test("/api/get-reviews with no identifier returns 400", async () => {
  const res = await _test.getReviewsHandler(makeReq("https://example.test/api/get-reviews"), { log() {} }, {
    reviewsContainer: null,
    companiesContainer: null,
  });

  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.error, "company parameter required");
});
