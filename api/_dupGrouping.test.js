const test = require("node:test");
const assert = require("node:assert/strict");

const { dupGroupKey, isMarketplaceDomain, normalizeCompanyNameKey } = require("./_dupGrouping.js");

test("dupGroupKey: same domain + same name share a key", () => {
  const a = dupGroupKey({ company_name: "Acme Foods", normalized_domain: "acme.com" });
  const b = dupGroupKey({ company_name: "acme  foods", normalized_domain: "ACME.com" });
  assert.equal(a, b);
  assert.equal(a, "acme.com||acmefoods");
});

test("dupGroupKey: same domain + different names do NOT share a key", () => {
  const a = dupGroupKey({ company_name: "Frank's RedHot", normalized_domain: "mccormick.com" });
  const b = dupGroupKey({ company_name: "Lawry's", normalized_domain: "mccormick.com" });
  assert.notEqual(a, b);
});

test("dupGroupKey: spelling variants of one brand match", () => {
  assert.equal(
    dupGroupKey({ company_name: "SnackWorks", normalized_domain: "x.com" }),
    dupGroupKey({ company_name: "Snack Works", normalized_domain: "x.com" })
  );
});

test("dupGroupKey: null for sub-brand / marketplace / unknown / nameless", () => {
  assert.equal(dupGroupKey({ company_name: "A", normalized_domain: "x.com", parent_company_id: "p" }), null);
  assert.equal(dupGroupKey({ company_name: "A", normalized_domain: "amazon.com" }), null);
  assert.equal(dupGroupKey({ company_name: "A", normalized_domain: "etsy.com" }), null);
  assert.equal(dupGroupKey({ company_name: "A", normalized_domain: "unknown" }), null);
  assert.equal(dupGroupKey({ company_name: "A", normalized_domain: "" }), null);
  assert.equal(dupGroupKey({ company_name: "", normalized_domain: "x.com" }), null);
});

test("isMarketplaceDomain / normalizeCompanyNameKey", () => {
  assert.equal(isMarketplaceDomain("AMAZON.com"), true);
  assert.equal(isMarketplaceDomain("mccormick.com"), false);
  assert.equal(normalizeCompanyNameKey({ company_name: "Lawry's" }), "lawrys");
  assert.equal(normalizeCompanyNameKey({ name: "3-In-1 Oil" }), "3in1oil");
});
