/**
 * Response-shaping helpers extracted from import-status/index.js.
 * No Cosmos DB, no external I/O — only deterministic object construction.
 */

const { EMPTY_RESUME_DIAGNOSTICS, nowIso } = require("./_importStatusUtils");

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Safe numeric coercion: returns the number if finite, else the fallback.
 */
function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ── buildResumeWorkerMeta ────────────────────────────────────────────────────

/**
 * Builds the `resume_worker` diagnostic object that surfaces resume-worker
 * telemetry from sessionDoc and/or resumeDoc.
 *
 * @param {object} opts
 * @param {object|null} opts.sessionDoc
 * @param {object|null} opts.resumeDoc
 * @returns {object|null}
 */
function buildResumeWorkerMeta({ sessionDoc, resumeDoc }) {
  if (!sessionDoc && !resumeDoc) return null;

  const sd = sessionDoc || {};
  const rd = resumeDoc || {};

  const boolOr = (a, b) =>
    typeof a === "boolean" ? a : typeof b === "boolean" ? b : null;

  const numOr = (a, b) =>
    typeof a === "number" ? a : typeof b === "number" ? b : null;

  // Telemetry missing-fields analysis
  const missingAnalysis = (() => {
    const missing_fields = [];
    const session_missing_fields = [];
    const resume_missing_fields = [];

    const check = (field, sessionHas, resumeHas) => {
      if (!sessionHas) session_missing_fields.push(field);
      if (!resumeHas) resume_missing_fields.push(field);
      if (!sessionHas && !resumeHas) missing_fields.push(field);
    };

    check(
      "attempted_fields",
      Array.isArray(sd.resume_worker_attempted_fields),
      Array.isArray(rd.attempted_fields)
    );

    check(
      "last_written_fields",
      Array.isArray(sd.resume_worker_last_written_fields),
      Array.isArray(rd.last_written_fields)
    );

    check(
      "last_xai_attempt_at",
      Boolean(sd.resume_worker_last_xai_attempt_at || sd.last_xai_attempt_at),
      Boolean(rd.last_xai_attempt_at)
    );

    check(
      "next_allowed_run_at",
      Boolean(sd.resume_next_allowed_run_at),
      Boolean(rd.next_allowed_run_at)
    );

    return {
      telemetry_missing: missing_fields.length > 0,
      telemetry_missing_fields: missing_fields,
      telemetry_missing_session_fields: session_missing_fields,
      telemetry_missing_resume_fields: resume_missing_fields,
    };
  })();

  return {
    last_invoked_at: sd.resume_worker_last_invoked_at || rd.last_invoked_at || null,
    handler_entered_at: sd.resume_worker_handler_entered_at || rd.handler_entered_at || null,
    handler_entered_build_id: sd.resume_worker_handler_entered_build_id || rd.handler_entered_build_id || null,
    last_reject_layer: sd.resume_worker_last_reject_layer || rd.last_reject_layer || null,
    last_auth: sd.resume_worker_last_auth || rd.last_auth || null,
    last_finished_at: sd.resume_worker_last_finished_at || rd.last_finished_at || null,
    last_result: sd.resume_worker_last_result || rd.last_result || null,
    last_enqueued_at: sd.resume_worker_last_enqueued_at || null,
    last_enqueue_reason: sd.resume_worker_last_enqueue_reason || null,
    last_enqueue_ok: typeof sd.resume_worker_last_enqueue_ok === "boolean" ? sd.resume_worker_last_enqueue_ok : null,
    last_enqueue_error: sd.resume_worker_last_enqueue_error || null,
    last_enqueue_queue: sd.resume_worker_last_enqueue_queue || null,
    last_xai_attempt_at:
      sd.resume_worker_last_xai_attempt_at || rd.last_xai_attempt_at || sd.last_xai_attempt_at || null,
    last_ok: boolOr(sd.resume_worker_last_ok, rd.last_ok),
    last_http_status: numOr(sd.resume_worker_last_http_status, rd.last_http_status),
    last_trigger_request_id: sd.resume_worker_last_trigger_request_id || rd.last_trigger_request_id || null,
    last_trigger_result: sd.resume_worker_last_trigger_result || rd.last_trigger_result || null,
    last_trigger_ok: boolOr(sd.resume_worker_last_trigger_ok, rd.last_trigger_ok),
    last_trigger_http_status: numOr(sd.resume_worker_last_trigger_http_status, rd.last_trigger_http_status),
    last_gateway_key_attached: boolOr(sd.resume_worker_last_gateway_key_attached, rd.last_gateway_key_attached),
    last_error: sd.resume_worker_last_error || rd.last_error || null,
    last_company_id: sd.resume_worker_last_company_id || rd.last_company_id || null,
    last_written_fields: Array.isArray(sd.resume_worker_last_written_fields)
      ? sd.resume_worker_last_written_fields
      : Array.isArray(rd.last_written_fields)
        ? rd.last_written_fields
        : null,
    last_stage_beacon: sd.resume_worker_last_stage_beacon || rd.last_stage_beacon || null,
    last_resume_needed: boolOr(sd.resume_worker_last_resume_needed, rd.last_resume_needed),
    planned_fields: Array.isArray(sd.resume_worker_planned_fields)
      ? sd.resume_worker_planned_fields
      : Array.isArray(rd.planned_fields)
        ? rd.planned_fields
        : null,
    planned_fields_reason: sd.resume_worker_planned_fields_reason || rd.planned_fields_reason || null,
    attempted_fields: Array.isArray(sd.resume_worker_attempted_fields)
      ? sd.resume_worker_attempted_fields
      : Array.isArray(rd.attempted_fields)
        ? rd.attempted_fields
        : null,
    attempted_fields_request_id: sd.resume_worker_attempted_fields_request_id || rd.attempted_fields_request_id || null,
    last_field_attempted: sd.resume_worker_last_field_attempted || rd.last_field_attempted || null,
    last_field_result: sd.resume_worker_last_field_result || rd.last_field_result || null,
    // Current enrichment status for real-time UI display
    current_field: sd.resume_worker_current_field || null,
    current_company: sd.resume_worker_current_company || null,
    ...missingAnalysis,
    // Budget diagnostics for debugging deferred fields
    _budget_debug: sd.resume_worker_budget_debug || rd._budget_debug || null,
  };
}

// ── buildMemoryOnlyResponse ──────────────────────────────────────────────────

/**
 * Builds the response payload when only in-memory session data is available
 * (no Cosmos connection or no CosmosClient module).
 *
 * @param {object} opts
 * @param {string}        opts.sessionId
 * @param {object}        opts.mem              - In-memory session data
 * @param {object}        opts.stageBeaconValues
 * @param {boolean}       opts.gatewayKeyConfigured
 * @param {boolean}       opts.internalAuthConfigured
 * @param {Function}      opts.buildResumeStallError
 * @param {Function}      opts.buildResumeAuthDiagnostics
 * @param {object|null}   opts.sessionDoc       - May be undefined/null in this path
 * @param {object|null}   opts.resumeDoc        - May be undefined/null in this path
 * @returns {object}      Response payload (not yet wrapped in json())
 */
function buildMemoryOnlyResponse({
  sessionId,
  mem,
  stageBeaconValues,
  gatewayKeyConfigured,
  internalAuthConfigured,
  buildResumeStallError,
  buildResumeAuthDiagnostics,
  sessionDoc,
  resumeDoc,
}) {
  const memCompaniesCount = safeNum(mem.companies_count);
  const memVerifiedIds = Array.isArray(mem.saved_company_ids_verified) ? mem.saved_company_ids_verified : [];
  const memVerifiedCount = safeNum(mem.saved_verified_count, memVerifiedIds.length);

  const saved_verified_count = memVerifiedCount;
  const saved_company_ids_verified = memVerifiedIds;
  const saved_company_ids_unverified = Array.isArray(mem.saved_company_ids_unverified) ? mem.saved_company_ids_unverified : [];
  const saved_company_urls = Array.isArray(mem.saved_company_urls) ? mem.saved_company_urls : [];
  const save_outcome = typeof mem.save_outcome === "string" && mem.save_outcome.trim() ? mem.save_outcome.trim() : null;
  const resume_needed = typeof mem.resume_needed === "boolean" ? mem.resume_needed : false;
  const resume_error = typeof mem.resume_error === "string" && mem.resume_error.trim() ? mem.resume_error.trim() : null;
  const resume_error_details =
    mem.resume_error_details && typeof mem.resume_error_details === "object" ? mem.resume_error_details : null;

  const saved = safeNum(mem.saved, saved_verified_count);

  const stallResumeError = resume_needed && !gatewayKeyConfigured;
  const stallError = stallResumeError ? buildResumeStallError() : null;
  const stallDetails = stallResumeError
    ? {
        root_cause: stallError.root_cause,
        http_status: 401,
        message: stallError.message,
        missing_gateway_key: Boolean(stallError.missing_gateway_key),
        missing_internal_secret: Boolean(stallError.missing_internal_secret),
        ...buildResumeAuthDiagnostics(),
        updated_at: nowIso(),
      }
    : null;

  return {
    ok: true,
    session_id: sessionId,
    status: mem.status || "running",
    state: mem.status === "complete" ? "complete" : mem.status === "failed" ? "failed" : "running",
    job_state: null,
    stage_beacon: mem.stage_beacon || "init",
    stage_beacon_values: stageBeaconValues,
    elapsed_ms: null,
    remaining_budget_ms: null,
    upstream_calls_made: Math.max(
      sessionDoc && Number.isFinite(Number(sessionDoc?.resume_worker_upstream_calls_made))
        ? Number(sessionDoc.resume_worker_upstream_calls_made)
        : 0,
      resumeDoc && Number.isFinite(Number(resumeDoc?.upstream_calls_made))
        ? Number(resumeDoc.upstream_calls_made)
        : 0
    ),
    companies_candidates_found: 0,
    early_exit_triggered: false,
    primary_job_state: null,
    last_heartbeat_at: null,
    lock_until: null,
    attempts: 0,
    last_error: null,
    companies_count: memCompaniesCount,
    saved,
    saved_verified_count,
    saved_company_ids_verified,
    saved_company_ids_unverified,
    saved_company_urls,
    save_outcome,
    ...EMPTY_RESUME_DIAGNOSTICS,
    resume_needed,
    resume_error: stallResumeError ? stallError.code : resume_error,
    resume_error_details: stallResumeError ? stallDetails : resume_error_details,
    resume: {
      ...EMPTY_RESUME_DIAGNOSTICS.resume,
      needed: resume_needed,
      status: stallResumeError ? "stalled" : null,
      trigger_error: stallResumeError ? stallError.code : resume_error,
      trigger_error_details: stallResumeError ? stallDetails : resume_error_details,
      internal_auth_configured: Boolean(internalAuthConfigured),
      ...buildResumeAuthDiagnostics(),
    },
    resume_worker: {
      ...EMPTY_RESUME_DIAGNOSTICS.resume_worker,
      last_reject_layer: stallResumeError ? "gateway" : null,
      last_http_status: stallResumeError ? 401 : null,
    },
    saved_companies: [],
  };
}

// ── buildPrimaryJobNoCosmosResponse ──────────────────────────────────────────

/**
 * Builds the response payload when a primary job exists but Cosmos is
 * unavailable (no config or no SDK module).
 *
 * @param {object} opts
 * @param {string}  opts.sessionId
 * @param {object}  opts.primaryJob
 * @param {object}  opts.stageBeaconValues
 * @returns {object} Response payload (not yet wrapped in json())
 */
function buildPrimaryJobNoCosmosResponse({ sessionId, primaryJob, stageBeaconValues }) {
  const jobState = String(primaryJob.job_state || "queued");
  const status = jobState === "error" ? "error" : jobState === "complete" ? "complete" : jobState === "running" ? "running" : "queued";
  const state = status === "error" ? "failed" : status === "complete" ? "complete" : "running";

  return {
    ok: true,
    session_id: sessionId,
    status,
    state,
    stage_beacon:
      typeof primaryJob.stage_beacon === "string" && primaryJob.stage_beacon.trim()
        ? primaryJob.stage_beacon.trim()
        : status === "complete"
          ? "primary_complete"
          : "primary_search_started",
    stage_beacon_values: stageBeaconValues,
    primary_job_state: jobState,
    last_heartbeat_at: primaryJob?.last_heartbeat_at || null,
    lock_until: primaryJob?.lock_expires_at || null,
    attempts: safeNum(primaryJob?.attempt),
    last_error: primaryJob?.last_error || null,
    elapsed_ms: safeNum(primaryJob?.elapsed_ms, null),
    remaining_budget_ms: safeNum(primaryJob?.remaining_budget_ms, null),
    upstream_calls_made: safeNum(primaryJob?.upstream_calls_made),
    companies_candidates_found: safeNum(
      primaryJob?.companies_candidates_found,
      safeNum(primaryJob?.companies_count)
    ),
    early_exit_triggered: Boolean(primaryJob?.early_exit_triggered),
    companies_count: safeNum(primaryJob.companies_count),
    items: Array.isArray(primaryJob.companies) ? primaryJob.companies : [],
    ...EMPTY_RESUME_DIAGNOSTICS,
    resume_needed: false,
    resume_error: null,
    resume_error_details: null,
    resume: {
      ...EMPTY_RESUME_DIAGNOSTICS.resume,
      needed: false,
    },
    resume_worker: EMPTY_RESUME_DIAGNOSTICS.resume_worker,
    primary_job: {
      id: primaryJob.id || null,
      job_state: jobState,
      attempt: safeNum(primaryJob.attempt),
      attempts: safeNum(primaryJob.attempt),
      last_error: primaryJob.last_error || null,
      elapsed_ms: safeNum(primaryJob?.elapsed_ms, null),
      remaining_budget_ms: safeNum(primaryJob?.remaining_budget_ms, null),
      upstream_calls_made: safeNum(primaryJob?.upstream_calls_made),
      companies_candidates_found: safeNum(
        primaryJob?.companies_candidates_found,
        safeNum(primaryJob?.companies_count)
      ),
      early_exit_triggered: Boolean(primaryJob?.early_exit_triggered),
      last_heartbeat_at: primaryJob?.last_heartbeat_at || null,
      lock_expires_at: primaryJob?.lock_expires_at || null,
      locked_by: primaryJob?.locked_by || null,
      etag: primaryJob?._etag || primaryJob?.etag || null,
      storage: primaryJob.storage || null,
    },
    inline_budget_ms: safeNum(primaryJob.inline_budget_ms, 20_000),
    requested_deadline_ms:
      primaryJob.requested_deadline_ms === null || primaryJob.requested_deadline_ms === undefined
        ? null
        : safeNum(primaryJob.requested_deadline_ms, null),
    requested_stage_ms_primary:
      primaryJob.requested_stage_ms_primary === null || primaryJob.requested_stage_ms_primary === undefined
        ? null
        : safeNum(primaryJob.requested_stage_ms_primary, null),
    note:
      typeof primaryJob.note === "string" && primaryJob.note.trim()
        ? primaryJob.note.trim()
        : "start endpoint is inline capped; long primary runs async",
  };
}

module.exports = {
  buildResumeWorkerMeta,
  buildMemoryOnlyResponse,
  buildPrimaryJobNoCosmosResponse,
};
