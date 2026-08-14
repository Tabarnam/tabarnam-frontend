"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("./index.js");

// Everyone who has EVER written to the activity log.
//
// The person filter used to be built from the live roster, so a contributor's
// name vanished from it the moment they were removed from CONTRIBUTOR_EMAILS —
// while their entries stayed in the log, now unreachable through the UI. An
// audit trail you cannot filter by the person who left is the one you most
// needed.

function makeContainer(values, onQuery) {
  return {
    items: {
      query(spec) {
        if (onQuery) onQuery(spec);
        return {
          fetchAll: async () => {
            if (values instanceof Error) throw values;
            return { resources: values };
          },
        };
      },
    },
  };
}

const ctx = { log() {} };
const call = (deps) => _test.handleGet({ method: "GET" }, ctx, deps);

test.beforeEach(() => _test.__resetCache());

test("returns everyone who has acted, sorted and de-duplicated", async () => {
  const res = await call({
    container: makeContainer(["kels@tabarnam.com", "jon@tabarnam.com", "jon@tabarnam.com"]),
  });

  assert.deepEqual(JSON.parse(res.body).actors, ["jon@tabarnam.com", "kels@tabarnam.com"]);
});

test("a departed user is still listed — the point of the endpoint", async () => {
  // gone@ is in no roster any more, but their entries remain in the log.
  const res = await call({
    container: makeContainer(["gone@tabarnam.com", "jon@tabarnam.com"]),
  });

  assert.ok(JSON.parse(res.body).actors.includes("gone@tabarnam.com"));
});

test("emails are normalized to lowercase", async () => {
  const res = await call({ container: makeContainer(["Jon@Tabarnam.com"]) });
  assert.deepEqual(JSON.parse(res.body).actors, ["jon@tabarnam.com"]);
});

test("blank and null actors are dropped", async () => {
  const res = await call({ container: makeContainer(["", null, "  ", "jon@tabarnam.com"]) });
  assert.deepEqual(JSON.parse(res.body).actors, ["jon@tabarnam.com"]);
});

test("the result is cached — a DISTINCT over the whole log is not run per request", async () => {
  let queries = 0;
  const container = makeContainer(["jon@tabarnam.com"], () => {
    queries++;
  });

  await call({ container, now: 1_000 });
  await call({ container, now: 2_000 });
  const third = await call({ container, now: 3_000 });

  assert.equal(queries, 1);
  assert.equal(JSON.parse(third.body).cached, true);
});

test("the cache expires", async () => {
  let queries = 0;
  const container = makeContainer(["jon@tabarnam.com"], () => {
    queries++;
  });

  await call({ container, now: 0 });
  await call({ container, now: _test.CACHE_TTL_MS + 1 });

  assert.equal(queries, 2);
});

test("a query failure serves the stale list rather than emptying the filter", async () => {
  const ok = makeContainer(["jon@tabarnam.com"]);
  await call({ container: ok, now: 0 });

  const broken = makeContainer(new Error("Cosmos unavailable"));
  const res = await call({ container: broken, now: _test.CACHE_TTL_MS + 1 });

  const body = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.deepEqual(body.actors, ["jon@tabarnam.com"], "people must not disappear on a blip");
  assert.equal(body.stale, true);
});

test("a failure with no cache at all reports the error", async () => {
  const res = await call({ container: makeContainer(new Error("boom")) });

  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.body).actors, []);
});
