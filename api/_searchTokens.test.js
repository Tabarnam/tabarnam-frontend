// Phase 4.36 — unit tests for the shared search-tokens helper.

const test = require("node:test");
const assert = require("node:assert");

const {
  SEARCH_STOPWORDS,
  MIN_TOKEN_LENGTH,
  tokenizeQuery,
  buildTokenMatchSql,
  buildTokenMatchSqlFromRaw,
} = require("./_searchTokens");

test("Phase 4.36: tokenizeQuery drops stopwords and short tokens", () => {
  // Real-world admin query.
  assert.deepStrictEqual(tokenizeQuery("the zara company of spain"), ["zara", "company", "spain"]);
  // Stopword pruning works for every set member.
  for (const sw of SEARCH_STOPWORDS) {
    assert.deepStrictEqual(tokenizeQuery(sw), [], `stopword '${sw}' should be dropped`);
  }
  // 1-char tokens dropped.
  assert.deepStrictEqual(tokenizeQuery("x y z foo"), ["foo"]);
});

test("Phase 4.36: tokenizeQuery tolerates non-string input", () => {
  assert.deepStrictEqual(tokenizeQuery(null), []);
  assert.deepStrictEqual(tokenizeQuery(undefined), []);
  assert.deepStrictEqual(tokenizeQuery(42), []);
  assert.deepStrictEqual(tokenizeQuery(""), []);
  assert.deepStrictEqual(tokenizeQuery("   "), []);
});

test("Phase 4.36: buildTokenMatchSql emits ARRAY_CONTAINS per word AND'd together", () => {
  const result = buildTokenMatchSql("zara coats");
  assert.ok(result, "non-empty query should produce a clause");
  assert.match(result.whereClause, /ARRAY_CONTAINS\(c\.search_tokens, @tok\d+\)/);
  // Two content words → AND'd at top level.
  assert.match(result.whereClause, /AND/);
  // The param values should include the literal words (no smart stripping).
  const values = result.parameters.map((p) => p.value);
  assert.ok(values.includes("zara"), "expected 'zara' in params");
  assert.ok(values.includes("coats"), "expected 'coats' in params");
});

test("Phase 4.36: buildTokenMatchSql includes stem variants OR'd within each word", () => {
  // "coats" → stem "coat" (typical -s stripper). Both should appear as
  // alternatives so the doc-side stems can match.
  const result = buildTokenMatchSql("coats");
  assert.ok(result);
  const values = result.parameters.map((p) => p.value);
  // The literal word is always present.
  assert.ok(values.includes("coats"), "literal 'coats' missing from params");
  // The stem should ALSO be there if the simple stemmer strips -s.
  // We don't pin the exact stem — just that more than one variant fires
  // (literal + stem). If the stemmer ever stops finding a stem we'll
  // tighten this.
  if (values.length === 1) {
    assert.fail("expected stem variant in addition to literal");
  }
});

test("Phase 4.36: buildTokenMatchSql returns null when query has only stopwords", () => {
  assert.strictEqual(buildTokenMatchSql("the and of"), null);
  assert.strictEqual(buildTokenMatchSql(""), null);
  assert.strictEqual(buildTokenMatchSql("   "), null);
});

test("Phase 4.36: paramPrefix + startIndex let multiple builds coexist", () => {
  const first = buildTokenMatchSql("zara", { paramPrefix: "a", startIndex: 0 });
  const second = buildTokenMatchSql("hilfiger", {
    paramPrefix: "b",
    startIndex: first ? first.nextIndex : 0,
  });
  assert.ok(first && second);
  // No param-name collisions across the two builds.
  const allNames = [...first.parameters, ...second.parameters].map((p) => p.name);
  const unique = new Set(allNames);
  assert.strictEqual(unique.size, allNames.length, "expected unique parameter names across builds");
  // Prefixes obeyed.
  assert.ok(first.parameters.every((p) => p.name.startsWith("@a")), "first should use @a prefix");
  assert.ok(second.parameters.every((p) => p.name.startsWith("@b")), "second should use @b prefix");
});

test("Phase 4.36: buildTokenMatchSqlFromRaw normalizes before tokenizing", () => {
  // Diacritics + uppercase should round-trip through normalizeQuery and
  // produce a usable clause. Exact normalized form depends on the shared
  // `_queryNormalizer`; we just check the call succeeds and the params are
  // lowercase ASCII (since the doc-side stores them that way).
  const result = buildTokenMatchSqlFromRaw("ZÄRA Coats");
  assert.ok(result, "diacritic-folded query should still produce a clause");
  const values = result.parameters.map((p) => p.value);
  for (const v of values) {
    assert.match(v, /^[a-z0-9]+$/, `param value '${v}' should be lowercase ASCII after normalize`);
  }
});

test("Phase 4.36: MIN_TOKEN_LENGTH is exposed and respected", () => {
  assert.strictEqual(typeof MIN_TOKEN_LENGTH, "number");
  assert.ok(MIN_TOKEN_LENGTH >= 2);
});
