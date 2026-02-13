/**
 * Resume orchestration logic extracted from import-status/index.js.
 * Handles blocked-state auto-retry, watchdog detection, single-company
 * termination policy, and resume-worker trigger execution.
 * Contains Cosmos I/O and worker invocations.
 */

const { buildInternalFetchRequest } = require("../_internalJobAuth");
const { invokeResumeWorkerInProcess } = require("../import/resume-worker/handler");
const {
  nowIso,
  normalizeKey,
  hasRecentWorkerProgress,
  isSingleCompanyModeFromSessionWithReason,
  collectInfraRetryableMissing,
  shouldForceTerminalizeSingle,
  MAX_RESUME_CYCLES_SINGLE,
  MAX_RESUME_CYCLES_SINGLE_TIMEOUT_ONLY,
} = require("./_importStatusUtils");
const { readControlDoc, upsertDoc, STATUS_NO_ORCHESTRATION } = require("./_importStatusCosmos");

const INLINE_RESUME_DEADLINE_MS = 300_000; // 5 min — enough for 1 fresh reviews XAI call

// ── runBlockedStateAutoRetry ─────────────────────────────────────────────────

/**
 * Checks if a `resume_no_progress_no_attempts` blocked state can be
 * auto-unblocked based on planner evidence or recent worker activity.
 *
 * @param {object} ctx          Mutable orchestration context
 * @param {object} opts
 * @param {object|null} opts.currentResume
 * @param {object|null} opts.resumeDoc
 */
async function runBlockedStateAutoRetry(ctx, { currentResume, resumeDoc }) {
  if (ctx.forceResume || ctx.resumeStatus !== "blocked") return;

  const activeResume = currentResume != null ? currentResume : resumeDoc;
  const resumeErr = normalizeKey(activeResume?.resume_error || "");

  if (resumeErr === "resume_no_progress_no_attempts") {
    const stuckWindowMs = Number.isFinite(Number(process.env.RESUME_STUCK_QUEUED_MS))
      ? Math.max(30_000, Math.trunc(Number(process.env.RESUME_STUCK_QUEUED_MS)))
      : 180_000;

    const plannedReason = normalizeKey(
      activeResume?.planned_fields_reason ||
        activeResume?.last_trigger_result?.planned_fields_reason ||
        activeResume?.resume_error_details?.planned_fields_reason ||
        ""
    );

    const plannerSkipped =
      plannedReason === "planner_skipped_due_to_budget" ||
      plannedReason === "planner_skipped_due_to_deadline" ||
      plannedReason === "planner_no_actionable_fields";

    const sessionDocForUnblock = await readControlDoc(ctx.container, `_import_session_${ctx.sessionId}`, ctx.sessionId).catch(() => null);

    const evidence = {
      handler_entered_at:
        activeResume?.handler_entered_at ||
        sessionDocForUnblock?.resume_worker_handler_entered_at ||
        sessionDocForUnblock?.resume_worker_last_trigger_result?.response?.handler_entered_at ||
        null,
      last_finished_at: activeResume?.last_finished_at || sessionDocForUnblock?.resume_worker_last_finished_at || null,
    };

    const hasRecentEntry = hasRecentWorkerProgress(evidence, Date.now(), stuckWindowMs);
    const hasAnyEvidence = Boolean(evidence.handler_entered_at || evidence.last_finished_at);

    if ((hasAnyEvidence && hasRecentEntry) || plannerSkipped) {
      const unblockedAt = nowIso();
      ctx.stageBeaconValues.status_resume_unblocked_planner_no_action = unblockedAt;

      if (activeResume && typeof activeResume === "object") {
        await upsertDoc(ctx.container, {
          ...activeResume,
          status: "queued",
          resume_error: null,
          resume_error_details: null,
          blocked_at: null,
          blocked_reason: null,
          last_error: null,
          lock_expires_at: null,
          updated_at: unblockedAt,
        }).catch(() => null);
      }

      if (sessionDocForUnblock && typeof sessionDocForUnblock === "object") {
        await upsertDoc(ctx.container, {
          ...sessionDocForUnblock,
          resume_error: null,
          resume_error_details: null,
          status: sessionDocForUnblock?.status === "complete" ? "running" : (sessionDocForUnblock?.status || "running"),
          updated_at: unblockedAt,
        }).catch(() => null);
      }

      ctx.resumeStatus = "queued";
      ctx.resume_status = "queued";
    } else {
      ctx.stageBeaconValues.status_resume_blocked_auto_retry = nowIso();
    }
  } else {
    ctx.stageBeaconValues.status_resume_blocked_auto_retry = nowIso();
  }
}

// ── runWatchdogStuckDetection ────────────────────────────────────────────────

/**
 * Detects stuck-queued state, fires watchdog markers, applies cooldown.
 *
 * @param {object} ctx          Mutable orchestration context
 * @param {object} [opts]       Optional overrides
 * @param {object|null} [opts.sessionDoc]  If provided, watchdog writes propagate to this object (Cosmos path)
 * @returns {{ watchdog_stuck_queued: boolean, watchdog_last_finished_at: string|null, resumeStuckQueuedMs: number }}
 */
async function runWatchdogStuckDetection(ctx, opts) {
  const sessionDoc = opts?.sessionDoc || null;

  const resumeStuckQueuedMs = Number.isFinite(Number(process.env.RESUME_STUCK_QUEUED_MS))
    ? Math.max(30_000, Math.trunc(Number(process.env.RESUME_STUCK_QUEUED_MS)))
    : 180_000;

  let watchdog_stuck_queued = false;
  let watchdog_last_finished_at = null;

  try {
    const sessionDocId = `_import_session_${ctx.sessionId}`;
    const sessionDocForWatchdog = await readControlDoc(ctx.container, sessionDocId, ctx.sessionId).catch(() => null);
    watchdog_last_finished_at = sessionDocForWatchdog?.resume_worker_last_finished_at || null;

    const prevWatchdogAt =
      typeof sessionDocForWatchdog?.resume_worker_watchdog_stuck_queued_at === "string"
        ? sessionDocForWatchdog.resume_worker_watchdog_stuck_queued_at
        : null;

    const prevWatchdogTs = Date.parse(String(prevWatchdogAt || "")) || 0;
    const lastEnteredAt = sessionDocForWatchdog?.resume_worker_handler_entered_at || null;
    const lastEnteredTs = Date.parse(String(lastEnteredAt || "")) || 0;

    // Second-stage watchdog: if watchdog fired at time T, the very next status poll must observe a handler re-entry.
    if (prevWatchdogTs && ctx.resume_needed && ctx.resumeStatus === "queued" && (!lastEnteredTs || lastEnteredTs < prevWatchdogTs)) {
      const blockedAt = nowIso();
      ctx.stageBeaconValues.status_resume_watchdog_stuck_queued_no_progress = blockedAt;

      const errorCode = "resume_worker_stuck_queued_no_progress";
      const details = {
        forced_by: "watchdog_no_progress",
        blocked_reason: "watchdog_no_progress",
        blocked_code: errorCode,
        blocked_at: blockedAt,
        watchdog_fired_at: prevWatchdogAt,
        last_entered_at: lastEnteredAt,
        last_finished_at: watchdog_last_finished_at,
        last_trigger_result: sessionDocForWatchdog?.resume_worker_last_trigger_result || null,
        updated_at: blockedAt,
      };

      // Auto-retry policy: watchdog is a diagnostic, not a terminal dead-end.
      ctx.resume_error = errorCode;
      ctx.resume_error_details = details;

      // Cosmos path: also propagate to trigger error and sessionDoc
      if (sessionDoc) {
        ctx.resume_trigger_error = ctx.resume_trigger_error || errorCode;
        ctx.resume_trigger_error_details = ctx.resume_trigger_error_details || details;
        if (typeof sessionDoc === "object") {
          sessionDoc.resume_error = errorCode;
          sessionDoc.resume_error_details = details;
        }
      }

      ctx.stageBeaconValues.status_resume_watchdog_retry_at = blockedAt;
    } else if (
      prevWatchdogTs &&
      lastEnteredTs &&
      lastEnteredTs >= prevWatchdogTs &&
      sessionDocForWatchdog &&
      typeof sessionDocForWatchdog === "object"
    ) {
      // Worker re-entered after the watchdog fired; clear marker so it can fire again if needed.
      await upsertDoc(ctx.container, {
        ...sessionDocForWatchdog,
        resume_worker_watchdog_stuck_queued_at: null,
        resume_worker_watchdog_resolved_at: nowIso(),
        updated_at: nowIso(),
      }).catch(() => null);
    }

    const lastFinishedTs = Date.parse(String(watchdog_last_finished_at || "")) || 0;

    if (ctx.resume_needed && ctx.resumeStatus === "queued" && lastFinishedTs && Date.now() - lastFinishedTs > resumeStuckQueuedMs) {
      watchdog_stuck_queued = true;
      const watchdogFiredAt = nowIso();
      ctx.stageBeaconValues.status_resume_watchdog_stuck_queued = watchdogFiredAt;

      if (sessionDocForWatchdog && typeof sessionDocForWatchdog === "object") {
        await upsertDoc(ctx.container, {
          ...sessionDocForWatchdog,
          resume_worker_watchdog_stuck_queued_at: watchdogFiredAt,
          resume_worker_watchdog_last_finished_at: watchdog_last_finished_at,
          updated_at: nowIso(),
        }).catch(() => null);
      }
    }
  } catch {}

  // Cooldown: prevent trigger spam when status is polled repeatedly.
  if (ctx.canTrigger && (ctx.resumeStatus === "queued" || ctx.resumeStatus === "blocked") && !ctx.forceResume) {
    const cooldownMs = 60_000;
    let lastTriggeredTs = 0;

    try {
      const sessionDocId = `_import_session_${ctx.sessionId}`;
      const sessionDocForTrigger = await readControlDoc(ctx.container, sessionDocId, ctx.sessionId).catch(() => null);
      lastTriggeredTs = Date.parse(String(sessionDocForTrigger?.resume_worker_last_triggered_at || "")) || 0;
    } catch {}

    if (lastTriggeredTs && Date.now() - lastTriggeredTs < cooldownMs) {
      ctx.canTrigger = false;
      ctx.stageBeaconValues.status_resume_trigger_cooldown = nowIso();
      ctx.stageBeaconValues.status_resume_next_allowed_at = new Date(lastTriggeredTs + cooldownMs).toISOString();
    }
  }

  return { watchdog_stuck_queued, watchdog_last_finished_at, resumeStuckQueuedMs };
}

// ── runSingleCompanyPolicy ───────────────────────────────────────────────────

/**
 * Evaluates single-company termination policy. If force-terminalize
 * triggers, invokes the resume worker with force_terminalize_single: true.
 *
 * @param {object} ctx          Mutable orchestration context
 * @param {object} watchdogResult  From runWatchdogStuckDetection
 */
async function runSingleCompanyPolicy(ctx, { watchdog_stuck_queued, watchdog_last_finished_at, resumeStuckQueuedMs }) {
  try {
    const sessionDocId = `_import_session_${ctx.sessionId}`;
    const sessionDocForPolicy = await readControlDoc(ctx.container, sessionDocId, ctx.sessionId).catch(() => null);

    // Use extended function to get decision reason for definitive logging
    const singleCompanyResult = isSingleCompanyModeFromSessionWithReason({
      sessionDoc: sessionDocForPolicy,
      savedCount: ctx.saved,
      itemsCount: Array.isArray(ctx.saved_companies) ? ctx.saved_companies.length : 0,
    });
    const singleCompanyMode = singleCompanyResult.decision;

    // Definitive logging: show both inputs and decision at time of policy check
    try {
      console.log("[import-status] single_company_decision", {
        session_id: ctx.sessionId,
        ...singleCompanyResult.inputs,
        decision_single_company_mode: singleCompanyResult.decision,
        decision_reason: singleCompanyResult.reason,
      });
    } catch {}

    const currentCycleCount = Number(sessionDocForPolicy?.resume_cycle_count || 0) || 0;

    const resumeWorkerForProgress = {
      last_finished_at: sessionDocForPolicy?.resume_worker_last_finished_at || null,
      handler_entered_at: sessionDocForPolicy?.resume_worker_handler_entered_at || null,
    };

    const nowMs = Date.now();
    const queued = ctx.resumeStatus === "queued" && ctx.resume_needed === true;
    const noRecentProgress = !hasRecentWorkerProgress(resumeWorkerForProgress, nowMs, resumeStuckQueuedMs);
    const activelyProcessing = Boolean(ctx.stageBeaconValues.status_active_processing_resume_override);
    const shouldForceByQueuedTimeout = Boolean(singleCompanyMode && queued && noRecentProgress && ctx.retryableMissingCount === 0 && !activelyProcessing);

    ctx.stageBeaconValues.status_single_company_mode = Boolean(singleCompanyMode);
    ctx.stageBeaconValues.status_resume_cycle_count = currentCycleCount;
    ctx.stageBeaconValues.status_resume_queued = queued;
    ctx.stageBeaconValues.status_resume_no_recent_worker_progress = noRecentProgress;
    ctx.stageBeaconValues.status_resume_stuck_ms = resumeStuckQueuedMs;
    ctx.stageBeaconValues.status_resume_worker_last_finished_at = resumeWorkerForProgress.last_finished_at;
    ctx.stageBeaconValues.status_resume_worker_handler_entered_at = resumeWorkerForProgress.handler_entered_at;
    ctx.stageBeaconValues.status_resume_should_force_by_queued_timeout = shouldForceByQueuedTimeout;
    if (activelyProcessing) ctx.stageBeaconValues.status_resume_force_skip_actively_processing = true;

    const docsForInfra = ctx.savedDocsForHealth || [];

    const infraRetryableAtPolicy = collectInfraRetryableMissing(docsForInfra);
    const infraOnlyTimeout =
      infraRetryableAtPolicy.length > 0 &&
      infraRetryableAtPolicy.every((x) => normalizeKey(x?.missing_reason) === "upstream_timeout");

    ctx.stageBeaconValues.status_infra_retryable_missing_count = infraRetryableAtPolicy.length;
    ctx.stageBeaconValues.status_infra_retryable_only_timeout = infraOnlyTimeout;

    const preTriggerCap = Boolean(
      singleCompanyMode &&
        ctx.resume_needed &&
        currentCycleCount >= MAX_RESUME_CYCLES_SINGLE &&
        !infraOnlyTimeout
    );
    const watchdogNoProgress = Boolean(ctx.stageBeaconValues.status_resume_watchdog_stuck_queued_no_progress);

    const forceDecision = preTriggerCap
      ? { force: true, reason: "max_cycles" }
      : watchdogNoProgress && singleCompanyMode && queued && ctx.retryableMissingCount === 0
        ? { force: true, reason: "watchdog_no_progress" }
        : shouldForceByQueuedTimeout
          ? { force: true, reason: "queued_timeout_no_progress" }
          : shouldForceTerminalizeSingle({
              single: singleCompanyMode,
              resume_needed: ctx.resume_needed,
              resume_status: ctx.resumeStatus,
              resume_cycle_count: sessionDocForPolicy?.resume_cycle_count,
              resume_worker: resumeWorkerForProgress,
              resume_stuck_ms: resumeStuckQueuedMs,
              infra_only_timeout: infraOnlyTimeout,
              retryable_missing_count: ctx.retryableMissingCount,
              actively_processing: activelyProcessing,
            });

    // Instrumentation for max-cycles stalls (and other force-terminalize policies).
    ctx.stageBeaconValues.status_resume_force_terminalize_selected = !STATUS_NO_ORCHESTRATION && Boolean(forceDecision.force);
    if (!forceDecision.force) {
      const cap = infraOnlyTimeout
        ? Math.max(MAX_RESUME_CYCLES_SINGLE, MAX_RESUME_CYCLES_SINGLE_TIMEOUT_ONLY)
        : MAX_RESUME_CYCLES_SINGLE;
      ctx.stageBeaconValues.status_resume_force_terminalize_skip_reason = !singleCompanyMode
        ? "not_single_company_mode"
        : !ctx.resume_needed
          ? "resume_not_needed"
          : currentCycleCount + 1 < cap
            ? "below_cycle_cap"
            : infraOnlyTimeout
              ? "infra_timeout_only"
              : "policy_not_met";
    } else {
      ctx.stageBeaconValues.status_resume_force_terminalize_skip_reason = null;
    }

    if (!STATUS_NO_ORCHESTRATION && forceDecision.force) {
      const forcedAt = nowIso();
      ctx.stageBeaconValues.status_resume_blocked_reason = forceDecision.reason;

      const infraRetryable = infraRetryableAtPolicy;

      const errorCode = infraRetryable.length > 0
        ? infraOnlyTimeout
          ? "enrichment_upstream_timeout"
          : "enrichment_upstream_unreachable"
        : "resume_worker_stuck_queued_no_progress";

      const details = {
        forced_by: forceDecision.reason,
        blocked_reason: forceDecision.reason,
        blocked_code: errorCode,
        blocked_at: forcedAt,
        infra_retryable_missing: infraRetryable,
        last_worker_error: sessionDocForPolicy?.resume_worker_last_error_details || sessionDocForPolicy?.resume_worker_last_error || null,
        last_trigger_result: sessionDocForPolicy?.resume_worker_last_trigger_result || null,
        last_trigger_request_id: sessionDocForPolicy?.resume_worker_last_trigger_request_id || null,
        last_finished_at: sessionDocForPolicy?.resume_worker_last_finished_at || null,
        last_entered_at: sessionDocForPolicy?.resume_worker_handler_entered_at || null,
      };

      ctx.stageBeaconValues.status_resume_blocked = forcedAt;
      ctx.stageBeaconValues.status_resume_blocked_code = errorCode;

      ctx.resume_error = errorCode;
      ctx.resume_error_details = details;

      ctx.stageBeaconValues.status_resume_forced_terminalize = forcedAt;
      ctx.stageBeaconValues.status_resume_forced_terminalize_reason = forceDecision.reason;

      const workerRequest = buildInternalFetchRequest({ job_kind: "import_resume" });

      const forceRes = await invokeResumeWorkerInProcess({
        session_id: ctx.sessionId,
        context: ctx.context,
        workerRequest,
        force_terminalize_single: true,
        deadline_ms: INLINE_RESUME_DEADLINE_MS,
      }).catch((e) => ({
        ok: false,
        status: 0,
        bodyText: "",
        error: e,
        gateway_key_attached: Boolean(workerRequest?.gateway_key_attached),
        request_id: workerRequest?.request_id || null,
      }));

      ctx.stageBeaconValues.status_resume_forced_terminalize_http_status = Number(forceRes?.status || 0) || 0;
      ctx.stageBeaconValues.status_resume_forced_terminalize_ok = Boolean(forceRes?.ok);

      ctx.resume_triggered = Boolean(forceRes?.ok);
      ctx.resume_gateway_key_attached = Boolean(forceRes?.gateway_key_attached);
      ctx.resume_trigger_request_id = forceRes?.request_id || workerRequest.request_id;

      ctx.stageBeaconValues.status_resume_terminal_only = forcedAt;

      ctx.resume_error = null;
      ctx.resume_error_details = null;
      ctx.resume_trigger_error = null;
      ctx.resume_trigger_error_details = null;

      ctx.resume_needed = false;
      ctx.resume_status = "complete";
      ctx.resumeStatus = "complete";
      ctx.canTrigger = false;

      // Best-effort: persist stable terminal state onto the session doc
      try {
        const sessionDocForTerminal = await readControlDoc(ctx.container, sessionDocId, ctx.sessionId).catch(() => null);
        if (sessionDocForTerminal && typeof sessionDocForTerminal === "object") {
          await upsertDoc(ctx.container, {
            ...sessionDocForTerminal,
            resume_needed: false,
            status: "complete",
            stage_beacon: "status_resume_terminal_only",
            resume_terminal_only: true,
            resume_terminalized_at: forcedAt,
            resume_terminalized_reason: forceDecision.reason,
            updated_at: nowIso(),
          }).catch(() => null);
        }

        const resumeDocId = `_import_resume_${ctx.sessionId}`;
        const resumeDocForTerminal = await readControlDoc(ctx.container, resumeDocId, ctx.sessionId).catch(() => null);
        if (resumeDocForTerminal && typeof resumeDocForTerminal === "object") {
          await upsertDoc(ctx.container, {
            ...resumeDocForTerminal,
            status: "complete",
            resume_error: null,
            resume_error_details: null,
            blocked_at: null,
            blocked_reason: null,
            last_error: null,
            lock_expires_at: null,
            updated_at: nowIso(),
          }).catch(() => null);
        }
      } catch {}
    }
  } catch (policyErr) {
    // Log but don't fail the entire status call - policy check is non-critical
    console.error("[import-status] Exception in single-company policy check:", policyErr?.message || policyErr);
    try { console.log("[import-status] policy_error_stack:", policyErr?.stack); } catch {}
  }
}

// ── runResumeTriggerExecution ────────────────────────────────────────────────

/**
 * Invokes resume worker, parses/validates JSON response, persists trigger
 * result, handles watchdog error escalation.
 *
 * @param {object} ctx          Mutable orchestration context
 * @param {object} watchdogResult  From runWatchdogStuckDetection
 * @param {string} watchdogResult.resumeDocId  Resume doc ID for watchdog error persistence
 */
async function runResumeTriggerExecution(ctx, { watchdog_stuck_queued, watchdog_last_finished_at, resumeStuckQueuedMs, resumeDocId }) {
  if (STATUS_NO_ORCHESTRATION) return;
  if (!ctx.canTrigger) return;

  const triggerable = ctx.resumeStatus === "queued" || ctx.resumeStatus === "blocked" || ctx.resumeStatus === "error" || ctx.resumeStatus === "stalled" || (ctx.forceResume && ctx.resumeStatus !== "running");
  if (!triggerable) return;

  const triggerAttemptAt = nowIso();
  ctx.stageBeaconValues.status_trigger_resume_worker = triggerAttemptAt;

  const workerRequest = buildInternalFetchRequest({
    job_kind: "import_resume",
  });

  // Dedupe guard: record that we attempted a trigger so repeated /import/status polling
  // doesn't spam resume-worker invocations while the resume doc is queued.
  try {
    const sessionDocId = `_import_session_${ctx.sessionId}`;
    const sessionDocForTrigger = await readControlDoc(ctx.container, sessionDocId, ctx.sessionId).catch(() => null);
    if (sessionDocForTrigger && typeof sessionDocForTrigger === "object") {
      await upsertDoc(ctx.container, {
        ...sessionDocForTrigger,
        resume_worker_last_triggered_at: triggerAttemptAt,
        resume_last_triggered_at: triggerAttemptAt,
        resume_trigger_attempt_count: (Number(sessionDocForTrigger?.resume_trigger_attempt_count || 0) || 0) + 1,
        resume_worker_last_trigger_request_id: workerRequest.request_id || null,
        resume_worker_last_gateway_key_attached: Boolean(workerRequest.gateway_key_attached),
        updated_at: nowIso(),
      }).catch(() => null);
    }
  } catch {}

  const workerRes = await (async () => {
    try {
      const invokeRes = await invokeResumeWorkerInProcess({
        session_id: ctx.sessionId,
        context: ctx.context,
        workerRequest,
        deadline_ms: INLINE_RESUME_DEADLINE_MS,
      });

      ctx.resume_gateway_key_attached = Boolean(invokeRes.gateway_key_attached);
      ctx.resume_trigger_request_id = invokeRes.request_id || workerRequest.request_id;

      return {
        ok: Boolean(invokeRes.ok),
        status: Number(invokeRes.status || 0) || 0,
        text: async () => String(invokeRes.bodyText || ""),
        _error: invokeRes.error,
      };
    } catch (e) {
      ctx.resume_gateway_key_attached = Boolean(workerRequest.gateway_key_attached);
      ctx.resume_trigger_request_id = workerRequest.request_id;
      return { ok: false, status: 0, text: async () => "", _error: e };
    }
  })();

  let workerText = "";
  try {
    if (workerRes && typeof workerRes.text === "function") workerText = await workerRes.text();
  } catch {}

  const statusCode = Number(workerRes?.status || 0) || 0;
  const preview = typeof workerText === "string" && workerText ? workerText.slice(0, 2000) : "";

  let workerJson = null;
  try {
    workerJson = workerText ? JSON.parse(workerText) : null;
  } catch {
    workerJson = null;
  }

  const responseOk = workerJson && typeof workerJson === "object" ? workerJson.ok : null;

  const bodySessionId = workerJson && typeof workerJson === "object"
    ? String(workerJson.session_id || workerJson.sessionId || "").trim()
    : "";

  const enteredAtFromBody = workerJson && typeof workerJson === "object"
    ? String(
        workerJson.handler_entered_at ||
          workerJson.worker_entered_at ||
          workerJson.handler_entered_at_iso ||
          workerJson.worker_entered_at_iso ||
          ""
      ).trim()
    : "";

  const enteredTs = Date.parse(enteredAtFromBody) || 0;
  const attemptTs = Date.parse(String(triggerAttemptAt || "")) || 0;
  const enteredSameSecond = Boolean(enteredTs && attemptTs) && Math.floor(enteredTs / 1000) === Math.floor(attemptTs / 1000);
  const enteredAfterAttempt = Boolean(enteredTs && attemptTs) && enteredTs >= attemptTs;
  const enteredTimeOk = enteredAfterAttempt || enteredSameSecond;

  const strongTriggerOk =
    Boolean(workerRes?.ok) &&
    responseOk !== false &&
    Boolean(bodySessionId) &&
    bodySessionId === ctx.sessionId &&
    Boolean(enteredAtFromBody) &&
    enteredTimeOk;

  const triggerNoopOrNoEnter = Boolean(workerRes?.ok) && responseOk !== false && !strongTriggerOk;
  const triggerOk = strongTriggerOk;

  ctx.resume_triggered = triggerOk;

  const triggerResult = {
    ok: triggerOk,
    invocation: "in_process",
    http_status: statusCode,
    triggered_at: triggerAttemptAt,
    request_id: ctx.resume_trigger_request_id || null,
    gateway_key_attached: Boolean(ctx.resume_gateway_key_attached),
    response:
      workerJson && typeof workerJson === "object"
        ? {
            ok: responseOk !== false,
            stage_beacon: typeof workerJson.stage_beacon === "string" ? workerJson.stage_beacon : null,
            resume_needed: typeof workerJson.resume_needed === "boolean" ? workerJson.resume_needed : null,
            session_id: bodySessionId || null,
            handler_entered_at: enteredAtFromBody || null,
            did_work: typeof workerJson.did_work === "boolean" ? workerJson.did_work : null,
            did_work_reason:
              typeof workerJson.did_work_reason === "string" && workerJson.did_work_reason.trim()
                ? workerJson.did_work_reason.trim()
                : null,
            error:
              (typeof workerJson.error === "string" && workerJson.error.trim() ? workerJson.error.trim() : null) ||
              (typeof workerJson.root_cause === "string" && workerJson.root_cause.trim() ? workerJson.root_cause.trim() : null) ||
              null,
            _budget_debug: workerJson?._budget_debug || null,
          }
        : {
            response_text_preview: preview || null,
          },
  };

  if (!triggerOk) {
    const baseErr =
      triggerNoopOrNoEnter
        ? "resume_worker_trigger_noop_or_no_enter"
        : (workerJson && typeof workerJson === "object" && typeof workerJson.error === "string" && workerJson.error.trim()
            ? workerJson.error.trim()
            : null) ||
          (workerJson && typeof workerJson === "object" && typeof workerJson.root_cause === "string" && workerJson.root_cause.trim()
            ? workerJson.root_cause.trim()
            : null) ||
          workerRes?._error?.message ||
          `resume_worker_http_${statusCode}`;

    ctx.resume_trigger_error = watchdog_stuck_queued ? "resume_worker_stuck_or_trigger_failed" : baseErr;
    ctx.resume_trigger_error_details = {
      ...triggerResult,
      response_body: workerJson && typeof workerJson === "object" ? workerJson : null,
      response_text_preview: preview || null,
      watchdog: watchdog_stuck_queued
        ? {
            stuck_ms: resumeStuckQueuedMs,
            last_finished_at: watchdog_last_finished_at,
          }
        : null,
    };
  }

  // Always persist the trigger result so /api/import/status can be truthful even if the worker never re-enters.
  try {
    const sessionDocId = `_import_session_${ctx.sessionId}`;
    const sessionDocAfter = await readControlDoc(ctx.container, sessionDocId, ctx.sessionId).catch(() => null);

    const persistEnteredTs = Date.parse(String(sessionDocAfter?.resume_worker_handler_entered_at || "")) || 0;
    const persistAttemptTs = Date.parse(String(triggerAttemptAt || "")) || Date.now();

    const rejectLayer =
      statusCode === 401
        ? persistEnteredTs && persistEnteredTs >= persistAttemptTs - 5000
          ? "handler"
          : "gateway"
        : null;

    if (sessionDocAfter && typeof sessionDocAfter === "object") {
      await upsertDoc(ctx.container, {
        ...sessionDocAfter,
        resume_worker_last_trigger_result: triggerResult,
        resume_worker_last_trigger_ok: triggerOk,
        resume_worker_last_trigger_http_status: statusCode,
        resume_worker_last_trigger_request_id: ctx.resume_trigger_request_id || null,
        resume_worker_last_gateway_key_attached: Boolean(ctx.resume_gateway_key_attached),
        ...(triggerOk
          ? {}
          : {
              resume_error: String(ctx.resume_trigger_error || "").trim() || "resume_worker_trigger_failed",
              resume_error_details:
                ctx.resume_trigger_error_details && typeof ctx.resume_trigger_error_details === "object" ? ctx.resume_trigger_error_details : null,
              resume_needed: true,
              resume_worker_last_http_status: statusCode,
              resume_worker_last_reject_layer: rejectLayer,
            }),
        updated_at: nowIso(),
      }).catch(() => null);

      // After resume-worker completes, refresh saved_company_ids from the updated session doc
      if (triggerOk && Array.isArray(sessionDocAfter.saved_company_ids_verified) && sessionDocAfter.saved_company_ids_verified.length > 0) {
        ctx.saved_company_ids_verified = sessionDocAfter.saved_company_ids_verified;
        if (typeof sessionDocAfter.saved_verified_count === "number" && Number.isFinite(sessionDocAfter.saved_verified_count)) {
          ctx.saved_verified_count = sessionDocAfter.saved_verified_count;
        } else {
          ctx.saved_verified_count = ctx.saved_company_ids_verified.length;
        }
      }
    }
  } catch {}

  if (watchdog_stuck_queued && !triggerOk) {
    const erroredAt = nowIso();
    ctx.resume_status = "error";

    try {
      const rdoc = await readControlDoc(ctx.container, resumeDocId, ctx.sessionId).catch(() => null);
      if (rdoc && typeof rdoc === "object") {
        await upsertDoc(ctx.container, {
          ...rdoc,
          status: "error",
          last_error: {
            code: "resume_worker_stuck_or_trigger_failed",
            message: "Resume worker queued but no worker activity; retrigger failed",
            last_finished_at: watchdog_last_finished_at,
            trigger_result: triggerResult,
          },
          updated_at: erroredAt,
          lock_expires_at: null,
        }).catch(() => null);
      }
    } catch {}

    try {
      const sessionDocId = `_import_session_${ctx.sessionId}`;
      const sessionDocAfter2 = await readControlDoc(ctx.container, sessionDocId, ctx.sessionId).catch(() => null);
      if (sessionDocAfter2 && typeof sessionDocAfter2 === "object") {
        await upsertDoc(ctx.container, {
          ...sessionDocAfter2,
          resume_error: "resume_worker_stuck_or_trigger_failed",
          resume_error_details: {
            ...((ctx.resume_trigger_error_details && typeof ctx.resume_trigger_error_details === "object")
              ? ctx.resume_trigger_error_details
              : {}),
            updated_at: erroredAt,
          },
          resume_needed: true,
          status: "error",
          stage_beacon: "enrichment_resume_error",
          updated_at: erroredAt,
        }).catch(() => null);
      }
    } catch {}
  }
}

// ── runTerminalCycleEnforcement ──────────────────────────────────────────────

/**
 * Enforces terminal-only completion when the resume cycle cap is reached.
 *
 * If `resume_needed` is true and the session is blocked at or past the max
 * cycle count, this function invokes the resume worker with
 * `force_terminalize_single: true` and returns `terminalOnlyReason` for the caller.
 *
 * Also rolls back a stale `status_resume_terminal_only` marker when retryable
 * missing fields remain and cycles have not yet been exhausted.
 *
 * @param {object} opts
 * @param {object}      opts.out                    - Mutable response payload
 * @param {object}      opts.stageBeaconValues      - Mutable stage-beacon map
 * @param {number}      opts.retryableMissingCount
 * @param {object|null} opts.resumeMissingAnalysis
 * @param {string}      opts.sessionId
 * @param {object}      opts.context                - Azure function context
 * @returns {{ terminalOnlyReason: string|null }}
 */
async function runTerminalCycleEnforcement({
  out,
  stageBeaconValues,
  retryableMissingCount,
  resumeMissingAnalysis,
  sessionId,
  context,
}) {
  // Phase 1: detect max-cycles blocked → invoke force-terminalize worker
  try {
    const blockedReason = String(
      stageBeaconValues.status_resume_blocked_reason || out?.resume_error_details?.blocked_reason || ""
    ).trim();

    const cap = stageBeaconValues.status_infra_retryable_only_timeout
      ? Math.max(MAX_RESUME_CYCLES_SINGLE, MAX_RESUME_CYCLES_SINGLE_TIMEOUT_ONLY)
      : MAX_RESUME_CYCLES_SINGLE;

    const cycleCount = Number(stageBeaconValues.status_resume_cycle_count || out?.resume_cycle_count || 0) || 0;
    const maxCyclesBlocked = out?.resume_needed === true && (blockedReason.startsWith("max_cycles") || cycleCount >= cap);

    if (!STATUS_NO_ORCHESTRATION && maxCyclesBlocked && !stageBeaconValues.status_resume_terminal_only) {
      stageBeaconValues.status_resume_force_terminalize_selected = true;
      stageBeaconValues.status_resume_force_terminalize_skip_reason = null;

      const forcedAt = nowIso();
      stageBeaconValues.status_resume_forced_terminalize = forcedAt;
      stageBeaconValues.status_resume_forced_terminalize_reason = blockedReason || "max_cycles";

      const workerRequest = buildInternalFetchRequest({ job_kind: "import_resume" });
      const forceRes = await invokeResumeWorkerInProcess({
        session_id: sessionId,
        context,
        workerRequest,
        force_terminalize_single: true,
        deadline_ms: INLINE_RESUME_DEADLINE_MS,
      }).catch((e) => ({
        ok: false,
        status: 0,
        bodyText: "",
        error: e,
        gateway_key_attached: Boolean(workerRequest?.gateway_key_attached),
        request_id: workerRequest?.request_id || null,
      }));

      stageBeaconValues.status_resume_forced_terminalize_http_status = Number(forceRes?.status || 0) || 0;
      stageBeaconValues.status_resume_forced_terminalize_ok = Boolean(forceRes?.ok);

      stageBeaconValues.status_resume_terminal_only = forcedAt;
    }
  } catch {}

  // Phase 2: validate terminal-only can be applied
  const cap = stageBeaconValues.status_infra_retryable_only_timeout
    ? Math.max(MAX_RESUME_CYCLES_SINGLE, MAX_RESUME_CYCLES_SINGLE_TIMEOUT_ONLY)
    : MAX_RESUME_CYCLES_SINGLE;

  const cycleCount = Number(stageBeaconValues.status_resume_cycle_count || out?.resume_cycle_count || 0) || 0;
  const allowTerminalOnly = retryableMissingCount === 0 || cycleCount >= cap;

  if (!allowTerminalOnly && stageBeaconValues.status_resume_terminal_only) {
    stageBeaconValues.status_resume_terminal_only = null;
    stageBeaconValues.status_resume_forced_terminalize_reason = null;
    stageBeaconValues.status_resume_force_terminalize_selected = false;
    stageBeaconValues.status_resume_force_terminalize_skip_reason = "retryable_missing_remains";
  }

  const terminalOnlyReason =
    allowTerminalOnly && (stageBeaconValues.status_resume_terminal_only || resumeMissingAnalysis?.terminal_only)
      ? stageBeaconValues.status_resume_forced_terminalize_reason || "terminal_only_missing"
      : null;

  return { terminalOnlyReason };
}

module.exports = {
  runBlockedStateAutoRetry,
  runWatchdogStuckDetection,
  runSingleCompanyPolicy,
  runResumeTriggerExecution,
  runTerminalCycleEnforcement,
};
