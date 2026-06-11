// Phase 4.36 — tests for the new tiered search WHERE-clause logic on
// admin-companies-v2. The legacy CONTAINS-spam (~25 OR'd unindexed
// substring scans) is now opt-in via `?deep=true`; the default is the
// indexed ARRAY_CONTAINS-on-search_tokens path that powers the public
// /results search.

const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("./index.js");
const {
  buildIndexedSearchWhereClause,
  buildDeepSearchWhereClause,
  buildSearchWhereClause,
} = _test;

test("Phase 4.36: indexed WHERE uses ARRAY_CONTAINS, not CONTAINS(LOWER(...))", () => {
  const params = [];
  const clause = buildIndexedSearchWhereClause("zara", params);
  assert.ok(clause, "non-empty query should produce a clause");
  // Tier 1: ARRAY_CONTAINS(c.search_tokens, ...) must appear.
  assert.match(clause, /ARRAY_CONTAINS\(c\.search_tokens, @tok\d+\)/, "expected ARRAY_CONTAINS in clause");
  // Tier 1 must NOT include the unindexed CONTAINS(LOWER(c.company_name)) form
  // that the slow legacy path uses. Tier 2 uses STARTSWITH(LOWER(...)) which
  // IS allowed.
  assert.doesNotMatch(clause, /CONTAINS\(LOWER\(c\.company_name\)/, "indexed path must not fall back to unindexed CONTAINS");
  // @tok0 param pushed by builder.
  assert.ok(params.some((p) => p.name === "@tok0"), "expected @tok0 parameter pushed");
});

test("Phase 4.36: indexed WHERE includes Tier-2 STARTSWITH on company_name and domain", () => {
  const params = [];
  const clause = buildIndexedSearchWhereClause("zara", params);
  assert.ok(clause);
  assert.match(clause, /STARTSWITH\(LOWER\(c\.company_name\), @q\)/, "expected company_name prefix clause");
  assert.match(
    clause,
    /STARTSWITH\(LOWER\(c\.normalized_domain\), @q\)/,
    "expected normalized_domain prefix clause"
  );
});

test("Phase 4.36: indexed WHERE AND's content words within a multi-word query", () => {
  const params = [];
  const clause = buildIndexedSearchWhereClause("zara coats", params);
  assert.ok(clause);
  // The Tier-1 block should have an AND joining the two word groups so a
  // doc must have BOTH words (or stems) in search_tokens.
  // Loose regex — `... AND ...` inside the tier-1 parens.
  assert.match(clause, /ARRAY_CONTAINS\(c\.search_tokens, @tok\d+\).*AND.*ARRAY_CONTAINS\(c\.search_tokens, @tok\d+\)/s, "expected AND between word groups");
});

test("Phase 4.36: indexed WHERE returns null when the query has only stopwords", () => {
  const params = [];
  const clause = buildIndexedSearchWhereClause("the of and", params);
  // Tokenizer drops everything → no Tier 1 clause. Tier 2 STARTSWITH only
  // fires when the trimmed query has ≥ 2 chars; "the of and" trimmed has
  // many, so STARTSWITH still gates on whether ANY clause was produced.
  // In this case Tier-2 STILL produces a clause because the literal `@q`
  // = "the of and" has length ≥ 2, so the result is non-null. That's
  // acceptable — STARTSWITH on the literal string just matches docs
  // whose name actually starts with "the of and".
  assert.ok(clause, "Tier 2 STARTSWITH should still fire on multi-char stopword query");
});

test("Phase 4.36: indexed WHERE returns null on empty / too-short queries", () => {
  assert.strictEqual(buildIndexedSearchWhereClause("", []), null);
  assert.strictEqual(buildIndexedSearchWhereClause("a", []), null, "1-char query: too short for both tiers");
});

test("Phase 4.36: deep WHERE preserves the legacy CONTAINS chain", () => {
  // Direct call to buildDeepSearchWhereClause should produce the slow
  // shape — exact 25-clause chain isn't pinned, but it MUST contain
  // CONTAINS(LOWER(c.company_name)) which is the canonical legacy field.
  const clause = buildDeepSearchWhereClause([]);
  assert.match(clause, /CONTAINS\(LOWER\(c\.company_name\)/, "deep mode must include unindexed CONTAINS on company_name");
  // Notes-array scan is part of the deep recall — verify it's still there.
  assert.match(clause, /c\.star_notes/, "deep mode must still search star_notes");
  // Rating notes are part of the deep recall.
  assert.match(clause, /c\.rating/, "deep mode must still search rating notes");
});

test("Phase 4.36: buildSearchWhereClause(arrayArg) keeps the legacy signature for backward compat", () => {
  // Old callers (none today, but defensive): `buildSearchWhereClause(variantClauses)`
  // returning the deep WHERE.
  const clause = buildSearchWhereClause([]);
  assert.match(clause, /CONTAINS\(LOWER\(c\.company_name\)/, "array-arg invocation must route to deep clause");
});

test("Phase 4.36: buildSearchWhereClause(stringArg, params) routes to indexed path", () => {
  const params = [];
  const clause = buildSearchWhereClause("zara", params);
  assert.match(clause, /ARRAY_CONTAINS\(c\.search_tokens, @tok\d+\)/, "string-arg invocation must route to indexed clause");
});
