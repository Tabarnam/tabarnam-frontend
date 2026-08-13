"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  consumeImportQuota,
  getQuotaDayKey,
  getDailyImportLimit,
  isMetered,
  DEFAULT_DAILY_LIMIT,
} = require("./_importQuota");

// Per-contributor daily import allowance.
//
// Two properties matter most:
//   1. Staff are never metered. Admin imports run to thousands of companies a
//      day, and the internal queue workers carry no user identity — metering
//      either would throttle a legitimate import mid-run.
//   2. It fails CLOSED. This guards spend; an unreadable meter is not evidence
//      of remaining budget.

function makeQuotaContainer(seed = []) {
  const store = new Map();
  for (const doc of seed) store.set(String(doc.id), { ...doc, _etag: `etag-0` });

  let etagCounter = 0;
  const calls = { reads: 0, writes: 0 };

  return {
    calls,
    item(id) {
      return {
        async read() {
          calls.reads++;
          const doc = store.get(String(id));
          if (!doc) {
            const err = new Error("NotFound");
            err.code = 404;
            throw err;
          }
          return { resource: doc };
        },
      };
    },
    items: {
      async upsert(doc, options) {
        calls.writes++;
        const existing = store.get(String(doc.id));
        const required = options?.accessCondition?.condition;

        if (required && existing && existing._etag !== required) {
          const err = new Error("PreconditionFailed");
          err.code = 412;
          throw err;
        }

        etagCounter++;
        const stored = { ...doc, _etag: `etag-${etagCounter}` };
        store.set(String(doc.id), stored);
        return { resource: stored };
      },
      // Cosmos semantics: create conflicts if the id already exists. This is
      // what makes the FIRST write of a day safe against a race.
      async create(doc) {
        calls.writes++;
        if (store.has(String(doc.id))) {
          const err = new Error("Conflict");
          err.code = 409;
          throw err;
        }

        etagCounter++;
        const stored = { ...doc, _etag: `etag-${etagCounter}` };
        store.set(String(doc.id), stored);
        return { resource: stored };
      },
    },
    _get: (id) => store.get(String(id)) || null,
    _dump: () => Array.from(store.values()),
  };
}

const DANA = "dana@tabarnam.com";
const AUG_13_NOON_PT = new Date("2026-08-13T19:00:00Z"); // 12:00 PDT

// ── Who is metered ──────────────────────────────────────────────────

test("only contributors are metered", () => {
  assert.equal(isMetered({ __role: "contributor" }), true);
  assert.equal(isMetered({ __role: "admin" }), false, "staff imports are never capped");
  assert.equal(isMetered({}), false, "internal jobs carry no role and must not be capped");
  assert.equal(isMetered(undefined), false);
});

// ── The day boundary ────────────────────────────────────────────────

test("the day key is a Pacific calendar day, not UTC", () => {
  // 2026-08-13 23:30 PDT is already the 14th in UTC. The allowance must not
  // reset while the contributor is still in their own workday.
  assert.equal(getQuotaDayKey(new Date("2026-08-14T06:30:00Z")), "2026-08-13");
});

test("the day rolls at Pacific midnight", () => {
  assert.equal(getQuotaDayKey(new Date("2026-08-14T06:59:00Z")), "2026-08-13");
  assert.equal(getQuotaDayKey(new Date("2026-08-14T07:01:00Z")), "2026-08-14");
});

test("the day key survives the standard-time offset change", () => {
  // In January, Pacific is UTC-8 rather than UTC-7.
  assert.equal(getQuotaDayKey(new Date("2027-01-14T07:30:00Z")), "2027-01-13");
  assert.equal(getQuotaDayKey(new Date("2027-01-14T08:30:00Z")), "2027-01-14");
});

test("the default limit is 1000 companies per day", () => {
  assert.equal(DEFAULT_DAILY_LIMIT, 1000);
  assert.equal(getDailyImportLimit(), 1000);
});

// ── Accounting ──────────────────────────────────────────────────────

test("a first import of the day creates the counter", async () => {
  const container = makeQuotaContainer();

  const result = await consumeImportQuota({
    container,
    email: DANA,
    count: 250,
    now: AUG_13_NOON_PT,
  });

  assert.equal(result.ok, true);
  assert.equal(result.used, 250);
  assert.equal(result.remaining, 750);
  assert.equal(result.day, "2026-08-13");
});

test("successive imports accumulate against the same day", async () => {
  const container = makeQuotaContainer();
  const args = { container, email: DANA, now: AUG_13_NOON_PT };

  await consumeImportQuota({ ...args, count: 600 });
  const second = await consumeImportQuota({ ...args, count: 300 });

  assert.equal(second.ok, true);
  assert.equal(second.used, 900);
  assert.equal(second.remaining, 100);
});

test("a batch that would cross the limit is refused whole, not partially", async () => {
  const container = makeQuotaContainer();
  const args = { container, email: DANA, now: AUG_13_NOON_PT };

  await consumeImportQuota({ ...args, count: 900 });
  const denied = await consumeImportQuota({ ...args, count: 200 });

  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "daily_limit_reached");
  assert.equal(denied.remaining, 100);

  // The refused batch must not have been charged.
  const stored = container._dump()[0];
  assert.equal(stored.used, 900, "a denied request costs nothing");
});

test("a single request larger than the whole day is refused immediately", async () => {
  const container = makeQuotaContainer();

  const denied = await consumeImportQuota({
    container,
    email: DANA,
    count: 5000,
    now: AUG_13_NOON_PT,
  });

  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "request_exceeds_daily_limit");
  assert.equal(container.calls.writes, 0, "no counter is touched");
});

test("a new Pacific day starts a fresh allowance", async () => {
  const container = makeQuotaContainer();

  await consumeImportQuota({ container, email: DANA, count: 1000, now: AUG_13_NOON_PT });

  const nextDay = await consumeImportQuota({
    container,
    email: DANA,
    count: 500,
    now: new Date("2026-08-14T19:00:00Z"),
  });

  assert.equal(nextDay.ok, true);
  assert.equal(nextDay.used, 500, "the counter is per day, not cumulative");
});

test("contributors are metered independently of each other", async () => {
  const container = makeQuotaContainer();
  const now = AUG_13_NOON_PT;

  await consumeImportQuota({ container, email: DANA, count: 1000, now });
  const other = await consumeImportQuota({
    container,
    email: "sam@tabarnam.com",
    count: 400,
    now,
  });

  assert.equal(other.ok, true, "one person exhausting their day must not block another");
});

test("a zero-company request is not a quota event", async () => {
  const container = makeQuotaContainer();

  const result = await consumeImportQuota({ container, email: DANA, count: 0, now: AUG_13_NOON_PT });

  assert.equal(result.ok, true);
  assert.equal(container.calls.writes, 0);
});

test("counters carry a TTL so they age out on their own", async () => {
  const container = makeQuotaContainer();

  await consumeImportQuota({ container, email: DANA, count: 1, now: AUG_13_NOON_PT });

  assert.ok(container._dump()[0].ttl > 0, "the counter document expires");
});

// ── Concurrency ─────────────────────────────────────────────────────

test("a concurrent write is retried rather than overwritten", async () => {
  const container = makeQuotaContainer();
  const args = { container, email: DANA, now: AUG_13_NOON_PT };

  // Two batches racing from the same contributor. Serialized by the ETag
  // compare-and-set, so the total is exact rather than last-write-wins.
  const [a, b] = await Promise.all([
    consumeImportQuota({ ...args, count: 400 }),
    consumeImportQuota({ ...args, count: 300 }),
  ]);

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(container._get(container._dump()[0].id).used, 700, "neither batch was lost");
});

// ── Failing closed ──────────────────────────────────────────────────

test("an unreachable quota store denies rather than allows", async () => {
  const container = {
    item() {
      return {
        async read() {
          const err = new Error("ServiceUnavailable");
          err.code = 503;
          throw err;
        },
      };
    },
    items: { async upsert() {} },
  };

  const result = await consumeImportQuota({ container, email: DANA, count: 10 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "quota_store_unavailable");
});

test("an unresolved identity is refused", async () => {
  const result = await consumeImportQuota({ container: makeQuotaContainer(), email: "", count: 5 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unresolved_identity");
});
