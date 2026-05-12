"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// ── Phase 3.4.B — fresh-worker guard on the in_progress stale-recovery ─────
//
// Empirical (2026-05-11 Scrub Daddy session ba13cfce, build fa36ec58):
//   • Hudson Essentials + Scrub Daddy submitted as a 2-company batch
//   • Both saved, resume-worker enqueued for both with 1s delay
//   • Hudson's queue-triggered worker entered, set status=in_progress, started
//     canonical call (acquired xAI lock first)
//   • 3 seconds after Scrub Daddy's enqueue, import-status's HTTP self-
//     invocation ALSO fired the resume-worker for Scrub Daddy (redundant)
//   • Scrub Daddy's queue-trigger had already entered with in_progress set
//     but hadn't written a heartbeat yet (first heartbeat throttled to 30s)
//   • The HTTP-self-invocation worker saw status=in_progress + heartbeatAt=0
//     and the prior buggy condition `heartbeatAgeMs >= 60_000` fired
//     because Infinity >= 60_000 is TRUE → "stale" declared after 0s of
//     enrichment → in_progress cleared → active worker corrupted
//   • Scrub Daddy never completed → Stub-0%
//
// Phase 3.4.B fix: require enrichment to actually be old enough to be stale
// before any "stale" declaration. A fresh worker (enrichmentAgeMs < 60s)
// is never stale by definition.

const HANDLER_SRC = fs.readFileSync(
  path.join(__dirname, "handler.js"),
  "utf8"
);

test("Phase 3.4.B: stale-watchdog requires enrichmentAge >= enrichmentStaleMs before declaring stale", () => {
  // Source-level guard: the new gating constants must be declared.
  assert.ok(
    /const enrichmentOldEnoughToStale\s*=\s*enrichmentAgeMs\s*>=\s*enrichmentStaleMs/.test(HANDLER_SRC),
    "must declare `enrichmentOldEnoughToStale = enrichmentAgeMs >= enrichmentStaleMs`"
  );
  assert.ok(
    /const heartbeatStale\s*=\s*enrichmentOldEnoughToStale\s*&&\s*heartbeatAgeMs\s*>=\s*enrichmentStaleMs/.test(HANDLER_SRC),
    "must declare `heartbeatStale = enrichmentOldEnoughToStale && heartbeatAgeMs >= enrichmentStaleMs`"
  );
  assert.ok(
    /const heartbeatNeverWrittenAfterLongRun\s*=\s*enrichmentAgeMs\s*>=\s*420_000\s*&&\s*!heartbeatAt/.test(HANDLER_SRC),
    "must declare `heartbeatNeverWrittenAfterLongRun = enrichmentAgeMs >= 420_000 && !heartbeatAt`"
  );
});

test("Phase 3.4.B: stale-watchdog if-condition uses the new gated variables", () => {
  // The if-statement that fires the stale-recovery upsert must use the
  // new gated form, not the prior unguarded heartbeatAgeMs >= enrichmentStaleMs.
  assert.ok(
    /if\s*\(\s*heartbeatStale\s*\|\|\s*heartbeatNeverWrittenAfterLongRun\s*\)/.test(HANDLER_SRC),
    "if-condition must be `if (heartbeatStale || heartbeatNeverWrittenAfterLongRun)`"
  );
});

test("Phase 3.4.B: regression guard — the prior buggy unguarded heartbeatAgeMs check must be gone", () => {
  // The old buggy form was:
  //   if (heartbeatAgeMs >= enrichmentStaleMs || (enrichmentAgeMs >= 420_000 && !heartbeatAt)) {
  // It must NOT be present anymore in the resume_worker branch (note: the
  // direct_http branch above it is a different check, intentionally left alone).
  //
  // Match precisely: `if (heartbeatAgeMs >= enrichmentStaleMs` (without the new
  // `enrichmentOldEnoughToStale &&` prefix) — that's the form that caused the
  // 0-second-stale bug.
  assert.ok(
    !/if\s*\(\s*heartbeatAgeMs\s*>=\s*enrichmentStaleMs\s*\|\|/.test(HANDLER_SRC),
    "the old unguarded `if (heartbeatAgeMs >= enrichmentStaleMs || ...)` must NOT appear (Phase 3.4.B regression guard)"
  );
});

// ── Logical simulation of the watchdog condition ────────────────────────────
//
// Reproduce the Phase 3.4.B fix as a pure function so we can unit-test the
// behavior across the scenario matrix. This must mirror the if-statement in
// handler.js exactly so a future drift in the source breaks one of the
// source-level tests above.

function shouldFireStaleWatchdog({ heartbeatAt, enrichmentAgeMs }) {
  const enrichmentStaleMs = 60_000;
  const heartbeatAgeMs = heartbeatAt ? Date.now() - heartbeatAt : Infinity;
  const enrichmentOldEnoughToStale = enrichmentAgeMs >= enrichmentStaleMs;
  const heartbeatStale = enrichmentOldEnoughToStale && heartbeatAgeMs >= enrichmentStaleMs;
  const heartbeatNeverWrittenAfterLongRun = enrichmentAgeMs >= 420_000 && !heartbeatAt;
  return heartbeatStale || heartbeatNeverWrittenAfterLongRun;
}

test("Phase 3.4.B: fresh worker (enrichmentAge=0s, heartbeat=never) → NOT stale", () => {
  // This is the Scrub Daddy scenario. Must NOT fire.
  assert.equal(
    shouldFireStaleWatchdog({ heartbeatAt: 0, enrichmentAgeMs: 0 }),
    false,
    "fresh worker (enrichmentAge=0, heartbeat=never) must NOT be declared stale"
  );
});

test("Phase 3.4.B: young worker (enrichmentAge=15s, heartbeat=never) → NOT stale", () => {
  // Even with no heartbeat yet, 15s of enrichment is still well below the 60s
  // threshold. The worker is just slow to write its first heartbeat. Not stale.
  assert.equal(
    shouldFireStaleWatchdog({ heartbeatAt: 0, enrichmentAgeMs: 15_000 }),
    false,
    "young worker (15s, no heartbeat) must NOT be declared stale"
  );
});

test("Phase 3.4.B: at-threshold worker (enrichmentAge=60s, heartbeat=never) → stale", () => {
  // 60s of enrichment with no heartbeat = real stall (heartbeats throttled
  // to 30s should have written by now). DOES fire.
  assert.equal(
    shouldFireStaleWatchdog({ heartbeatAt: 0, enrichmentAgeMs: 60_000 }),
    true,
    "60s+ with no heartbeat must be declared stale"
  );
});

test("Phase 3.4.B: long-running worker (enrichmentAge=8min, heartbeat=never) → stale (dead-on-start)", () => {
  // The "never wrote a heartbeat AND has been running 7+ min" case. Dead.
  assert.equal(
    shouldFireStaleWatchdog({ heartbeatAt: 0, enrichmentAgeMs: 480_000 }),
    true,
    "7+ min with no heartbeat ever must be declared stale (dead-on-start)"
  );
});

test("Phase 3.4.B: stalled worker (enrichmentAge=10min, heartbeat 90s old) → stale", () => {
  // Heartbeat went stale. Real stall. DOES fire.
  assert.equal(
    shouldFireStaleWatchdog({
      heartbeatAt: Date.now() - 90_000,
      enrichmentAgeMs: 600_000,
    }),
    true,
    "10min enrichment with 90s-stale heartbeat must be declared stale"
  );
});

test("Phase 3.4.B: healthy worker (enrichmentAge=5min, heartbeat 10s old) → NOT stale", () => {
  // Healthy active worker. Must NOT fire (would corrupt active work).
  assert.equal(
    shouldFireStaleWatchdog({
      heartbeatAt: Date.now() - 10_000,
      enrichmentAgeMs: 300_000,
    }),
    false,
    "active worker with fresh heartbeat must NOT be declared stale"
  );
});

test("Phase 3.4.B: just-started worker that DID write an early heartbeat → NOT stale", () => {
  // Worker entered at t=0, wrote first heartbeat at t=5s, now we re-enter at
  // t=20s via redundant trigger. The 15s-old heartbeat is fresh.
  // enrichmentAgeMs=20s, heartbeatAgeMs=15s. Neither path fires.
  assert.equal(
    shouldFireStaleWatchdog({
      heartbeatAt: Date.now() - 15_000,
      enrichmentAgeMs: 20_000,
    }),
    false,
    "young worker with fresh heartbeat must NOT be declared stale"
  );
});
