const test = require("node:test");
const assert = require("node:assert/strict");

const { isSecondLookStale, sweepStaleSecondLook, DEFAULT_STALE_MS } = require("./index.js");

const NOW = Date.parse("2026-08-17T16:00:00.000Z");
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

test("isSecondLookStale: pending with no enqueue stamp is stranded", () => {
  assert.equal(isSecondLookStale({ second_look_pending: true }, NOW), true);
});

test("isSecondLookStale: pending + old enqueue is stale", () => {
  assert.equal(
    isSecondLookStale({ second_look_pending: true, second_look_enqueued_at: iso(10 * 60 * 60 * 1000) }, NOW),
    true
  );
});

test("isSecondLookStale: pending + recent enqueue is NOT stale (don't clobber in-flight)", () => {
  assert.equal(
    isSecondLookStale({ second_look_pending: true, second_look_enqueued_at: iso(60 * 1000) }, NOW),
    false
  );
  // exactly at the threshold counts as stale; just under does not
  assert.equal(isSecondLookStale({ second_look_pending: true, second_look_enqueued_at: iso(DEFAULT_STALE_MS) }, NOW), true);
  assert.equal(isSecondLookStale({ second_look_pending: true, second_look_enqueued_at: iso(DEFAULT_STALE_MS - 1000) }, NOW), false);
});

test("isSecondLookStale: completed or not-pending is never stale", () => {
  assert.equal(isSecondLookStale({ second_look_pending: true, second_look_done: true }, NOW), false);
  assert.equal(isSecondLookStale({ second_look_pending: false }, NOW), false);
  assert.equal(isSecondLookStale({}, NOW), false);
  assert.equal(isSecondLookStale(null, NOW), false);
});

// ── sweep with a mock container ──
function mockContainer(docs) {
  const replaced = [];
  return {
    replaced,
    items: { query: () => ({ fetchAll: async () => ({ resources: docs }) }) },
    item: (id, pk) => ({
      replace: async (doc) => {
        replaced.push({ id, pk, doc });
        return { resource: doc };
      },
    }),
  };
}

test("sweep clears only the stale pending doc, leaves the fresh one in flight", async () => {
  const stale = {
    id: "stale-1",
    company_name: "Fletcher Business Group",
    normalized_domain: "fletcher.com",
    second_look_pending: true,
    second_look_enqueued_at: iso(11 * 60 * 60 * 1000),
  };
  const fresh = {
    id: "fresh-1",
    company_name: "Just Enqueued",
    normalized_domain: "fresh.com",
    second_look_pending: true,
    second_look_enqueued_at: iso(30 * 1000),
  };
  const c = mockContainer([stale, fresh]);
  const res = await sweepStaleSecondLook(c, { nowMs: NOW, log: () => {} });

  assert.equal(res.scanned, 2);
  assert.equal(res.cleared, 1);
  assert.deepEqual(res.names, ["Fletcher Business Group"]);
  // only the stale doc was written, with pending cleared and done left untouched
  assert.equal(c.replaced.length, 1);
  assert.equal(c.replaced[0].id, "stale-1");
  assert.equal(c.replaced[0].pk, "fletcher.com");
  assert.equal(c.replaced[0].doc.second_look_pending, false);
  assert.equal(c.replaced[0].doc.second_look_done, undefined, "done must stay unset so a real second-look can still run later");
  assert.equal(c.replaced[0].doc.second_look.cleared_reason, "watchdog_stale_timeout");
});

test("sweep is a no-op when nothing is stale", async () => {
  const c = mockContainer([
    { id: "a", second_look_pending: true, second_look_enqueued_at: iso(60 * 1000), normalized_domain: "a.com" },
  ]);
  const res = await sweepStaleSecondLook(c, { nowMs: NOW, log: () => {} });
  assert.equal(res.cleared, 0);
  assert.equal(c.replaced.length, 0);
});
