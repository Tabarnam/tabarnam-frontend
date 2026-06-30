const test = require("node:test");
const assert = require("node:assert/strict");

const { computeIssueTags } = require("./_sortKeys.js");

// A company that is complete on every contract field EXCEPT the logo. The
// stored issues_count must flag it so the Incomplete badge matches the Issues
// column (which has always shown a "logo" chip).
function completeExceptLogo(overrides = {}) {
  return {
    company_name: "Logo Test Co",
    headquarters_locations: [{ city: "Austin", state: "TX", country: "USA" }],
    manufacturing_locations: [{ city: "Austin", state: "TX", country: "USA" }],
    industries: ["Apparel"],
    keywords: ["shirts", "pants", "jackets", "hats", "socks"],
    product_keywords: "shirts, pants, jackets, hats, socks",
    tagline: "We make clothes",
    homepage_image_url: "https://img/home.png",
    amazon_url: "https://amazon.com/store",
    amazon_url_approved: true,
    no_reviews: true,
    enrichment_health: { missing_fields: [] },
    ...overrides,
  };
}

test("computeIssueTags: missing logo is flagged (matches Issues column)", () => {
  const tags = computeIssueTags(completeExceptLogo({ logo_url: "" }));
  assert.ok(tags.includes("logo"), `expected "logo" tag, got: ${JSON.stringify(tags)}`);
});

test("computeIssueTags: present logo is not flagged", () => {
  const tags = computeIssueTags(completeExceptLogo({ logo_url: "https://img/logo.png" }));
  assert.ok(!tags.includes("logo"), `did not expect "logo" tag, got: ${JSON.stringify(tags)}`);
});

test("computeIssueTags: a fully complete company has zero tags", () => {
  const tags = computeIssueTags(completeExceptLogo({ logo_url: "https://img/logo.png" }));
  assert.equal(tags.length, 0, `expected no tags, got: ${JSON.stringify(tags)}`);
});

test("computeIssueTags: a stale POSITIVE _kwRelevantCount is not trusted when the cache key no longer matches", () => {
  // enrichment_health flagged keywords missing, and a cached count claims 5 real
  // keywords — but the cache key doesn't match the live (empty) data, so the
  // count is stale and must not be trusted to clear the flag. Mirrors the
  // frontend _kwCacheValid gate: without it the old server code wrongly dropped
  // "keywords", diverging from the Issues column.
  const tags = computeIssueTags(
    completeExceptLogo({
      logo_url: "https://img/logo.png",
      keywords: [],
      product_keywords: "",
      enrichment_health: { missing_fields: ["keywords"] },
      _kwRelevantCount: 5,
      _kwCacheKey: "stale|||doesnotmatch",
    })
  );
  assert.ok(tags.includes("keywords"), `expected "keywords" tag, got: ${JSON.stringify(tags)}`);
});
