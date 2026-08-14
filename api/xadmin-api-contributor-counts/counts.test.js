"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("./index.js");

// Per-contributor assigned-company counts.
//
// The number has to agree with what an admin sees after clicking through to
// the filtered list, so this endpoint applies the SAME row filters as
// admin-companies-v2. A badge that disagrees with the list it links to is
// worse than no badge.

function makeContainer(rows = [], onQuery) {
  return {
    items: {
      query(spec) {
        if (onQuery) onQuery(spec);
        return { fetchAll: async () => ({ resources: rows }) };
      },
    },
  };
}

const ctx = { log() {} };
const call = (deps) => _test.handleGet({ method: "GET" }, ctx, deps);

test("counts are returned per contributor", async () => {
  const res = await call({
    contributors: ["dana@tabarnam.com", "sam@tabarnam.com"],
    container: makeContainer([
      { owner: "dana@tabarnam.com", n: 3 },
      { owner: "sam@tabarnam.com", n: 12 },
    ]),
  });

  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.deepEqual(body.counts, { "dana@tabarnam.com": 3, "sam@tabarnam.com": 12 });
});

test("a contributor with nothing assigned reports 0, not absent", async () => {
  // "No badge" and "badge showing 0" mean different things to whoever is
  // handing out work.
  const res = await call({
    contributors: ["dana@tabarnam.com", "sam@tabarnam.com"],
    container: makeContainer([{ owner: "dana@tabarnam.com", n: 3 }]),
  });

  assert.deepEqual(JSON.parse(res.body).counts, {
    "dana@tabarnam.com": 3,
    "sam@tabarnam.com": 0,
  });
});

test("staff are never counted — only the configured contributors are queried", async () => {
  let seen = null;
  await call({
    contributors: ["dana@tabarnam.com"],
    container: makeContainer([], (spec) => {
      seen = spec;
    }),
  });

  const values = seen.parameters.map((p) => p.value);
  assert.deepEqual(values, ["dana@tabarnam.com"]);
  assert.ok(!seen.query.includes("jon@tabarnam.com"));
});

test("the query applies the same row filters as the companies list", async () => {
  let seen = null;
  await call({
    contributors: ["dana@tabarnam.com"],
    container: makeContainer([], (spec) => {
      seen = spec;
    }),
  });

  // Deleted rows, import control docs and refresh jobs are excluded from the
  // list, so they must be excluded from the count too.
  assert.match(seen.query, /c\.is_deleted != true/);
  assert.match(seen.query, /NOT STARTSWITH\(c\.id, '_import_'\)/);
  assert.match(seen.query, /NOT STARTSWITH\(c\.id, 'refresh_job_'\)/);
  assert.match(seen.query, /c\.type != 'import_control'/);
});

test("emails are parameterized, never interpolated into the SQL", async () => {
  let seen = null;
  await call({
    contributors: ["dana@tabarnam.com"],
    container: makeContainer([], (spec) => {
      seen = spec;
    }),
  });

  assert.ok(!seen.query.includes("dana@tabarnam.com"));
  assert.equal(seen.parameters[0].value, "dana@tabarnam.com");
});

test("no contributors configured means no Cosmos call at all", async () => {
  let called = false;
  const res = await call({
    contributors: [],
    container: makeContainer([], () => {
      called = true;
    }),
  });

  assert.equal(called, false, "the dormant tier must not cost a query");
  assert.deepEqual(JSON.parse(res.body).counts, {});
});

test("owner matching is case-insensitive", async () => {
  const res = await call({
    contributors: ["Dana@Tabarnam.com"],
    container: makeContainer([{ owner: "DANA@TABARNAM.COM", n: 5 }]),
  });

  assert.deepEqual(JSON.parse(res.body).counts, { "dana@tabarnam.com": 5 });
});

test("a query failure degrades to no badges rather than breaking the page", async () => {
  const res = await call({
    contributors: ["dana@tabarnam.com"],
    container: {
      items: {
        query() {
          return {
            async fetchAll() {
              throw new Error("Cosmos unavailable");
            },
          };
        },
      },
    },
  });

  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.body).counts, {}, "the client renders without badges");
});
