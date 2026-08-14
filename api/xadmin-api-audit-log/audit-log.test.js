"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("./index.js");

// The sortable admin audit table.
//
// Two behaviors carry weight beyond "it returns rows":
//   1. The default window is bounded (72h). An unbounded default would walk the
//      whole container on every page load, and this container grows forever.
//   2. A degraded sort is REPORTED. Falling back to single-field ordering when
//      the composite index isn't live yet is fine; doing it silently is not,
//      because a wrong order looks exactly like a right one.

function makeReq(query = {}) {
  return { method: "GET", url: "https://x.test/api/xadmin-api-audit-log", query };
}

const NOW = new Date("2026-08-13T18:00:00Z");

// ── The window ──────────────────────────────────────────────────────

test("window: defaults to the previous 72 hours", () => {
  const win = _test.resolveWindow(makeReq(), NOW);

  assert.equal(win.to, NOW.toISOString());
  assert.equal(win.from, new Date("2026-08-10T18:00:00Z").toISOString());
  assert.equal(win.hours, 72);
  assert.equal(win.is_default, true);
});

test("window: an explicit range overrides the default entirely", () => {
  const win = _test.resolveWindow(
    makeReq({ from: "2026-01-01T00:00:00Z", to: "2026-08-13T00:00:00Z" }),
    NOW
  );

  assert.equal(win.from, "2026-01-01T00:00:00.000Z");
  assert.equal(win.is_default, false);
  assert.ok(win.hours > 5000, "an arbitrarily wide range is allowed — the operator decides");
});

test("window: either bound can be set independently", () => {
  const win = _test.resolveWindow(makeReq({ from: "2026-08-01T00:00:00Z" }), NOW);

  assert.equal(win.from, "2026-08-01T00:00:00.000Z");
  assert.equal(win.to, NOW.toISOString());
});

test("window: an unparseable bound falls back rather than returning everything", () => {
  const win = _test.resolveWindow(makeReq({ from: "last tuesday" }), NOW);

  assert.equal(win.hours, 72, "garbage in must not mean an unbounded scan");
});

// ── Sorting ─────────────────────────────────────────────────────────

test("sort: defaults to newest first", () => {
  const sort = _test.resolveSort(makeReq());
  assert.deepEqual(sort, { field: "created_at", dir: "desc", rejected: null });
});

test("sort: an unknown column is rejected, never interpolated into the SQL", () => {
  const sort = _test.resolveSort(makeReq({ sort: "c.actor_email DESC; DROP" }));

  assert.equal(sort.field, "created_at", "falls back to the safe default");
  assert.equal(sort.rejected, "c.actor_email DESC; DROP", "and the caller is told");
});

test("sort: direction is honoured", () => {
  assert.equal(_test.resolveSort(makeReq({ dir: "asc" })).dir, "asc");
  assert.equal(_test.resolveSort(makeReq({ dir: "sideways" })).dir, "desc");
});

test("query: a non-time sort is paired with time so rows group sensibly", () => {
  const spec = _test.buildQuery({
    window: { from: "a", to: "b" },
    sort: { field: "actor_email", dir: "asc" },
    limit: 100,
    filters: {},
    multiField: true,
  });

  assert.match(spec.query, /ORDER BY c\.actor_email ASC, c\.created_at DESC/);
});

test("query: the fallback drops to a single ORDER BY field", () => {
  const spec = _test.buildQuery({
    window: { from: "a", to: "b" },
    sort: { field: "actor_email", dir: "asc" },
    limit: 100,
    filters: {},
    multiField: false,
  });

  assert.match(spec.query, /ORDER BY c\.actor_email ASC$/);
});

test("query: sorting by time needs no pairing in either mode", () => {
  for (const multiField of [true, false]) {
    const spec = _test.buildQuery({
      window: { from: "a", to: "b" },
      sort: { field: "created_at", dir: "desc" },
      limit: 100,
      filters: {},
      multiField,
    });
    assert.match(spec.query, /ORDER BY c\.created_at DESC$/);
  }
});

// ── Filters ─────────────────────────────────────────────────────────

test("query: the time window is always applied", () => {
  const spec = _test.buildQuery({
    window: { from: "2026-08-10T00:00:00Z", to: "2026-08-13T00:00:00Z" },
    sort: { field: "created_at", dir: "desc" },
    limit: 100,
    filters: {},
    multiField: true,
  });

  assert.match(spec.query, /c\.created_at >= @from/);
  assert.match(spec.query, /c\.created_at <= @to/);
  assert.equal(spec.parameters.find((p) => p.name === "@from").value, "2026-08-10T00:00:00Z");
});

test("query: filters are parameterized, not interpolated", () => {
  const spec = _test.buildQuery({
    window: { from: "a", to: "b" },
    sort: { field: "created_at", dir: "desc" },
    limit: 100,
    filters: { actor_email: "dana@tabarnam.com", action: "update", company_id: "company_1" },
    multiField: true,
  });

  assert.ok(!spec.query.includes("dana@tabarnam.com"), "values never reach the SQL string");
  assert.equal(spec.parameters.find((p) => p.name === "@actor").value, "dana@tabarnam.com");
  assert.equal(spec.parameters.find((p) => p.name === "@action").value, "update");
  assert.equal(spec.parameters.find((p) => p.name === "@company_id").value, "company_1");
});

// ── Projection ──────────────────────────────────────────────────────

test("projection: the heavy diff payload is dropped", () => {
  const row = _test.projectRow({
    id: "audit_1",
    company_id: "company_1",
    created_at: "2026-08-13T00:00:00Z",
    actor_email: "dana@tabarnam.com",
    action: "update",
    changed_fields: ["logo_url", "amazon_url"],
    diff: { logo_url: { before: "x".repeat(2000), after: "y".repeat(2000) } },
  });

  assert.equal(row.diff, undefined, "the table shows headlines; detail lives per-company");
  assert.deepEqual(row.changed_fields, ["logo_url", "amazon_url"]);
  assert.equal(row.changed_field_count, 2);
});

test("projection: batch summaries are flagged and carry no company id", () => {
  const row = _test.projectRow({
    id: "audit_2",
    company_id: "_batch_summary",
    action: "bulk_import_summary",
    summary: { companies: 24 },
  });

  assert.equal(row.is_batch_summary, true);
  assert.equal(row.company_id, null);
  assert.deepEqual(row.summary, { companies: 24 });
});

test("clampLimit: bounded, with a sane default", () => {
  assert.equal(_test.clampLimit(undefined), 100);
  assert.equal(_test.clampLimit("50"), 50);
  assert.equal(_test.clampLimit(99999), _test.MAX_LIMIT);
  assert.equal(_test.clampLimit(0), 1);
});

// ── Degraded ordering ───────────────────────────────────────────────

test("detects the missing-composite-index error specifically", () => {
  const composite = Object.assign(new Error("The order by query does not have a corresponding composite index"), { code: 400 });
  const otherBadRequest = Object.assign(new Error("Syntax error"), { code: 400 });
  const serverError = Object.assign(new Error("boom"), { code: 500 });

  assert.equal(_test.isMissingCompositeIndexError(composite), true);
  assert.equal(_test.isMissingCompositeIndexError(otherBadRequest), false, "must not swallow real errors");
  assert.equal(_test.isMissingCompositeIndexError(serverError), false);
});

test("falls back to single-field ordering AND reports it", async () => {
  let attempts = 0;

  const container = {
    items: {
      query(spec) {
        return {
          async fetchNext() {
            attempts++;
            if (/ORDER BY .+,/.test(spec.query)) {
              const err = new Error("The order by query does not have a corresponding composite index");
              err.code = 400;
              throw err;
            }
            return { resources: [{ id: "audit_1", created_at: "2026-08-13T00:00:00Z", action: "update" }], continuationToken: null };
          },
        };
      },
    },
  };

  const res = await _test.handleGet(makeReq({ sort: "actor_email" }), { log() {} }, { container, now: NOW });
  const body = JSON.parse(res.body);

  assert.equal(res.status, 200);
  assert.equal(attempts, 2, "tried the indexed order, then the fallback");
  assert.equal(body.ordering, "degraded_no_composite_index", "a silent degradation is a wrong answer that looks right");
  assert.equal(body.items.length, 1);
});

test("a non-index query failure is surfaced, not disguised as a fallback", async () => {
  const container = {
    items: {
      query() {
        return {
          async fetchNext() {
            const err = new Error("Cosmos exploded");
            err.code = 500;
            throw err;
          },
        };
      },
    },
  };

  const res = await _test.handleGet(makeReq(), { log() {} }, { container, now: NOW });

  assert.equal(res.status, 500);
  assert.equal(JSON.parse(res.body).error, "query_failed");
});

test("paging: the continuation token is passed through", async () => {
  let seenToken = null;

  const container = {
    items: {
      query(_spec, options) {
        seenToken = options?.continuationToken || null;
        return {
          async fetchNext() {
            return { resources: [], continuationToken: "next-page-token" };
          },
        };
      },
    },
  };

  const res = await _test.handleGet(
    makeReq({ cursor: "page-2-token" }),
    { log() {} },
    { container, now: NOW }
  );

  assert.equal(seenToken, "page-2-token", "the caller's cursor reaches Cosmos");
  assert.equal(JSON.parse(res.body).next_cursor, "next-page-token");
});

test("the response states the window it actually used", async () => {
  const container = {
    items: {
      query() {
        return { async fetchNext() { return { resources: [], continuationToken: null }; } };
      },
    },
  };

  const res = await _test.handleGet(makeReq(), { log() {} }, { container, now: NOW });
  const body = JSON.parse(res.body);

  assert.equal(body.window.hours, 72);
  assert.equal(body.window.is_default, true, "the UI must be able to say 'last 72 hours'");
});

// ── All-time window and company-name resolution ─────────────────────

test("all=1 lifts the lower bound and says so", () => {
  const win = _test.resolveWindow(makeReq({ all: "1" }), NOW);

  assert.equal(win.is_all_time, true);
  assert.equal(win.from, new Date(0).toISOString());
  assert.equal(win.hours, null, "an unbounded window has no hour count to report");
});

test("all-time is opt-in — the default stays bounded", () => {
  assert.equal(_test.resolveWindow(makeReq(), NOW).is_all_time, false);
  assert.equal(_test.resolveWindow(makeReq({ all: "0" }), NOW).is_all_time, false);
});

test("company_ids narrows to the resolved set", () => {
  const spec = _test.buildQuery({
    window: { from: "a", to: "b" },
    sort: { field: "created_at", dir: "desc" },
    limit: 100,
    filters: { company_ids: ["company_1", "company_2"] },
    multiField: true,
  });

  assert.match(spec.query, /c\.company_id IN \(@cid0, @cid1\)/);
  assert.equal(spec.parameters.find((p) => p.name === "@cid0").value, "company_1");
  assert.ok(!spec.query.includes("company_1"), "ids are parameterized, not interpolated");
});

test("no company_ids means no IN clause at all", () => {
  const spec = _test.buildQuery({
    window: { from: "a", to: "b" },
    sort: { field: "created_at", dir: "desc" },
    limit: 100,
    filters: { company_ids: [] },
    multiField: true,
  });

  assert.ok(!spec.query.includes("IN ("), "an empty list must not become a filter");
});

test("a name search that matched nothing returns nothing, not everything", async () => {
  // The dangerous case: dropping an empty id list would show ALL activity and
  // read as "nobody ever touched this company".
  let queried = false;
  const container = {
    items: {
      query() {
        queried = true;
        return { async fetchNext() { return { resources: [], continuationToken: null }; } };
      },
    },
  };

  const res = await _test.handleGet(
    makeReq({ company_ids: "__none__" }),
    { log() {} },
    { container, now: NOW }
  );
  const body = JSON.parse(res.body);

  assert.equal(body.ok, true);
  assert.deepEqual(body.items, []);
  assert.equal(body.no_company_match, true, "the page can say 'no company matched'");
  assert.equal(queried, false, "and it costs no query");
});
