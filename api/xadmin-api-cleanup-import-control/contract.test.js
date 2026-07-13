const assert = require("node:assert/strict");
const { test } = require("node:test");

const { _test, CONTROL_TYPES } = require("../_importControlCleanup.js");
const { buildControlCleanupQuery } = _test;

test("age gate compares c._ts with <= (age-OUT, not the inverted >= window)", () => {
  const { query } = buildControlCleanupQuery({ olderThanSeconds: 1_000_000 });
  assert.match(query, /c\._ts\s*<=\s*@cutoff/, "must select docs OLDER than the cutoff");
  assert.doesNotMatch(query, />=\s*@cutoff/, "must not use the recent-window >= comparator");
});

test("cutoff is bound as an integer epoch-seconds value", () => {
  const { parameters } = buildControlCleanupQuery({ olderThanSeconds: 1712345678.9 });
  const cutoff = parameters.find((p) => p.name === "@cutoff");
  assert.ok(cutoff, "@cutoff parameter present");
  assert.equal(cutoff.value, 1712345678, "cutoff floored to whole seconds");
  assert.equal(Number.isInteger(cutoff.value), true);
});

test("cruft predicate matches _import_ ids and all control types", () => {
  const { query, parameters } = buildControlCleanupQuery({ olderThanSeconds: 0 });
  assert.match(query, /STARTSWITH\(c\.id, '_import_'\)/);
  assert.match(query, /c\.type IN \(/);
  for (const t of CONTROL_TYPES) {
    const p = parameters.find((x) => x.value === t);
    assert.ok(p, `type '${t}' is bound as a parameter`);
  }
});

test("soft-deleted docs are always excluded", () => {
  const { query } = buildControlCleanupQuery({ olderThanSeconds: 0 });
  assert.match(query, /NOT IS_DEFINED\(c\.is_deleted\) OR c\.is_deleted != true/);
});

test("projection keeps partition_key + normalized_domain for PK-candidate fallback", () => {
  const { query } = buildControlCleanupQuery({ olderThanSeconds: 0 });
  assert.match(query, /c\.partition_key/);
  assert.match(query, /c\.normalized_domain/);
});
