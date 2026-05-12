"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Phase 3.10 — xAI concurrency circuit breaker.
//
// Per Grok-4's 2026-05-12 architectural review, when XAI_CONCURRENCY > 1
// we need a safety net: if any pair of concurrent calls both go silent
// within 30s of each other, drop back to concurrency=1 for 10 min.
//
// Most of the circuit-breaker logic lives in handler.js as helper
// functions that touch Cosmos. Mocking the Cosmos container faithfully
// across test scenarios would be elaborate; instead, these tests assert
// the SOURCE-LEVEL contract — the helpers are declared, the constants
// have the right values, and the acquireXaiCallLock integration point
// reads them.

const HANDLER_SRC = fs.readFileSync(
  path.join(__dirname, "import", "resume-worker", "handler.js"),
  "utf8"
);

test("Phase 3.10: circuit-breaker constants are declared with correct values", () => {
  // The 4 constants that drive breaker behavior:
  assert.ok(
    /const XAI_CIRCUIT_BREAKER_DOC_ID\s*=\s*"_xai_concurrency_circuit_breaker"/.test(HANDLER_SRC),
    "XAI_CIRCUIT_BREAKER_DOC_ID must be the canonical lock-partition-mate id"
  );
  assert.ok(
    /const XAI_STALL_RECORD_ID_PREFIX\s*=\s*"_xai_stall_record_"/.test(HANDLER_SRC),
    "XAI_STALL_RECORD_ID_PREFIX must be declared"
  );
  // 30s pair window — Grok-recommended.
  assert.ok(
    /const XAI_STALL_PAIR_WINDOW_MS\s*=\s*30_000/.test(HANDLER_SRC),
    "XAI_STALL_PAIR_WINDOW_MS must be 30_000ms (Grok recommendation)"
  );
  // 10-min trip TTL — Grok-recommended.
  assert.ok(
    /const XAI_CIRCUIT_BREAKER_TTL_MS\s*=\s*10\s*\*\s*60_000/.test(HANDLER_SRC),
    "XAI_CIRCUIT_BREAKER_TTL_MS must be 10 minutes (Grok recommendation)"
  );
  // 60s stall record TTL.
  assert.ok(
    /const XAI_STALL_RECORD_TTL_S\s*=\s*60/.test(HANDLER_SRC),
    "XAI_STALL_RECORD_TTL_S must be 60 seconds (covers the 30s pair window with headroom)"
  );
});

test("Phase 3.10: isCircuitBreakerTripped helper is defined and checks expires_at", () => {
  assert.ok(
    /async function isCircuitBreakerTripped\(container\)/.test(HANDLER_SRC),
    "isCircuitBreakerTripped helper must be defined"
  );
  // Must double-check expires_at because Cosmos TTL can lag.
  assert.ok(
    /Date\.parse\(String\(doc\.expires_at \|\| ""\)\)/.test(HANDLER_SRC),
    "isCircuitBreakerTripped must double-check expires_at (Cosmos TTL can lag)"
  );
});

test("Phase 3.10: recordSilentStallAndMaybeTripBreaker is defined with correct trigger contract", () => {
  assert.ok(
    /async function recordSilentStallAndMaybeTripBreaker\(/.test(HANDLER_SRC),
    "recordSilentStallAndMaybeTripBreaker must be defined"
  );
  // Must write stall record with 60s TTL.
  assert.ok(
    /ttl:\s*XAI_STALL_RECORD_TTL_S/.test(HANDLER_SRC),
    "stall record must set ttl: XAI_STALL_RECORD_TTL_S"
  );
  // Must query for OTHER recent stalls within the pair window.
  assert.ok(
    /stalled_at_ms\s*>=\s*@cutoff/.test(HANDLER_SRC),
    "must query stall records using stalled_at_ms >= cutoff"
  );
  // Must require 2+ distinct sessions before tripping.
  assert.ok(
    /distinctStalls\.length\s*<\s*2/.test(HANDLER_SRC),
    "must require >= 2 distinct sessions before tripping"
  );
  // Must record trip_reason on the trip doc.
  assert.ok(
    /trip_reason:\s*"concurrent_silent_stall_pair"/.test(HANDLER_SRC),
    "trip doc must include trip_reason: concurrent_silent_stall_pair"
  );
});

test("Phase 3.10: acquireXaiCallLock checks the breaker and caps concurrency to 1 when tripped", () => {
  // The check must run when configured concurrency > 1.
  assert.ok(
    /if\s*\(concurrency\s*>\s*1\)\s*\{[\s\S]*?const tripped\s*=\s*await isCircuitBreakerTripped\(container\)/.test(HANDLER_SRC),
    "acquireXaiCallLock must check isCircuitBreakerTripped when configured concurrency > 1"
  );
  // When tripped, concurrency must be reassigned to 1.
  assert.ok(
    /if\s*\(tripped\)\s*\{[\s\S]*?concurrency\s*=\s*1/.test(HANDLER_SRC),
    "when tripped, concurrency must be capped at 1"
  );
  // Concurrency must be declared with let (not const) so it can be
  // reassigned by the breaker check.
  assert.ok(
    /let concurrency\s*=\s*resolveXaiConcurrency\(\)/.test(HANDLER_SRC),
    "concurrency must be `let` not `const` so the breaker can override"
  );
});

test("Phase 3.10: post-canonical block records silent-stall on sse_stall + low tool count", () => {
  // The detection trigger: errorCode === "sse_stall" AND toolCalls < 2.
  assert.ok(
    /errorCode === "sse_stall"[\s\S]{0,200}toolCalls\s*<\s*2/.test(HANDLER_SRC),
    "post-canonical block must check errorCode === 'sse_stall' AND toolCalls < 2"
  );
  // Must call recordSilentStallAndMaybeTripBreaker.
  assert.ok(
    /recordSilentStallAndMaybeTripBreaker\(container,\s*\{[\s\S]{0,200}sessionId/.test(HANDLER_SRC),
    "post-canonical block must call recordSilentStallAndMaybeTripBreaker"
  );
  // Must NOT await it (best-effort, never block worker progress).
  assert.ok(
    /recordSilentStallAndMaybeTripBreaker\([\s\S]{0,500}\.catch\(/.test(HANDLER_SRC),
    "stall recording must be best-effort (.catch instead of await) so it never blocks the worker"
  );
});

test("Phase 3.10: stall record schema includes the right fields for pair detection", () => {
  // Must include session_id, stalled_at, stalled_at_ms, type, partition_key.
  // (stalled_at_ms is the numeric used by the pair-window query.)
  const stallRecordBlock = HANDLER_SRC.match(/const stallRecord\s*=\s*\{[\s\S]*?\};/);
  assert.ok(stallRecordBlock, "stallRecord literal must be defined");
  const block = stallRecordBlock[0];
  for (const field of [
    "session_id",
    "type",
    "stalled_at",
    "stalled_at_ms",
    "tool_calls_counted",
    "elapsed_ms",
    "ttl",
  ]) {
    assert.ok(block.includes(field), `stallRecord must include field: ${field}`);
  }
});

test("Phase 3.10: trip doc schema includes the right fields", () => {
  const tripDocBlock = HANDLER_SRC.match(/const tripDoc\s*=\s*\{[\s\S]*?\};/);
  assert.ok(tripDocBlock, "tripDoc literal must be defined");
  const block = tripDocBlock[0];
  for (const field of [
    "tripped_at",
    "expires_at",
    "expires_at_ms",
    "trip_reason",
    "paired_stall_session_ids",
    "pair_window_ms",
    "ttl",
  ]) {
    assert.ok(block.includes(field), `tripDoc must include field: ${field}`);
  }
});
