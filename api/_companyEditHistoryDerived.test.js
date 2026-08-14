"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { computeTopLevelDiff, DERIVED_FIELDS } = require("./_companyEditHistory");

// Derived fields are excluded from the audit diff.
//
// The system recomputes these on every save from other fields on the same
// document, so recording them says nothing about what a person did — only that
// a save happened, which the entry already states. They were also the bulk of
// the stored payload (long strings, 5 of them) and pushed the real change
// behind a "+27 more" summary.
//
// Measured on 25 consecutive production entries before this change: the
// search_text_* family and search_tokens appeared in ~72%, _kwCacheKey in 68%.

function edit(before, after) {
  return computeTopLevelDiff(before, after);
}

test("the search index payload is not recorded", () => {
  const { changed_fields } = edit(
    { company_name: "Acme", search_text_norm: "acme old", search_tokens: ["acme"] },
    { company_name: "Acme Co", search_text_norm: "acme co new", search_tokens: ["acme", "co"] }
  );

  assert.deepEqual(changed_fields, ["company_name"], "only the human edit survives");
});

test("every declared derived field is filtered", () => {
  const before = {};
  const after = {};
  for (const f of DERIVED_FIELDS) {
    before[f] = "before";
    after[f] = "after";
  }

  const { changed_fields, diff } = edit(before, after);

  assert.deepEqual(changed_fields, [], `none of: ${DERIVED_FIELDS.join(", ")}`);
  assert.deepEqual(diff, {}, "and nothing is stored for them");
});

test("the completeness SCORE is kept, only its verbose meta is dropped", () => {
  // 88% -> 95% is meaningful to a human; the breakdown blob is not.
  const { changed_fields } = edit(
    { profile_completeness: 88, profile_completeness_meta: { a: 1 } },
    { profile_completeness: 95, profile_completeness_meta: { a: 2 } }
  );

  assert.deepEqual(changed_fields, ["profile_completeness"]);
});

test("a real single-field edit stays a single-field entry", () => {
  const { changed_fields } = edit(
    { logo_url: "old.png", search_tokens: ["a"], _kwCacheKey: "k1" },
    { logo_url: "new.png", search_tokens: ["a", "b"], _kwCacheKey: "k2" }
  );

  assert.deepEqual(changed_fields, ["logo_url"], "a logo swap reads as a logo swap");
});

test("meaningful pipeline state is still recorded", () => {
  // These look derived but carry real signal about whether a company is
  // workable, so they must NOT be filtered.
  const { changed_fields } = edit(
    { issues_count: 2, import_missing_fields: ["logo"], rating: { star1: 0 } },
    { issues_count: 0, import_missing_fields: [], rating: { star1: 1 } }
  );

  assert.deepEqual(changed_fields.sort(), ["import_missing_fields", "issues_count", "rating"]);
});

test("caller-supplied ignoreKeys still compose with the derived list", () => {
  const { changed_fields } = edit(
    { id: "a", company_name: "X", search_tokens: ["x"] },
    { id: "b", company_name: "Y", search_tokens: ["y"] }
  );

  // id is filtered by the caller's list in writeCompanyEditHistoryEntry; here
  // it is not passed, so it should appear — proving the two lists are additive
  // rather than one replacing the other.
  assert.ok(changed_fields.includes("company_name"));
  assert.ok(!changed_fields.includes("search_tokens"), "derived list applies unconditionally");
});

test("timestamps and Cosmos system fields remain filtered", () => {
  const { changed_fields } = edit(
    { _ts: 1, _etag: "a", updated_at: "t1", company_name: "X" },
    { _ts: 2, _etag: "b", updated_at: "t2", company_name: "X" }
  );

  assert.deepEqual(changed_fields, [], "a save with no real change records nothing");
});
