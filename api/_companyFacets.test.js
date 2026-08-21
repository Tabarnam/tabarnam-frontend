const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildFacetEntry,
  cleanTerms,
  PRODUCT_MAX,
  INDUSTRY_MAX,
} = require("./_companyFacets");

const doc = (over = {}) => ({
  company_id: "company_1",
  company_name: "Dr. Squatch",
  industries: ["Skincare", "Personal Care"],
  product_keywords: ["soap", "deodorant"],
  stars: 2,
  visible_review_count: 4,
  ...over,
});

test("cleanTerms trims, drops empties and dedupes case-insensitively", () => {
  assert.deepEqual(cleanTerms(["  Soap ", "soap", "SOAP", "", "  ", "Bar"], 10), ["Soap", "Bar"]);
});

test("cleanTerms keeps the first spelling it saw", () => {
  assert.deepEqual(cleanTerms(["Bar Soap", "bar soap"], 10), ["Bar Soap"]);
});

test("cleanTerms collapses internal whitespace", () => {
  assert.deepEqual(cleanTerms(["bar    soap"], 10), ["bar soap"]);
});

test("cleanTerms drops terms that merely restate the company name", () => {
  assert.deepEqual(cleanTerms(["Dr. Squatch", "soap"], 10, "Dr. Squatch"), ["soap"]);
  assert.deepEqual(cleanTerms(["dr. squatch", "soap"], 10, "Dr. Squatch"), ["soap"]);
});

test("cleanTerms drops scraped page titles that carry the brand name", () => {
  // Real leading entry on Dr. Squatch's keyword list — a page title, not a
  // product, and punctuated differently from the stored company name.
  assert.deepEqual(
    cleanTerms(["Natural Soap Handmade Soap - Dr Squatch", "soap"], 10, "Dr. Squatch"),
    ["soap"]
  );
});

test("cleanTerms can exclude terms already shown elsewhere", () => {
  const shown = new Set(["deodorant"]);
  assert.deepEqual(cleanTerms(["soap", "Deodorant", "bar"], 10, "", shown), ["soap", "bar"]);
});

test("cleanTerms dedupes across punctuation variants", () => {
  assert.deepEqual(cleanTerms(["bar-soap", "Bar Soap", "bar soap"], 10), ["bar-soap"]);
});

test("cleanTerms drops absurdly long strings rather than printing them", () => {
  const long = "x".repeat(61);
  assert.deepEqual(cleanTerms([long, "soap"], 10), ["soap"]);
});

test("cleanTerms respects the cap", () => {
  const many = Array.from({ length: 50 }, (_, i) => `term${i}`);
  assert.equal(cleanTerms(many, 20).length, 20);
});

test("cleanTerms ignores non-strings instead of throwing", () => {
  assert.deepEqual(cleanTerms(["soap", null, 42, undefined, { a: 1 }], 10), ["soap"]);
  assert.deepEqual(cleanTerms(null, 10), []);
});

test("a facet row carries industries, products, stars and visible reviews", () => {
  assert.deepEqual(buildFacetEntry(doc()), [
    "company_1",
    ["Skincare", "Personal Care"],
    ["soap", "deodorant"],
    2,
    4,
  ]);
});

test("products are NOT deduped against industries", () => {
  // industries is a retrieval lever and isn't published, so excluding its terms
  // would silently delete a real product from the page whenever an admin had
  // also used that word to steer search. "deodorant" must survive.
  const entry = buildFacetEntry(
    doc({
      industries: ["Skincare", "Personal Care", "bar soap", "deodorant"],
      product_keywords: ["soap", "deodorant", "Pine Tar Soap"],
    })
  );
  assert.deepEqual(entry[1], ["Skincare", "Personal Care", "bar soap", "deodorant"]);
  assert.deepEqual(entry[2], ["soap", "deodorant", "Pine Tar Soap"]);
});

test("product keywords are capped so a page can't become a keyword dump", () => {
  // Real records carry ~90 SKU-level variants.
  const products = Array.from({ length: 90 }, (_, i) => `Product Variant ${i}`);
  const entry = buildFacetEntry(doc({ product_keywords: products }));
  assert.equal(entry[2].length, PRODUCT_MAX);
});

test("industries are capped too", () => {
  const industries = Array.from({ length: 40 }, (_, i) => `Industry ${i}`);
  assert.equal(buildFacetEntry(doc({ industries }))[1].length, INDUSTRY_MAX);
});

test("keywords stands in when product_keywords is absent or empty", () => {
  assert.deepEqual(buildFacetEntry(doc({ product_keywords: [], keywords: ["kettle"] }))[2], ["kettle"]);
  assert.deepEqual(buildFacetEntry(doc({ product_keywords: undefined, keywords: ["kettle"] }))[2], ["kettle"]);
});

test("product_keywords wins when both are present", () => {
  assert.deepEqual(buildFacetEntry(doc({ product_keywords: ["soap"], keywords: ["other"] }))[2], ["soap"]);
});

test("the review count is the VISIBLE one — pending reviews aren't public", () => {
  const entry = buildFacetEntry(doc({ review_count: 40, visible_review_count: 4 }));
  assert.equal(entry[4], 4);
});

test("a company with nothing to add produces no row at all", () => {
  assert.equal(
    buildFacetEntry({
      company_id: "company_2",
      company_name: "Blank",
      industries: [],
      product_keywords: [],
      stars: null,
      visible_review_count: 0,
    }),
    null
  );
});

test("a company with only a rating still earns a row", () => {
  const entry = buildFacetEntry({
    company_id: "company_3",
    company_name: "Rated",
    industries: [],
    product_keywords: [],
    stars: 4,
    visible_review_count: 0,
  });
  assert.deepEqual(entry, ["company_3", [], [], 4, 0]);
});

test("deleted, control and internal records are excluded", () => {
  assert.equal(buildFacetEntry(doc({ is_deleted: true })), null);
  assert.equal(buildFacetEntry(doc({ type: "import_control" })), null);
  assert.equal(buildFacetEntry(doc({ company_id: "_index_something" })), null);
  assert.equal(buildFacetEntry(doc({ company_id: "refresh_job_1" })), null);
  assert.equal(buildFacetEntry(doc({ company_id: "", id: "" })), null);
  assert.equal(buildFacetEntry(null), null);
});

test("star_rating stands in for stars, and a missing rating stays null", () => {
  assert.equal(buildFacetEntry(doc({ stars: undefined, star_rating: 5 }))[3], 5);
  assert.equal(buildFacetEntry(doc({ stars: undefined, star_rating: undefined }))[3], null);
});
