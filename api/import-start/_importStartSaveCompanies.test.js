"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { isEnrichmentComplete } = require("./_importStartSaveCompanies");

// ── Phase 3.4.A — infrastructure-failure reasons are NOT decided ────────────
//
// Empirical (2026-05-11 HIC Kitchen + Greater Goods):
//   1. User pastes URLs into bulk import.
//   2. Phase 3.4 single-call canonical fires.
//   3. xAI returns 503 (HIC) or silent SSE-stall (Greater Goods).
//   4. canonical writes import_missing_reason = "upstream_503" / "sse_stall"
//      for every field, AND increments import_attempts.<field> by 1.
//   5. User re-pastes the URLs to retry the import.
//   6. Pre-Phase-3.4.A: dedup gate fires in 4-6 seconds returning
//      "duplicate_detected" because isEnrichmentComplete returns true
//      (Tier 2: attempts >= 1 → "decided"). User stuck.
//   7. Phase 3.4.A: isEnrichmentComplete recognises infrastructure-failure
//      reasons and returns false even when attempts >= 1. User can retry.

test("Phase 3.4.A: isEnrichmentComplete returns false when missing field has upstream_503 reason (even if attempted)", () => {
  const doc = {
    import_missing_fields: ["tagline", "headquarters_location"],
    import_missing_reason: {
      tagline: "upstream_503",
      headquarters_location: "upstream_503",
    },
    import_attempts: { tagline: 1, headquarters_location: 1 },
  };
  assert.equal(
    isEnrichmentComplete(doc),
    false,
    "503 with attempts >= 1 must NOT count as decided — re-import should be allowed"
  );
});

test("Phase 3.4.A: isEnrichmentComplete returns false for sse_stall reason (even if attempted)", () => {
  const doc = {
    import_missing_fields: ["tagline", "headquarters_location", "manufacturing_locations"],
    import_missing_reason: {
      tagline: "sse_stall",
      headquarters_location: "sse_stall",
      manufacturing_locations: "sse_stall",
    },
    import_attempts: { tagline: 1, headquarters_location: 1, manufacturing_locations: 1 },
  };
  assert.equal(
    isEnrichmentComplete(doc),
    false,
    "sse_stall with attempts >= 1 must NOT count as decided"
  );
});

test("Phase 3.4.A: isEnrichmentComplete returns false for model_emitted_no_text reason", () => {
  const doc = {
    import_missing_fields: ["tagline"],
    import_missing_reason: { tagline: "model_emitted_no_text" },
    import_attempts: { tagline: 1 },
  };
  assert.equal(isEnrichmentComplete(doc), false);
});

test("Phase 3.4.A: isEnrichmentComplete returns false for upstream_timeout (non-terminal)", () => {
  const doc = {
    import_missing_fields: ["tagline"],
    import_missing_reason: { tagline: "upstream_timeout" },
    import_attempts: { tagline: 1 },
  };
  assert.equal(
    isEnrichmentComplete(doc),
    false,
    "plain upstream_timeout (not _terminal) is retryable"
  );
});

test("Phase 3.4.A: isEnrichmentComplete still returns true for upstream_timeout_terminal", () => {
  // The _terminal variant IS in isTerminalMissingReason → decided.
  const doc = {
    import_missing_fields: ["reviews"],
    import_missing_reason: { reviews: "upstream_timeout_terminal" },
    import_attempts: { reviews: 2 },
  };
  assert.equal(
    isEnrichmentComplete(doc),
    true,
    "upstream_timeout_terminal IS decided (2+ failures exhausted retry budget)"
  );
});

test("Phase 3.4.A: isEnrichmentComplete still returns true for not_found reason (model genuinely couldn't find)", () => {
  // not_found is a "model attempted, found nothing" signal — that IS a real decision.
  // Only INFRA failures (the model never got a chance to actually research) are retryable.
  const doc = {
    import_missing_fields: ["tagline"],
    import_missing_reason: { tagline: "not_found" },
    import_attempts: { tagline: 1 },
  };
  assert.equal(
    isEnrichmentComplete(doc),
    true,
    "not_found is a legitimate model decision — re-import should be skipped"
  );
});

test("Phase 3.4.A: isEnrichmentComplete returns true when all fields are populated (Tier 0)", () => {
  const doc = {
    import_missing_fields: [],  // no missing → complete
    import_missing_reason: {},
    import_attempts: { tagline: 1, headquarters_location: 1 },
  };
  assert.equal(isEnrichmentComplete(doc), true);
});

test("Phase 3.4.A: isEnrichmentComplete returns false when a field has only placeholder reason and no attempts (Tier 2 baseline)", () => {
  // Baseline regression guard: behaviour for placeholder reasons must be
  // unchanged from pre-3.4.A.
  const doc = {
    import_missing_fields: ["tagline"],
    import_missing_reason: { tagline: "pending" },  // placeholder
    import_attempts: {},
  };
  assert.equal(
    isEnrichmentComplete(doc),
    false,
    "placeholder reason with no attempts must remain not-decided"
  );
});

test("Phase 3.4.A: isEnrichmentComplete mixed case — one infra failure + one populated → not complete", () => {
  const doc = {
    import_missing_fields: ["tagline"],  // mfg is populated; only tagline missing
    import_missing_reason: { tagline: "upstream_503" },
    import_attempts: { tagline: 1, manufacturing_locations: 1 },
  };
  assert.equal(
    isEnrichmentComplete(doc),
    false,
    "Even one infra-failure field must block 'complete' status"
  );
});
