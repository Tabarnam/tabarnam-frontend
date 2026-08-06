// deduplicateByDomainAdmin — a duplicate is same normalized_domain AND same
// company name (see api/_dupGrouping.js). Domain alone is NOT a duplicate:
// distinct sibling brands share a corporate domain (mccormick.com → Frank's
// RedHot / Lawry's / French's) and unrelated companies share marketplace domains
// (amazon.com / etsy.com). Sub-brands (parent_company_id) always pass through.

const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("./index.js");
const { deduplicateByDomainAdmin } = _test;

test("same domain AND same name collapses to one row with dup count 1", () => {
  const input = [
    { id: "acme-a", company_name: "Acme Foods", normalized_domain: "acme.com", review_count: 5 },
    { id: "acme-b", company_name: "Acme Foods", normalized_domain: "acme.com", review_count: 2 },
  ];
  const out = deduplicateByDomainAdmin(input);
  assert.equal(out.length, 1, "two same-domain same-name dupes collapse to one row");
  assert.equal(out[0].id, "acme-a", "winner is the doc with more reviews");
  assert.equal(out[0]._duplicates_count, 1);
  assert.deepEqual(out[0]._duplicate_ids, ["acme-b"]);
});

test("same domain but DIFFERENT names are NOT duplicates (sibling brands)", () => {
  // mccormick.com hosts distinct brands — they must never be flagged or merged.
  const input = [
    { id: "franks", company_name: "Frank's RedHot", normalized_domain: "mccormick.com" },
    { id: "lawrys", company_name: "Lawry's", normalized_domain: "mccormick.com" },
    { id: "frenchs", company_name: "French's", normalized_domain: "mccormick.com" },
  ];
  const out = deduplicateByDomainAdmin(input);
  assert.equal(out.length, 3, "distinct-name siblings all pass through");
  for (const row of out) assert.equal(row._duplicates_count, undefined);
});

test("name match ignores spacing/punctuation (SnackWorks == Snack Works)", () => {
  const input = [
    { id: "sw1", company_name: "SnackWorks", normalized_domain: "snackworks.com", review_count: 10 },
    { id: "sw2", company_name: "Snack Works", normalized_domain: "snackworks.com", review_count: 1 },
  ];
  const out = deduplicateByDomainAdmin(input);
  assert.equal(out.length, 1, "spelling variants of one brand collapse");
  assert.equal(out[0].id, "sw1");
  assert.equal(out[0]._duplicates_count, 1);
});

test("marketplace domain never collapses, even with the same name", () => {
  const input = [
    { id: "m1", company_name: "Handmade Soap", normalized_domain: "etsy.com" },
    { id: "m2", company_name: "Handmade Soap", normalized_domain: "etsy.com" },
    { id: "m3", company_name: "Magic Moo Tallow", normalized_domain: "amazon.com" },
    { id: "m4", company_name: "Amazon Alexa", normalized_domain: "amazon.com" },
  ];
  const out = deduplicateByDomainAdmin(input);
  assert.equal(out.length, 4, "marketplace-domain docs always pass through");
  for (const row of out) assert.equal(row._duplicates_count, undefined);
});

test("parent + N sub-brands sharing a domain returns N+1 rows, no dup badges", () => {
  const input = [
    { id: "snackworks", company_name: "SnackWorks", normalized_domain: "snackworks.com" },
    { id: "triscuit", company_name: "Triscuit", normalized_domain: "snackworks.com", parent_company_id: "snackworks" },
    { id: "wheat-thins", company_name: "Wheat Thins", normalized_domain: "snackworks.com", parent_company_id: "snackworks" },
    { id: "ritz", company_name: "Ritz", normalized_domain: "snackworks.com", parent_company_id: "snackworks" },
  ];
  const out = deduplicateByDomainAdmin(input);
  assert.equal(out.length, 4);
  for (const row of out) assert.equal(row._duplicates_count, undefined, `row ${row.id} must carry no badge`);
});

test("a real same-name dupe next to sub-brands: only the same-name pair collapses", () => {
  const input = [
    { id: "snackworks", company_name: "SnackWorks", normalized_domain: "snackworks.com", review_count: 10 },
    { id: "snackworks-dup", company_name: "Snack Works", normalized_domain: "snackworks.com", review_count: 1 },
    { id: "triscuit", company_name: "Triscuit", normalized_domain: "snackworks.com", parent_company_id: "snackworks" },
    { id: "ritz", company_name: "Ritz", normalized_domain: "snackworks.com", parent_company_id: "snackworks" },
  ];
  const out = deduplicateByDomainAdmin(input);
  assert.equal(out.length, 3, "parent+dup collapses to 1; two sub-brands pass through");
  const winner = out.find((r) => r.id === "snackworks");
  assert.equal(winner._duplicates_count, 1);
  assert.deepEqual(winner._duplicate_ids, ["snackworks-dup"]);
  assert.equal(out.find((r) => r.id === "snackworks-dup"), undefined);
});

test("preserves input (server-sorted) order — sub-brands & importing rows never jump to the top", () => {
  // Regression: dedup used to emit [...passthrough, ...grouped], yanking every
  // null-key doc (sub-brands with a parent, importing rows with no domain) to
  // the front regardless of the ORDER BY. The list must come back in the SAME
  // order it went in. Here the caller sorted by created desc; the two newest
  // rows are normal companies, and the sub-brands / importing row sit lower.
  const input = [
    { id: "new-normal-1", company_name: "Autel", normalized_domain: "autel.com" },       // newest, parent-less
    { id: "new-normal-2", company_name: "ChargePoint", normalized_domain: "chargepoint.com" },
    { id: "subbrand-1", company_name: "Grey Poupon", normalized_domain: "kraftheinz.com", parent_company_id: "kh" },
    { id: "importing", company_name: "ANCO", normalized_domain: "unknown" },              // importing, no domain
    { id: "subbrand-2", company_name: "Wheat Thins", normalized_domain: "snackworks.com", parent_company_id: "sw" },
    { id: "old-normal", company_name: "Barilla", normalized_domain: "barilla.com" },      // oldest, parent-less
  ];
  const out = deduplicateByDomainAdmin(input);
  assert.deepEqual(
    out.map((r) => r.id),
    ["new-normal-1", "new-normal-2", "subbrand-1", "importing", "subbrand-2", "old-normal"],
    "output order must match input order exactly"
  );
});

test("empty parent_company_id string is treated as no parent (same-name still collapses)", () => {
  const input = [
    { id: "a", company_name: "Acme", normalized_domain: "x.com", parent_company_id: "" },
    { id: "b", company_name: "Acme", normalized_domain: "x.com", parent_company_id: "   " },
  ];
  const out = deduplicateByDomainAdmin(input);
  assert.equal(out.length, 1, "empty/whitespace parent_company_id must not count as parented");
  assert.equal(out[0]._duplicates_count, 1);
});

test("unknown/empty domain and nameless docs never collapse", () => {
  const input = [
    { id: "a", company_name: "A", normalized_domain: "unknown" },
    { id: "b", company_name: "B", normalized_domain: "unknown" },
    { id: "c", company_name: "C", normalized_domain: "" },
    { id: "d", company_name: "", normalized_domain: "nameless.com" },
    { id: "e", company_name: "", normalized_domain: "nameless.com" },
  ];
  const out = deduplicateByDomainAdmin(input);
  assert.equal(out.length, 5, "no resolvable domain or no name → always pass through");
  for (const row of out) assert.equal(row._duplicates_count, undefined);
});
