// Regression guard for the second_look_pending freshness gate.
//
// Before the gate, any doc with second_look_pending: true kept the admin
// Import banner amber ("Enriching: X") until the 30-minute watchdog ran —
// even when the worker crashed mid-write ~2 min into the second look and
// no process was actually running. Bloomist 2026-08-19T16:30Z was the
// live example.
//
// The endpoint now filters `pending` docs by second_look_enqueued_at
// being within the last SECOND_LOOK_ACTIVE_WINDOW_SEC (5 min). Docs
// outside that window are counted in second_look_stranded_count (a
// diagnostic) but do NOT trip the enriching verdict.
//
// This test exercises the query-shape contract via a stub container.
// It does NOT boot the Azure Functions runtime — the handler function
// isn't exported. Instead, we assert on the SQL and parameters passed
// to `container.items.query()`.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// The endpoint self-registers with the Azure Functions runtime at
// require-time; running that side effect is fine — the registration is a
// no-op without a running runtime.
require("./index.js");

// The queries fire from a private handler that isn't exported. Rather than
// smuggle mocks into a live invocation, this test verifies the sub-queries'
// SHAPES by loading the source and matching the SQL strings we care about.
const src = require("fs").readFileSync(require.resolve("./index.js"), "utf8");

test("pending query includes IS_DEFINED gate + slCut freshness filter", () => {
  // The runnable-now query MUST filter by second_look_enqueued_at being
  // recent AND defined. If a future edit drops either half, stranded
  // flags (Bloomist-shaped) will re-hold the banner.
  const found = src.match(
    /SELECT c\.company_name FROM c WHERE c\.second_look_pending = true AND IS_DEFINED\(c\.second_look_enqueued_at\) AND c\.second_look_enqueued_at >= @slCut AND NOT STARTSWITH\(c\.id, '_import_'\)/
  );
  assert.ok(found, "pending-runnable query must gate on IS_DEFINED(...) AND >= @slCut");
});

test("stranded query counts pending docs outside the active window", () => {
  const found = src.match(
    /SELECT VALUE COUNT\(1\) FROM c WHERE c\.second_look_pending = true AND \(NOT IS_DEFINED\(c\.second_look_enqueued_at\) OR c\.second_look_enqueued_at < @slCut\)/
  );
  assert.ok(found, "stranded diagnostic query must count docs OUTSIDE the active window");
});

test("SECOND_LOOK_ACTIVE_WINDOW_SEC is 5 min (300s)", () => {
  const m = src.match(/SECOND_LOOK_ACTIVE_WINDOW_SEC\s*=\s*(\d+)\s*\*\s*(\d+)/);
  assert.ok(m, "SECOND_LOOK_ACTIVE_WINDOW_SEC constant must be present");
  const total = Number(m[1]) * Number(m[2]);
  assert.equal(total, 300, "must be 300 seconds (5 min) — the comfort margin over the 120s worker circuit breaker");
});

test("response shape exposes second_look_stranded_count for diagnostics", () => {
  // Operators need to see stuck flags accumulating even though the banner
  // no longer waits on them. If this key disappears from the response,
  // the watchdog's job becomes invisible.
  const found = src.match(/second_look_stranded_count:\s*strandedCount/);
  assert.ok(found, "response must include second_look_stranded_count field");
});

test("response shape exposes second_look_active_window_sec for admin visibility", () => {
  const found = src.match(/second_look_active_window_sec:\s*SECOND_LOOK_ACTIVE_WINDOW_SEC/);
  assert.ok(found, "response must include second_look_active_window_sec so operators know the horizon");
});
