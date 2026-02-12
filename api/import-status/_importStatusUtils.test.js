const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  toMs,
  normalizeKey,
  normalizeDomain,
  extractNormalizedDomainFromQuery,
  computeCreatedAfterIso,
  deriveDomainAndCreatedAfter,
  toPositiveInt,
  normalizeErrorPayload,
  computeEffectiveResumeStatus,
  isSingleCompanyModeFromSession,
  isSingleCompanyModeFromSessionWithReason,
  hasRecentWorkerProgress,
  isInfraRetryableMissingReason,
  shouldForceTerminalizeSingle,
  deriveResumeStageBeacon,
  reconcileLowQualityToTerminal,
  finalizeReviewsForCompletion,
  forceTerminalizeCompanyDocForSingle,
  applyTerminalOnlyCompletion,
  analyzeMissingFieldsForResume,
  summarizeEnrichmentHealth,
  toSavedCompanies,
  inferReconcileStrategy,
  getHeartbeatTimestamp,
  getJobCreatedTimestamp,
  computePrimaryProgress,
} = require("./_importStatusUtils");

// ── toMs ────────────────────────────────────────────────────────────────────

test("toMs parses valid ISO timestamp", () => {
  assert.equal(toMs("2025-01-01T00:00:00.000Z"), Date.parse("2025-01-01T00:00:00.000Z"));
});

test("toMs returns null for invalid/empty timestamps", () => {
  assert.equal(toMs(""), null);
  assert.equal(toMs(null), null);
  assert.equal(toMs(undefined), null);
  assert.equal(toMs("not-a-date"), null);
});

// ── normalizeKey ────────────────────────────────────────────────────────────

test("normalizeKey lowercases, trims, and collapses spaces", () => {
  assert.equal(normalizeKey("  Hello   World  "), "hello world");
});

test("normalizeKey handles null/undefined", () => {
  assert.equal(normalizeKey(null), "");
  assert.equal(normalizeKey(undefined), "");
});

// ── normalizeDomain ─────────────────────────────────────────────────────────

test("normalizeDomain strips www prefix and lowercases", () => {
  assert.equal(normalizeDomain("WWW.Example.COM"), "example.com");
});

test("normalizeDomain returns empty for empty input", () => {
  assert.equal(normalizeDomain(""), "");
  assert.equal(normalizeDomain(null), "");
});

// ── extractNormalizedDomainFromQuery ─────────────────────────────────────────

test("extractNormalizedDomainFromQuery extracts domain from URL query", () => {
  assert.equal(extractNormalizedDomainFromQuery("https://www.acme.com/about"), "acme.com");
});

test("extractNormalizedDomainFromQuery handles bare domain", () => {
  assert.equal(extractNormalizedDomainFromQuery("acme.com"), "acme.com");
});

test("extractNormalizedDomainFromQuery returns empty for empty/invalid input", () => {
  assert.equal(extractNormalizedDomainFromQuery(""), "");
  assert.equal(extractNormalizedDomainFromQuery(null), "");
});

// ── computeCreatedAfterIso ──────────────────────────────────────────────────

test("computeCreatedAfterIso subtracts minutes from timestamp", () => {
  const result = computeCreatedAfterIso("2025-06-01T00:10:00.000Z", 10);
  assert.equal(result, "2025-06-01T00:00:00.000Z");
});

test("computeCreatedAfterIso returns empty for invalid timestamp", () => {
  assert.equal(computeCreatedAfterIso("", 10), "");
  assert.equal(computeCreatedAfterIso(null, 10), "");
});

test("computeCreatedAfterIso with zero minutes returns same time", () => {
  const result = computeCreatedAfterIso("2025-06-01T12:00:00.000Z", 0);
  assert.equal(result, "2025-06-01T12:00:00.000Z");
});

// ── deriveDomainAndCreatedAfter ─────────────────────────────────────────────

test("deriveDomainAndCreatedAfter extracts domain and computes createdAfter", () => {
  const result = deriveDomainAndCreatedAfter({
    sessionDoc: {
      created_at: "2025-06-01T00:10:00.000Z",
      request: { query: "https://www.acme.com" },
    },
  });
  assert.equal(result.normalizedDomain, "acme.com");
  assert.equal(result.createdAfter, "2025-06-01T00:00:00.000Z");
  assert.equal(result.sessionCreatedAt, "2025-06-01T00:10:00.000Z");
});

test("deriveDomainAndCreatedAfter falls back to acceptDoc created_at", () => {
  const result = deriveDomainAndCreatedAfter({
    sessionDoc: { request: { query: "acme.com" } },
    acceptDoc: { created_at: "2025-06-01T00:20:00.000Z" },
  });
  assert.equal(result.sessionCreatedAt, "2025-06-01T00:20:00.000Z");
});

// ── toPositiveInt ───────────────────────────────────────────────────────────

test("toPositiveInt truncates positive numbers", () => {
  assert.equal(toPositiveInt(3.7, 0), 3);
  assert.equal(toPositiveInt(0, 99), 0);
});

test("toPositiveInt returns fallback for negative/invalid", () => {
  assert.equal(toPositiveInt(-5, 0), 0);
  assert.equal(toPositiveInt("abc", 42), 42);
  assert.equal(toPositiveInt(NaN, 10), 10);
});

// ── normalizeErrorPayload ───────────────────────────────────────────────────

test("normalizeErrorPayload wraps string in object", () => {
  assert.deepEqual(normalizeErrorPayload("oops"), { message: "oops" });
});

test("normalizeErrorPayload passes through objects", () => {
  const err = { message: "fail", code: 500 };
  assert.deepEqual(normalizeErrorPayload(err), err);
});

test("normalizeErrorPayload returns null for falsy", () => {
  assert.equal(normalizeErrorPayload(null), null);
  assert.equal(normalizeErrorPayload(undefined), null);
  assert.equal(normalizeErrorPayload(""), null);
});

// ── computeEffectiveResumeStatus ────────────────────────────────────────────

test("computeEffectiveResumeStatus returns stopped when stopDoc exists", () => {
  const result = computeEffectiveResumeStatus({ stopDoc: { id: "stop" } });
  assert.equal(result.effective_resume_status, "stopped");
});

test("computeEffectiveResumeStatus returns terminal for terminal status", () => {
  const result = computeEffectiveResumeStatus({ resumeDoc: { status: "terminal" } });
  assert.equal(result.effective_resume_status, "terminal");
});

test("computeEffectiveResumeStatus returns terminal for exhausted status", () => {
  const result = computeEffectiveResumeStatus({ resumeDoc: { status: "exhausted" } });
  assert.equal(result.effective_resume_status, "terminal");
});

test("computeEffectiveResumeStatus returns complete for complete status", () => {
  const result = computeEffectiveResumeStatus({ resumeDoc: { status: "complete" } });
  assert.equal(result.effective_resume_status, "complete");
});

test("computeEffectiveResumeStatus returns complete for done status", () => {
  const result = computeEffectiveResumeStatus({ resumeDoc: { status: "done" } });
  assert.equal(result.effective_resume_status, "complete");
});

test("computeEffectiveResumeStatus returns running when lock is active", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const result = computeEffectiveResumeStatus({ resumeDoc: { status: "running", lock_expires_at: future } });
  assert.equal(result.effective_resume_status, "running");
});

test("computeEffectiveResumeStatus returns queued as default", () => {
  const result = computeEffectiveResumeStatus({});
  assert.equal(result.effective_resume_status, "queued");
});

// ── isSingleCompanyModeFromSession ──────────────────────────────────────────

test("isSingleCompanyModeFromSession true for single_company_mode flag", () => {
  assert.equal(isSingleCompanyModeFromSession({ sessionDoc: { single_company_mode: true } }), true);
});

test("isSingleCompanyModeFromSession true for import-one request_kind", () => {
  assert.equal(isSingleCompanyModeFromSession({ sessionDoc: { request_kind: "import-one" } }), true);
});

test("isSingleCompanyModeFromSession true for limit=1", () => {
  assert.equal(isSingleCompanyModeFromSession({ sessionDoc: { request: { limit: 1 } } }), true);
});

test("isSingleCompanyModeFromSession true for savedCount=1", () => {
  assert.equal(isSingleCompanyModeFromSession({ sessionDoc: {}, savedCount: 1 }), true);
});

test("isSingleCompanyModeFromSession true for itemsCount=1", () => {
  assert.equal(isSingleCompanyModeFromSession({ sessionDoc: {}, itemsCount: 1 }), true);
});

test("isSingleCompanyModeFromSession false for multi-company", () => {
  assert.equal(isSingleCompanyModeFromSession({ sessionDoc: {}, savedCount: 5, itemsCount: 5 }), false);
});

// ── isSingleCompanyModeFromSessionWithReason ────────────────────────────────

test("isSingleCompanyModeFromSessionWithReason returns reason for each decision path", () => {
  const r1 = isSingleCompanyModeFromSessionWithReason({ sessionDoc: { single_company_mode: true } });
  assert.equal(r1.decision, true);
  assert.equal(r1.reason, "flag_true");

  const r2 = isSingleCompanyModeFromSessionWithReason({ sessionDoc: { request_kind: "import-one" } });
  assert.equal(r2.decision, true);
  assert.equal(r2.reason, "request_kind_import_one");

  const r3 = isSingleCompanyModeFromSessionWithReason({ sessionDoc: { request: { limit: 1 } } });
  assert.equal(r3.decision, true);
  assert.equal(r3.reason, "limit_one");

  const r4 = isSingleCompanyModeFromSessionWithReason({ sessionDoc: {}, savedCount: 1 });
  assert.equal(r4.decision, true);
  assert.equal(r4.reason, "saved_count_one");

  const r5 = isSingleCompanyModeFromSessionWithReason({ sessionDoc: {}, savedCount: 5, itemsCount: 1 });
  assert.equal(r5.decision, true);
  assert.equal(r5.reason, "items_count_one");

  const r6 = isSingleCompanyModeFromSessionWithReason({ sessionDoc: {}, savedCount: 5, itemsCount: 5 });
  assert.equal(r6.decision, false);
  assert.equal(r6.reason, "fallback_false");
});

// ── hasRecentWorkerProgress ─────────────────────────────────────────────────

test("hasRecentWorkerProgress true when last_finished_at within window", () => {
  const now = Date.now();
  assert.equal(
    hasRecentWorkerProgress({ last_finished_at: new Date(now - 5000).toISOString() }, now, 10_000),
    true,
  );
});

test("hasRecentWorkerProgress false when activity is older than window", () => {
  const now = Date.now();
  assert.equal(
    hasRecentWorkerProgress({ last_finished_at: new Date(now - 60_000).toISOString() }, now, 10_000),
    false,
  );
});

test("hasRecentWorkerProgress false when no timestamps present", () => {
  assert.equal(hasRecentWorkerProgress({}, Date.now(), 10_000), false);
});

// ── isInfraRetryableMissingReason ───────────────────────────────────────────

test("isInfraRetryableMissingReason recognizes known infra reasons", () => {
  assert.equal(isInfraRetryableMissingReason("upstream_unreachable"), true);
  assert.equal(isInfraRetryableMissingReason("upstream_timeout"), true);
  assert.equal(isInfraRetryableMissingReason("missing_xai_config"), true);
});

test("isInfraRetryableMissingReason recognizes upstream_http_ prefix", () => {
  assert.equal(isInfraRetryableMissingReason("upstream_http_500"), true);
  assert.equal(isInfraRetryableMissingReason("upstream_http_429"), true);
});

test("isInfraRetryableMissingReason returns false for non-infra reasons", () => {
  assert.equal(isInfraRetryableMissingReason("not_found"), false);
  assert.equal(isInfraRetryableMissingReason("exhausted"), false);
  assert.equal(isInfraRetryableMissingReason(""), false);
});

// ── shouldForceTerminalizeSingle ────────────────────────────────────────────

test("shouldForceTerminalizeSingle returns false when not single company", () => {
  const result = shouldForceTerminalizeSingle({ single: false, resume_needed: true });
  assert.equal(result.force, false);
});

test("shouldForceTerminalizeSingle returns false when resume not needed", () => {
  const result = shouldForceTerminalizeSingle({ single: true, resume_needed: false });
  assert.equal(result.force, false);
});

test("shouldForceTerminalizeSingle returns false when actively processing", () => {
  const result = shouldForceTerminalizeSingle({
    single: true,
    resume_needed: true,
    actively_processing: true,
    resume_cycle_count: 100,
  });
  assert.equal(result.force, false);
});

test("shouldForceTerminalizeSingle forces at max_cycles", () => {
  const result = shouldForceTerminalizeSingle({
    single: true,
    resume_needed: true,
    resume_cycle_count: 10,
    retryable_missing_count: 0,
  });
  assert.equal(result.force, true);
  assert.equal(result.reason, "max_cycles");
});

test("shouldForceTerminalizeSingle allows more cycles with infra_only_timeout", () => {
  const result = shouldForceTerminalizeSingle({
    single: true,
    resume_needed: true,
    resume_cycle_count: 12,
    infra_only_timeout: true,
    retryable_missing_count: 1,
  });
  assert.equal(result.force, false);
});

// ── deriveResumeStageBeacon ─────────────────────────────────────────────────

test("deriveResumeStageBeacon returns null when no resume needed and not forceComplete", () => {
  assert.equal(deriveResumeStageBeacon({ resume_needed: false, forceComplete: false }), null);
});

test("deriveResumeStageBeacon maps status strings to beacon values", () => {
  assert.equal(deriveResumeStageBeacon({ resume_needed: true, resume_status: "blocked" }), "enrichment_resume_blocked");
  assert.equal(deriveResumeStageBeacon({ resume_needed: true, resume_status: "queued" }), "enrichment_resume_queued");
  assert.equal(deriveResumeStageBeacon({ resume_needed: true, resume_status: "running" }), "enrichment_resume_running");
  assert.equal(deriveResumeStageBeacon({ resume_needed: true, resume_status: "stalled" }), "enrichment_resume_stalled");
  assert.equal(deriveResumeStageBeacon({ resume_needed: true, resume_status: "error" }), "enrichment_resume_error");
});

test("deriveResumeStageBeacon returns incomplete_retryable when retryable count > 0", () => {
  assert.equal(
    deriveResumeStageBeacon({ resume_needed: true, resume_status: "", retryableMissingCount: 3 }),
    "enrichment_incomplete_retryable",
  );
});

test("deriveResumeStageBeacon returns complete as fallback", () => {
  assert.equal(
    deriveResumeStageBeacon({ resume_needed: true, resume_status: "", retryableMissingCount: 0 }),
    "complete",
  );
});

// ── reconcileLowQualityToTerminal ───────────────────────────────────────────

test("reconcileLowQualityToTerminal clears industries=[Unknown]", () => {
  const doc = { industries: ["Unknown"], import_attempts: {}, import_missing_reason: {} };
  const changed = reconcileLowQualityToTerminal(doc);
  assert.equal(changed, true);
  assert.deepEqual(doc.industries, []);
  assert.equal(doc.industries_unknown, true);
});

test("reconcileLowQualityToTerminal clears tagline=Unknown", () => {
  const doc = { tagline: "unknown", import_attempts: {}, import_missing_reason: {} };
  const changed = reconcileLowQualityToTerminal(doc);
  assert.equal(changed, true);
  assert.equal(doc.tagline, "");
  assert.equal(doc.tagline_unknown, true);
});

test("reconcileLowQualityToTerminal clears product_keywords=Unknown", () => {
  const doc = { product_keywords: "Unknown", import_attempts: {}, import_missing_reason: {} };
  const changed = reconcileLowQualityToTerminal(doc);
  assert.equal(changed, true);
  assert.equal(doc.product_keywords, "");
  assert.equal(doc.product_keywords_unknown, true);
});

test("reconcileLowQualityToTerminal promotes low_quality to terminal after max attempts", () => {
  const doc = {
    import_missing_reason: { industries: "low_quality" },
    import_attempts: { industries: 3 },
  };
  const changed = reconcileLowQualityToTerminal(doc, 2);
  assert.equal(changed, true);
  assert.equal(doc.import_missing_reason.industries, "low_quality_terminal");
  assert.deepEqual(doc.industries, []);
});

test("reconcileLowQualityToTerminal does not promote when below max attempts", () => {
  const doc = {
    import_missing_reason: { industries: "low_quality" },
    import_attempts: { industries: 1 },
  };
  const changed = reconcileLowQualityToTerminal(doc, 2);
  assert.equal(changed, false);
});

test("reconcileLowQualityToTerminal returns false for null doc", () => {
  assert.equal(reconcileLowQualityToTerminal(null), false);
});

// ── finalizeReviewsForCompletion ────────────────────────────────────────────

test("finalizeReviewsForCompletion marks doc as incomplete", () => {
  const doc = { reviews_stage_status: "pending" };
  const changed = finalizeReviewsForCompletion(doc);
  assert.equal(changed, true);
  assert.equal(doc.reviews_stage_status, "incomplete");
  assert.equal(doc.review_cursor.exhausted, true);
});

test("finalizeReviewsForCompletion does not change ok status with 4+ reviews", () => {
  const doc = {
    reviews_stage_status: "ok",
    curated_reviews: [{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }],
  };
  const changed = finalizeReviewsForCompletion(doc);
  assert.equal(changed, false);
});

test("finalizeReviewsForCompletion returns false for null doc", () => {
  assert.equal(finalizeReviewsForCompletion(null), false);
});

// ── forceTerminalizeCompanyDocForSingle ──────────────────────────────────────

test("forceTerminalizeCompanyDocForSingle sets all fields to exhausted", () => {
  const doc = forceTerminalizeCompanyDocForSingle({ company_name: "Acme" });
  assert.deepEqual(doc.industries, []);
  assert.equal(doc.industries_unknown, true);
  assert.equal(doc.tagline, "");
  assert.equal(doc.tagline_unknown, true);
  assert.equal(doc.product_keywords, "");
  assert.equal(doc.product_keywords_unknown, true);
  assert.equal(doc.review_cursor.exhausted, true);
  assert.equal(doc.import_missing_reason.industries, "exhausted");
  assert.equal(doc.import_missing_reason.tagline, "exhausted");
  assert.equal(doc.import_missing_reason.reviews, "exhausted");
});

test("forceTerminalizeCompanyDocForSingle marks logo missing when no logo_url", () => {
  const doc = forceTerminalizeCompanyDocForSingle({});
  assert.equal(doc.import_missing_reason.logo, "exhausted");
});

test("forceTerminalizeCompanyDocForSingle skips logo when logo_url exists", () => {
  const doc = forceTerminalizeCompanyDocForSingle({ logo_url: "https://example.com/logo.png" });
  assert.equal(doc.import_missing_reason.logo, undefined);
});

// ── applyTerminalOnlyCompletion ─────────────────────────────────────────────

test("applyTerminalOnlyCompletion marks response as complete terminal-only", () => {
  const out = { ok: false, status: "running", error: "something", resume: {} };
  applyTerminalOnlyCompletion(out, "max_cycles");
  assert.equal(out.ok, true);
  assert.equal(out.completed, true);
  assert.equal(out.terminal_only, true);
  assert.equal(out.status, "complete");
  assert.equal(out.error, null);
  assert.equal(out.resume_needed, false);
  assert.equal(out.stage_beacon, "status_resume_terminal_only");
});

// ── summarizeEnrichmentHealth ───────────────────────────────────────────────

test("summarizeEnrichmentHealth counts complete and incomplete", () => {
  const companies = [
    { enrichment_health: { missing_fields: [] } },
    { enrichment_health: { missing_fields: ["tagline", "industries"] } },
    { enrichment_health: { missing_fields: ["tagline"] } },
  ];
  const result = summarizeEnrichmentHealth(companies);
  assert.equal(result.total, 3);
  assert.equal(result.complete, 1);
  assert.equal(result.incomplete, 2);
  assert.deepEqual(result.missing_counts, { tagline: 2, industries: 1 });
});

test("summarizeEnrichmentHealth handles empty input", () => {
  const result = summarizeEnrichmentHealth([]);
  assert.equal(result.total, 0);
  assert.equal(result.complete, 0);
  assert.equal(result.incomplete, 0);
});

// ── toSavedCompanies ────────────────────────────────────────────────────────

test("toSavedCompanies maps docs to summary objects", () => {
  const docs = [
    { id: "c1", company_name: "Acme", canonical_url: "https://acme.com", website_url: "https://acme.com" },
  ];
  const result = toSavedCompanies(docs);
  assert.equal(result.length, 1);
  assert.equal(result[0].company_id, "c1");
  assert.equal(result[0].company_name, "Acme");
});

test("toSavedCompanies filters out docs without id", () => {
  const docs = [{ company_name: "NoId" }, { id: "c1", company_name: "HasId" }];
  const result = toSavedCompanies(docs);
  assert.equal(result.length, 1);
  assert.equal(result[0].company_id, "c1");
});

test("toSavedCompanies defaults company_name to Unknown company", () => {
  const result = toSavedCompanies([{ id: "c1" }]);
  assert.equal(result[0].company_name, "Unknown company");
});

// ── inferReconcileStrategy ──────────────────────────────────────────────────

test("inferReconcileStrategy returns import_session_id when matched", () => {
  assert.equal(inferReconcileStrategy([{ import_session_id: "s1" }], "s1"), "import_session_id");
});

test("inferReconcileStrategy returns session_id when matched", () => {
  assert.equal(inferReconcileStrategy([{ session_id: "s1" }], "s1"), "session_id");
});

test("inferReconcileStrategy returns created_at_fallback as default", () => {
  assert.equal(inferReconcileStrategy([{ id: "c1" }], "s1"), "created_at_fallback");
});

// ── getHeartbeatTimestamp ───────────────────────────────────────────────────

test("getHeartbeatTimestamp prefers last_heartbeat_at", () => {
  const job = {
    last_heartbeat_at: "2025-06-01T00:00:00.000Z",
    updated_at: "2025-05-01T00:00:00.000Z",
    started_at: "2025-04-01T00:00:00.000Z",
  };
  assert.equal(getHeartbeatTimestamp(job), Date.parse("2025-06-01T00:00:00.000Z"));
});

test("getHeartbeatTimestamp falls back to updated_at then started_at", () => {
  assert.equal(
    getHeartbeatTimestamp({ updated_at: "2025-05-01T00:00:00.000Z" }),
    Date.parse("2025-05-01T00:00:00.000Z"),
  );
  assert.equal(
    getHeartbeatTimestamp({ started_at: "2025-04-01T00:00:00.000Z" }),
    Date.parse("2025-04-01T00:00:00.000Z"),
  );
});

test("getHeartbeatTimestamp returns 0 when no timestamps", () => {
  assert.equal(getHeartbeatTimestamp({}), 0);
});

// ── getJobCreatedTimestamp ───────────────────────────────────────────────────

test("getJobCreatedTimestamp prefers created_at", () => {
  const job = {
    created_at: "2025-06-01T00:00:00.000Z",
    updated_at: "2025-07-01T00:00:00.000Z",
  };
  assert.equal(getJobCreatedTimestamp(job), Date.parse("2025-06-01T00:00:00.000Z"));
});

test("getJobCreatedTimestamp falls back to updated_at then started_at", () => {
  assert.equal(
    getJobCreatedTimestamp({ updated_at: "2025-05-01T00:00:00.000Z" }),
    Date.parse("2025-05-01T00:00:00.000Z"),
  );
});

// ── computePrimaryProgress ──────────────────────────────────────────────────

test("computePrimaryProgress computes elapsed and remaining budget", () => {
  const now = Date.parse("2025-06-01T00:01:00.000Z");
  const job = {
    job_state: "running",
    started_at: "2025-06-01T00:00:00.000Z",
    upstream_calls_made: 5,
    companies_candidates_found: 3,
  };
  const result = computePrimaryProgress(job, now, 300_000);
  assert.equal(result.elapsed_ms, 60_000);
  assert.equal(result.remaining_budget_ms, 240_000);
  assert.equal(result.upstream_calls_made, 5);
  assert.equal(result.companies_candidates_found, 3);
});

test("computePrimaryProgress defaults to queued state", () => {
  const now = Date.now();
  const result = computePrimaryProgress({}, now, 300_000);
  assert.equal(result.elapsed_ms, 0);
  assert.equal(result.remaining_budget_ms, 300_000);
  assert.equal(result.upstream_calls_made, 0);
});
