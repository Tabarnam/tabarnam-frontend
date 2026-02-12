/**
 * Response-shaping helpers extracted from import-status/index.js.
 * No Cosmos DB, no external I/O — only deterministic object construction.
 */

const { EMPTY_RESUME_DIAGNOSTICS, nowIso, MAX_RESUME_CYCLES_SINGLE } = require("./_importStatusUtils");

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

// ── buildReport ─────────────────────────────────────────────────────────────

/**
 * Builds the `report` sub-object included in every status response.
 * Shared between the primary-job path and the Cosmos-backed path.
 *
 * @param {object} opts
 * @param {object|null} opts.sessionDoc
 * @param {object|null} opts.acceptDoc
 * @param {object|null} opts.completionDoc
 * @param {object|null} opts.resumeDoc
 * @param {*}           [opts.completionSaved]          - Primary path: pre-computed saved count
 * @param {Array|null}  [opts.completionSavedIds]       - Primary path: pre-computed saved IDs
 * @param {string|null} [opts.completionReason]         - Cosmos path: override reason string
 * @param {Array|null}  [opts.savedIds]                 - Cosmos path: saved IDs from reconciliation
 * @param {boolean}     [opts.includeRequest=false]     - Include session.request (primary path only)
 * @param {boolean}     [opts.includeSkippedDuplicates=false] - Include completion.skipped_duplicates
 * @returns {object}
 */
function buildReport({
  sessionDoc,
  acceptDoc,
  completionDoc,
  resumeDoc,
  completionSaved,
  completionSavedIds,
  completionReason,
  savedIds,
  includeRequest = false,
  includeSkippedDuplicates = false,
}) {
  const sessionSub = sessionDoc
    ? {
        created_at: sessionDoc.created_at || null,
        request_id: sessionDoc.request_id || null,
        status: sessionDoc.status || null,
        stage_beacon: sessionDoc.stage_beacon || null,
        resume_needed: Boolean(sessionDoc.resume_needed),
        ...(includeRequest
          ? { request: sessionDoc.request && typeof sessionDoc.request === "object" ? sessionDoc.request : null }
          : {}),
      }
    : null;

  const acceptSub = acceptDoc
    ? {
        accepted_at: acceptDoc.accepted_at || acceptDoc.created_at || null,
        reason: acceptDoc.reason || null,
        stage_beacon: acceptDoc.stage_beacon || null,
        remaining_ms: Number.isFinite(Number(acceptDoc.remaining_ms)) ? Number(acceptDoc.remaining_ms) : null,
      }
    : null;

  let completionSub = null;
  if (completionDoc) {
    completionSub = {
      completed_at: completionDoc.completed_at || completionDoc.created_at || null,
      reason: completionReason !== undefined ? (completionReason || null) : (completionDoc.reason || null),
      saved: completionSaved !== undefined ? completionSaved : (typeof completionDoc.saved === "number" ? completionDoc.saved : null),
      skipped: typeof completionDoc.skipped === "number" ? completionDoc.skipped : null,
      failed: typeof completionDoc.failed === "number" ? completionDoc.failed : null,
      saved_ids: savedIds !== undefined ? savedIds : (completionSavedIds !== undefined ? completionSavedIds : []),
      skipped_ids: Array.isArray(completionDoc.skipped_ids) ? completionDoc.skipped_ids : [],
      ...(includeSkippedDuplicates
        ? { skipped_duplicates: Array.isArray(completionDoc.skipped_duplicates) ? completionDoc.skipped_duplicates : [] }
        : {}),
      failed_items: Array.isArray(completionDoc.failed_items) ? completionDoc.failed_items : [],
    };
  }

  const resumeSub = resumeDoc
    ? {
        status: resumeDoc.status || null,
        attempt: Number.isFinite(Number(resumeDoc.attempt)) ? Number(resumeDoc.attempt) : 0,
        lock_expires_at: resumeDoc.lock_expires_at || null,
        updated_at: resumeDoc.updated_at || null,
      }
    : null;

  return {
    session: sessionSub,
    accepted: Boolean(acceptDoc),
    accept: acceptSub,
    completion: completionSub,
    resume: resumeSub,
  };
}

// ── buildCosmosResponseBase ──────────────────────────────────────────────────

/**
 * Builds the common response fields shared by the three Cosmos-backed status
 * paths (error / complete / running). Callers spread variant-specific overrides
 * on top of the returned object.
 *
 * @param {object} opts
 * @param {string}      opts.sessionId
 * @param {string}      opts.status            - "error" | "complete" | "running"
 * @param {string}      opts.state             - "failed" | "complete" | "running"
 * @param {string}      opts.stage_beacon
 * @param {object}      opts.stageBeaconValues
 * @param {object|null} opts.cosmosTarget
 * @param {object|null} opts.sessionDoc
 * @param {object|null} opts.resumeDoc
 * @param {number}      opts.saved
 * @param {number}      opts.saved_verified_count
 * @param {Array}       opts.saved_company_ids_verified
 * @param {Array}       opts.saved_company_ids_unverified
 * @param {Array}       opts.saved_company_urls
 * @param {string|null} opts.save_outcome
 * @param {string|null} opts.resume_error
 * @param {object|null} opts.resume_error_details
 * @param {boolean}     opts.reconciled
 * @param {string|null} opts.reconcile_strategy
 * @param {Array|null}  opts.reconciled_saved_ids
 * @param {Array}       opts.saved_companies
 * @param {string|null} opts.effective_resume_status
 * @param {string|null} opts.progress_notice
 * @param {boolean}     opts.resume_needed
 * @param {string|null} opts.resume_status
 * @param {object|null} opts.report
 * @param {boolean}     opts.resume_doc_created
 * @param {boolean}     opts.resume_triggered
 * @param {string|null} opts.resume_trigger_error
 * @param {object|null} opts.resume_trigger_error_details
 * @param {boolean}     opts.resume_gateway_key_attached
 * @param {string|null} opts.resume_trigger_request_id
 * @param {boolean}     opts.internalAuthConfigured
 * @param {Function}    opts.buildResumeAuthDiagnostics
 * @param {Array|null}  opts.missing_by_company
 * @param {object|null} opts.enrichment_health_summary
 * @param {Array}       opts.items
 * @param {string|null} opts.lastCreatedAt
 * @returns {object}
 */
function buildCosmosResponseBase({
  sessionId,
  status,
  state,
  stage_beacon,
  stageBeaconValues,
  cosmosTarget,
  sessionDoc,
  resumeDoc,
  saved,
  saved_verified_count,
  saved_company_ids_verified,
  saved_company_ids_unverified,
  saved_company_urls,
  save_outcome,
  resume_error,
  resume_error_details,
  reconciled,
  reconcile_strategy,
  reconciled_saved_ids,
  saved_companies,
  effective_resume_status,
  progress_notice,
  resume_needed,
  resume_status,
  report,
  resume_doc_created,
  resume_triggered,
  resume_trigger_error,
  resume_trigger_error_details,
  resume_gateway_key_attached,
  resume_trigger_request_id,
  internalAuthConfigured,
  buildResumeAuthDiagnostics,
  missing_by_company,
  enrichment_health_summary,
  items,
  lastCreatedAt,
}) {
  const sd = sessionDoc || null;
  const rd = resumeDoc || null;
  const hasSd = typeof sessionDoc !== "undefined" && sd && typeof sd === "object";

  return {
    ok: true,
    session_id: sessionId,
    status,
    state,
    job_state: null,
    stage_beacon,
    stage_beacon_values: stageBeaconValues,
    ...(cosmosTarget ? cosmosTarget : {}),
    primary_job_state: null,
    elapsed_ms: null,
    remaining_budget_ms: null,
    upstream_calls_made: Math.max(
      hasSd && Number.isFinite(Number(sd.resume_worker_upstream_calls_made))
        ? Number(sd.resume_worker_upstream_calls_made)
        : 0,
      rd && Number.isFinite(Number(rd.upstream_calls_made))
        ? Number(rd.upstream_calls_made)
        : 0
    ),
    companies_candidates_found: 0,
    early_exit_triggered: false,
    last_heartbeat_at: null,
    lock_until: null,
    attempts: 0,
    last_error: null,
    companies_count: saved,
    items,
    saved,
    saved_verified_count,
    saved_company_ids_verified,
    saved_company_ids_unverified,
    saved_company_urls,
    save_outcome,
    resume_error,
    resume_error_details,
    enrichment_last_write_error: hasSd ? sd.enrichment_last_write_error || null : null,
    reconciled,
    reconcile_strategy,
    reconciled_saved_ids,
    saved_companies,
    effective_resume_status,
    ...(progress_notice ? { progress_notice } : {}),
    resume_needed,
    resume_cycle_count: hasSd ? Number(sd.resume_cycle_count || 0) || 0 : 0,
    resume_last_triggered_at: hasSd
      ? sd.resume_last_triggered_at || sd.resume_worker_last_triggered_at || null
      : null,
    max_resume_cycles_single: MAX_RESUME_CYCLES_SINGLE,
    resume: {
      needed: resume_needed,
      status: resume_status || null,
      doc_created: Boolean(report?.resume) || resume_doc_created,
      triggered: resume_triggered,
      trigger_error: resume_trigger_error,
      trigger_error_details: resume_trigger_error_details,
      gateway_key_attached: Boolean(resume_gateway_key_attached),
      trigger_request_id: resume_trigger_request_id || null,
      internal_auth_configured: Boolean(internalAuthConfigured),
      cycle_count:
        typeof rd?.cycle_count === "number" && Number.isFinite(Number(rd.cycle_count))
          ? Number(rd.cycle_count)
          : hasSd
            ? Number(sd.resume_cycle_count || 0) || 0
            : null,
      max_cycles_single: MAX_RESUME_CYCLES_SINGLE,
      max_resume_cycles_single: MAX_RESUME_CYCLES_SINGLE,
      last_triggered_at: hasSd
        ? sd.resume_last_triggered_at || sd.resume_worker_last_triggered_at || null
        : null,
      next_allowed_run_at:
        (typeof rd?.next_allowed_run_at === "string" && rd.next_allowed_run_at.trim())
          ? rd.next_allowed_run_at.trim()
          : (typeof sd?.resume_next_allowed_run_at === "string" && sd.resume_next_allowed_run_at.trim())
            ? sd.resume_next_allowed_run_at.trim()
            : null,
      ...buildResumeAuthDiagnostics(),
      missing_by_company,
    },
    resume_worker: buildResumeWorkerMeta({ sessionDoc, resumeDoc }),
    enrichment_health_summary,
    lastCreatedAt,
    report,
  };
}

// ── applyCompletionOverride ─────────────────────────────────────────────────

/**
 * Mutates the response object to force completion when a completion-doc
 * override is active (e.g. `completionDoc.completed_at` is set).
 *
 * @param {object} out - Mutable response payload
 */
function applyCompletionOverride(out) {
  out.completed = true;
  out.terminal_only = true;
  out.status = "complete";
  out.state = "complete";
  out.resume_needed = false;
  out.resume = out.resume && typeof out.resume === "object" ? out.resume : {};
  out.resume.needed = false;
  out.resume.status = "done";
  out.effective_resume_status = "done";
}

// ── deduplicatePersistedIds ─────────────────────────────────────────────────

/**
 * Case-insensitive deduplication of company IDs, preserving the original casing
 * of the last occurrence.
 *
 * @param {Array} verifiedIds
 * @param {Array} unverifiedIds
 * @returns {string[]}
 */
function deduplicatePersistedIds(verifiedIds, unverifiedIds) {
  return Array.from(
    new Map(
      [...verifiedIds, ...unverifiedIds]
        .filter(Boolean)
        .map(String)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => [s.toLowerCase(), s])
    ).values()
  );
}

module.exports = {
  buildResumeWorkerMeta,
  buildMemoryOnlyResponse,
  buildPrimaryJobNoCosmosResponse,
  buildReport,
  buildCosmosResponseBase,
  applyCompletionOverride,
  deduplicatePersistedIds,
};
