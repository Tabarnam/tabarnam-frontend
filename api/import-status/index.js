let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}
let CosmosClient;
try {
  ({ CosmosClient } = require("@azure/cosmos"));
} catch {
  CosmosClient = null;
}
const { getSession: getImportSession } = require("../_importSessionStore");
const { getJob: getImportPrimaryJob, patchJob: patchImportPrimaryJob } = require("../_importPrimaryJobStore");
const { runPrimaryJob } = require("../_importPrimaryWorker");
const {
  buildInternalFetchHeaders,
  buildInternalFetchRequest,
  getInternalJobSecretInfo,
  getAcceptableInternalSecretsInfo,
} = require("../_internalJobAuth");

// IMPORTANT: pure handler module only (no app.http registrations). Loaded at cold start.
const { invokeResumeWorkerInProcess } = require("../import/resume-worker/handler");

const { getBuildInfo } = require("../_buildInfo");

// â”€â”€ Extracted modules â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const {
  RESUME_WATCHDOG_STALE_MS,
  MAX_RESUME_CYCLES_SINGLE,
  MAX_RESUME_CYCLES_SINGLE_TIMEOUT_ONLY,
  EMPTY_RESUME_DIAGNOSTICS,
  nowIso,
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
  collectInfraRetryableMissing,
  shouldForceTerminalizeSingle,
  forceTerminalizeCompanyDocForSingle,
  finalizeReviewsForCompletion,
  reconcileLowQualityToTerminal,
  applyTerminalOnlyCompletion,
  computeEnrichmentHealth,
  computeContractEnrichmentHealth,
  analyzeMissingFieldsForResume,
  summarizeEnrichmentHealth,
  toSavedCompanies,
  inferReconcileStrategy,
  getHeartbeatTimestamp,
  getJobCreatedTimestamp,
  computePrimaryProgress,
} = require("./_importStatusUtils");

const {
  STATUS_NO_ORCHESTRATION,
  readControlDoc,
  hasAnyCompanyDocs,
  fetchRecentCompanies,
  fetchCompaniesByIds,
  fetchCompanyByNormalizedDomain,
  fetchCompaniesByIdsFull,
  upsertDoc,
  persistResumeBlocked,
  ensurePrimaryJobProgressFields,
  markPrimaryJobError,
  savePrimaryJobCompanies,
  fetchAuthoritativeSavedCompanies,
} = require("./_importStatusCosmos");
const { getCosmosConfig } = require("../_cosmosConfig");
const {
  buildResumeWorkerMeta,
  buildMemoryOnlyResponse,
  buildPrimaryJobNoCosmosResponse,
} = require("./_importStatusResponse");

const HANDLER_ID = "import-status";

// SWA-safe deadline for inline resume-worker invocations.
const INLINE_RESUME_DEADLINE_MS = 15_000;

const BUILD_INFO = (() => {
  try {
    return getBuildInfo();
  } catch {
    return { build_id: "" };
  }
})();

function cors(req) {
  const origin = req?.headers?.get?.("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
  };
}

function json(obj, status = 200, req, extraHeaders) {
  const siteName = String(process.env.WEBSITE_SITE_NAME || "unknown_site");
  const buildId =
    String(
      process.env.BUILD_ID ||
        process.env.VERCEL_GIT_COMMIT_SHA ||
        process.env.GITHUB_SHA ||
        BUILD_INFO.build_id ||
        "unknown_build"
    ) || "unknown_build";

  const payload = obj && typeof obj === "object" && !Array.isArray(obj)
    ? {
        ...obj,
        handler_id: HANDLER_ID,
        handler_version: siteName,
        site_name: siteName,
        site_hostname: String(process.env.WEBSITE_HOSTNAME || BUILD_INFO?.runtime?.website_hostname || ""),
        build_id: obj.build_id || buildId,
        build_id_source: obj.build_id_source || BUILD_INFO.build_id_source || null,
      }
    : obj;

  return {
    status,
    headers: {
      ...cors(req),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Api-Handler": HANDLER_ID,
      "X-Api-Build-Id": String(BUILD_INFO.build_id || ""),
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
    },
    body: JSON.stringify(payload),
  };
}



async function handler(req, context) {
  const method = String(req?.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: cors(req) };

  // Wrap URL parsing to prevent 500 errors from malformed URLs
  let url;
  try {
    url = new URL(req.url);
  } catch (urlErr) {
    console.error("[import-status] Invalid URL:", req.url, urlErr?.message);
    return json({ ok: false, error: "Invalid request URL", code: "INVALID_URL" }, 400, req);
  }
  const sessionId = String(url.searchParams.get("session_id") || "").trim();
  const take = Number(url.searchParams.get("take") || "10") || 10;
  const forceResume =
    String(
      url.searchParams.get("force_resume") ||
        url.searchParams.get("forceResume") ||
        url.searchParams.get("trigger_resume") ||
        ""
    ).trim() === "1";

  // Always defined (some response branches don't load Cosmos).
  let effective_resume_status = null;
  let progress_notice = null;

  if (!sessionId) {
    return json({ ok: false, error: "Missing session_id", ...EMPTY_RESUME_DIAGNOSTICS }, 400, req);
  }

  const extraHeaders = { "x-session-id": sessionId };
  const jsonWithSessionId = (obj, status = 200) => {
    try {
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const sbv = obj.stage_beacon_values && typeof obj.stage_beacon_values === "object" ? obj.stage_beacon_values : null;
        if (!STATUS_NO_ORCHESTRATION && sbv?.status_resume_force_terminalize_selected === true) {
          const forcedReason =
            typeof sbv.status_resume_blocked_reason === "string" && sbv.status_resume_blocked_reason.trim()
              ? sbv.status_resume_blocked_reason.trim()
              : "force_terminalize_selected";
          applyTerminalOnlyCompletion(obj, forcedReason);
        }
      }
    } catch {}

    return json(obj, status, req, extraHeaders);
  };

  const statusCheckedAt = nowIso();
  const stageBeaconValues = {
    status_checked_at: statusCheckedAt,
    status_force_terminalize_reason: null,
  };

  const internalSecretInfo = (() => {
    try {
      return getInternalJobSecretInfo();
    } catch {
      return { secret: "", secret_source: null };
    }
  })();

  const acceptableSecretsInfo = (() => {
    try {
      return getAcceptableInternalSecretsInfo();
    } catch {
      return [];
    }
  })();

  const internalAuthConfigured = Array.isArray(acceptableSecretsInfo) && acceptableSecretsInfo.length > 0;

  const gatewayKeyConfigured = Boolean(String(process.env.FUNCTION_KEY || "").trim());
  const internalJobSecretConfigured = Boolean(String(process.env.X_INTERNAL_JOB_SECRET || "").trim());

  const buildResumeAuthDiagnostics = () => ({
    gateway_key_configured: gatewayKeyConfigured,
    internal_job_secret_configured: internalJobSecretConfigured,
    acceptable_secret_sources: Array.isArray(acceptableSecretsInfo) ? acceptableSecretsInfo.map((c) => c.source) : [],
    internal_secret_source: internalSecretInfo?.secret_source || null,
  });

  const buildResumeStallError = () => {
    const missingGatewayKey = !gatewayKeyConfigured;
    const missingInternalSecret = !internalJobSecretConfigured;

    const root_cause = missingGatewayKey
      ? missingInternalSecret
        ? "missing_gateway_key_and_internal_secret"
        : "missing_gateway_key"
      : "missing_internal_secret";

    const message = missingGatewayKey
      ? "Missing FUNCTION_KEY; Azure gateway auth (x-functions-key) is not configured, so resume-worker calls can be rejected before JS runs."
      : "Missing X_INTERNAL_JOB_SECRET; internal handler auth is not configured for resume-worker calls.";

    return {
      code: missingGatewayKey
        ? missingInternalSecret
          ? "resume_worker_gateway_401_missing_gateway_key_and_internal_secret"
          : "resume_worker_gateway_401_missing_gateway_key"
        : "resume_worker_gateway_401_missing_internal_secret",
      root_cause,
      missing_gateway_key: missingGatewayKey,
      missing_internal_secret: missingInternalSecret,
      message,
    };
  };

  // Used for response shaping across all branches (memory-only, primary-job, cosmos-backed).
  let resume_status = null;

  let primaryJob = await getImportPrimaryJob({ sessionId, cosmosEnabled: true }).catch(() => null);

  if (primaryJob && primaryJob.job_state) {
    stageBeaconValues.status_seen_primary_job = nowIso();

    const HARD_MAX_RUNTIME_MS = Math.max(
      10_000,
      Number.isFinite(Number(process.env.IMPORT_PRIMARY_HARD_TIMEOUT_MS))
        ? Math.trunc(Number(process.env.IMPORT_PRIMARY_HARD_TIMEOUT_MS))
        : 300_000
    );

    const HEARTBEAT_STALE_MS = Number.isFinite(Number(process.env.IMPORT_HEARTBEAT_STALE_MS))
      ? Math.max(5_000, Number(process.env.IMPORT_HEARTBEAT_STALE_MS))
      : 330_000;

    let progress = computePrimaryProgress(primaryJob, Date.now(), HARD_MAX_RUNTIME_MS);

    // Deterministic staleness handling (status must never allow indefinite running).
    const preState = String(primaryJob.job_state);
    if (preState === "running") {
      const hbTs = getHeartbeatTimestamp(primaryJob);
      if (hbTs && Date.now() - hbTs > HEARTBEAT_STALE_MS) {
        primaryJob =
          (await markPrimaryJobError({
            sessionId,
            code: "stalled_worker",
            message: "Worker heartbeat stale",
            stageBeacon: String(primaryJob?.stage_beacon || "primary_search_started"),
            details: { heartbeat_stale_ms: Date.now() - hbTs },
            stageBeaconValues,
          })) || primaryJob;
      }
    }

    // Hard-timeout guard even if the worker isn't making progress.
    const stateAfterStall = String(primaryJob?.job_state || preState);
    progress = computePrimaryProgress(primaryJob, Date.now(), HARD_MAX_RUNTIME_MS);

    if ((stateAfterStall === "queued" || stateAfterStall === "running") && progress.elapsed_ms > HARD_MAX_RUNTIME_MS) {
      primaryJob =
        (await markPrimaryJobError({
          sessionId,
          code: "primary_timeout",
          message: "Primary search exceeded hard runtime limit",
          stageBeacon: "primary_timeout",
          details: {
            elapsed_ms: progress.elapsed_ms,
            hard_timeout_ms: HARD_MAX_RUNTIME_MS,
            note: "Marked by status staleness guard",
          },
          stageBeaconValues,
        })) || primaryJob;
    }

    const ensured = await ensurePrimaryJobProgressFields({
      sessionId,
      job: primaryJob,
      hardMaxRuntimeMs: HARD_MAX_RUNTIME_MS,
      stageBeaconValues,
    });
    primaryJob = ensured.job;
    progress = ensured.progress;

    const jobState = String(primaryJob.job_state);
    const shouldDrive = jobState === "queued" || jobState === "running";

    if (jobState === "running") stageBeaconValues.status_seen_running = nowIso();

    let workerResult = null;
    if (shouldDrive) {
      stageBeaconValues.status_invoked_worker = nowIso();

      workerResult = await runPrimaryJob({
        context,
        sessionId,
        cosmosEnabled: true,
        invocationSource: "status",
      }).catch((e) => {
        stageBeaconValues.status_worker_error = nowIso();
        stageBeaconValues.status_worker_error_detail = typeof e?.message === "string" ? e.message : String(e);
        return null;
      });

      stageBeaconValues.status_worker_returned = nowIso();

      const claimed = Boolean(workerResult?.body?.meta?.worker_claimed);
      if (claimed) stageBeaconValues.status_worker_claimed = nowIso();
      else stageBeaconValues.status_worker_no_claim = nowIso();

      if (workerResult?.body?.status === "error" || workerResult?.body?.ok === false) {
        stageBeaconValues.status_worker_error = stageBeaconValues.status_worker_error || nowIso();
      }

      primaryJob = await getImportPrimaryJob({ sessionId, cosmosEnabled: true }).catch(() => primaryJob);
    }

    const finalJobState = String(primaryJob?.job_state || jobState);
    const status =
      finalJobState === "complete"
        ? "complete"
        : finalJobState === "error"
          ? "error"
          : finalJobState === "running"
            ? "running"
            : "queued";

    const state = status === "error" ? "failed" : status === "complete" ? "complete" : "running";

    let report = null;
    let saved = 0;
    let saved_companies = [];
    let savedCompanyDocs = [];

    let reconciled = false;
    let reconcile_strategy = null;
    let reconciled_saved_ids = [];

    let saved_verified_count = null;
    let saved_company_ids_verified = [];
    let saved_company_ids_unverified = [];
    let saved_company_urls = [];
    let save_outcome = null;
    let resume_error = null;
    let resume_error_details = null;
    let stopped = false;

    let sessionDoc = null;
    let completionDoc = null;
    let acceptDoc = null;
    let resumeDoc = null;
    let stopDoc = null;

    try {
      const { endpoint, key, databaseId, containerId } = getCosmosConfig();

      if (endpoint && key && CosmosClient) {
        const client = new CosmosClient({ endpoint, key });
        const container = client.database(databaseId).container(containerId);

        ([sessionDoc, completionDoc, acceptDoc, resumeDoc, stopDoc] = await Promise.all([
          readControlDoc(container, `_import_session_${sessionId}`, sessionId),
          readControlDoc(container, `_import_complete_${sessionId}`, sessionId),
          readControlDoc(container, `_import_accept_${sessionId}`, sessionId),
          readControlDoc(container, `_import_resume_${sessionId}`, sessionId),
          readControlDoc(container, `_import_stop_${sessionId}`, sessionId),
        ]));

        stopped = Boolean(stopDoc);
        const effectiveResumeMeta = computeEffectiveResumeStatus({ resumeDoc, sessionDoc, stopDoc });
        effective_resume_status = effectiveResumeMeta.effective_resume_status;
        progress_notice = effectiveResumeMeta.progress_notice;

        const domainMeta = deriveDomainAndCreatedAfter({ sessionDoc, acceptDoc });

        const completionVerifiedIds = Array.isArray(completionDoc?.saved_company_ids_verified)
          ? completionDoc.saved_company_ids_verified
          : Array.isArray(completionDoc?.saved_ids)
            ? completionDoc.saved_ids
            : [];

        const sessionVerifiedIds = Array.isArray(sessionDoc?.saved_company_ids_verified)
          ? sessionDoc.saved_company_ids_verified
          : Array.isArray(sessionDoc?.saved_ids)
            ? sessionDoc.saved_ids
            : [];

        saved_company_ids_verified = (completionVerifiedIds.length > 0 ? completionVerifiedIds : sessionVerifiedIds)
          .map((id) => String(id || "").trim())
          .filter(Boolean);

        saved_verified_count =
          (typeof completionDoc?.saved_verified_count === "number" && Number.isFinite(completionDoc.saved_verified_count)
            ? completionDoc.saved_verified_count
            : null) ??
          (typeof sessionDoc?.saved_verified_count === "number" && Number.isFinite(sessionDoc.saved_verified_count)
            ? sessionDoc.saved_verified_count
            : null) ??
          (saved_company_ids_verified.length > 0 ? saved_company_ids_verified.length : null);

        saved_company_ids_unverified = Array.isArray(sessionDoc?.saved_company_ids_unverified)
          ? sessionDoc.saved_company_ids_unverified
          : [];

        saved_company_urls = Array.isArray(sessionDoc?.saved_company_urls) ? sessionDoc.saved_company_urls : [];

        save_outcome =
          typeof sessionDoc?.save_outcome === "string" && sessionDoc.save_outcome.trim()
            ? sessionDoc.save_outcome.trim()
            : typeof completionDoc?.save_outcome === "string" && completionDoc.save_outcome.trim()
              ? completionDoc.save_outcome.trim()
              : null;

        resume_error =
          typeof sessionDoc?.resume_error === "string" && sessionDoc.resume_error.trim() ? sessionDoc.resume_error.trim() : null;

        resume_error_details =
          sessionDoc?.resume_error_details && typeof sessionDoc.resume_error_details === "object"
            ? sessionDoc.resume_error_details
            : null;

        const completionSavedIds = Array.isArray(completionDoc?.saved_ids) ? completionDoc.saved_ids : [];
        const completionSaved = typeof completionDoc?.saved === "number" ? completionDoc.saved : null;
        const sessionSaved = typeof sessionDoc?.saved === "number" ? sessionDoc.saved : null;
        saved = completionSaved ?? sessionSaved ?? 0;

        if (completionSavedIds.length > 0) {
          stageBeaconValues.status_fetching_saved_companies = nowIso();
          const savedDocs = await fetchCompaniesByIds(container, completionSavedIds).catch(() => []);
          savedCompanyDocs = savedDocs;
          saved_companies = toSavedCompanies(savedDocs);
          stageBeaconValues.status_fetched_saved_companies = nowIso();
        }

        // If the control doc only knows "saved" but not the saved_ids (or they weren't persisted yet),
        // still return the saved company doc(s) so the UI run history row isn't blank.
        if (Number(saved || 0) > 0 && (!Array.isArray(savedCompanyDocs) || savedCompanyDocs.length === 0)) {
          stageBeaconValues.status_fetching_saved_companies_fallback = nowIso();
          const fallbackDocs = await fetchRecentCompanies(container, {
            sessionId,
            take: Math.max(1, Math.min(200, Math.max(Number(saved) || 0, Number(take) || 10))),
            normalizedDomain: domainMeta.normalizedDomain,
            createdAfter: domainMeta.createdAfter,
          }).catch(() => []);

          if (Array.isArray(fallbackDocs) && fallbackDocs.length > 0) {
            savedCompanyDocs = fallbackDocs;
            saved_companies = toSavedCompanies(fallbackDocs);
            stageBeaconValues.status_fetched_saved_companies_fallback = nowIso();
          }
        }

        // Authoritative reconciliation: async primary runs can persist companies even when the completion/session report is stale.
        if (Number(saved || 0) === 0) {
          stageBeaconValues.status_reconcile_saved_probe = nowIso();

          const authoritativeDocs = await fetchAuthoritativeSavedCompanies(container, {
            sessionId,
            sessionCreatedAt: domainMeta.sessionCreatedAt,
            normalizedDomain: domainMeta.normalizedDomain,
            createdAfter: domainMeta.createdAfter,
            limit: 200,
          }).catch(() => []);

          if (authoritativeDocs.length > 0) {
            const authoritativeIds = authoritativeDocs.map((d) => String(d?.id || "").trim()).filter(Boolean);
            const reason =
              String(primaryJob?.stage_beacon || "").trim() === "primary_early_exit" ? "saved_after_primary_async" : "post_primary_reconciliation";

            reconciled = true;
            reconcile_strategy = inferReconcileStrategy(authoritativeDocs, sessionId);
            reconciled_saved_ids = authoritativeIds;

            saved = authoritativeDocs.length;
            savedCompanyDocs = authoritativeDocs;
            saved_companies = toSavedCompanies(authoritativeDocs);
            stageBeaconValues.status_reconciled_saved = nowIso();
            stageBeaconValues.status_reconciled_saved_count = saved;

            // Persist the corrected summary (best-effort). Never treat primary_early_exit as authoritative for saved=0.
            const now = nowIso();

            if (completionDoc) {
              await upsertDoc(container, {
                ...completionDoc,
                saved,
                saved_ids: authoritativeIds,
                reason,
                reconciled_at: now,
                updated_at: now,
              }).catch(() => null);
            }

            if (sessionDoc) {
              await upsertDoc(container, {
                ...sessionDoc,
                saved,
                companies_count: saved,
                reconciliation_reason: reason,
                reconciled_at: now,
                updated_at: now,
              }).catch(() => null);
            }
          } else {
            stageBeaconValues.status_reconciled_saved_none = nowIso();

            // Post-primary save bridge: primary job completed with companies but nothing
            // was saved to Cosmos (202 accepted flow gap). Save them now.
            const primaryCompanies = Array.isArray(primaryJob?.companies) ? primaryJob.companies : [];
            const primaryComplete = String(primaryJob?.job_state || "").trim() === "complete";
            if (primaryComplete && primaryCompanies.length > 0 && !STATUS_NO_ORCHESTRATION) {
              stageBeaconValues.status_primary_bridge_save_start = nowIso();
              try {
                const bridgeResult = await savePrimaryJobCompanies(container, {
                  sessionId,
                  primaryJob,
                  stageBeaconValues,
                });
                if (bridgeResult.saved > 0) {
                  saved = bridgeResult.saved;
                  reconciled = true;
                  reconcile_strategy = "primary_bridge_save";
                  reconciled_saved_ids = bridgeResult.saved_ids;

                  // Re-fetch the saved docs so they appear in the response
                  const bridgeDocs = await fetchCompaniesByIds(container, bridgeResult.saved_ids).catch(() => []);
                  if (bridgeDocs.length > 0) {
                    savedCompanyDocs = bridgeDocs;
                    saved_companies = toSavedCompanies(bridgeDocs);
                  }

                  // Update verified IDs
                  saved_company_ids_verified = bridgeResult.saved_ids;
                  saved_verified_count = bridgeResult.saved_ids.length;

                  // Re-read session doc since the bridge updated it
                  sessionDoc = await readControlDoc(container, `_import_session_${sessionId}`, sessionId).catch(() => sessionDoc);
                  completionDoc = await readControlDoc(container, `_import_complete_${sessionId}`, sessionId).catch(() => completionDoc);

                  stageBeaconValues.status_primary_bridge_save_complete = nowIso();
                }
              } catch (bridgeErr) {
                stageBeaconValues.status_primary_bridge_save_error = String(bridgeErr?.message || bridgeErr).slice(0, 200);
              }
            }
          }
        }

        report = {
          session: sessionDoc
            ? {
                created_at: sessionDoc?.created_at || null,
                request_id: sessionDoc?.request_id || null,
                status: sessionDoc?.status || null,
                stage_beacon: sessionDoc?.stage_beacon || null,
                resume_needed: Boolean(sessionDoc?.resume_needed),
                request: sessionDoc?.request && typeof sessionDoc.request === "object" ? sessionDoc.request : null,
              }
            : null,
          accepted: Boolean(acceptDoc),
          accept: acceptDoc
            ? {
                accepted_at: acceptDoc?.accepted_at || acceptDoc?.created_at || null,
                reason: acceptDoc?.reason || null,
                stage_beacon: acceptDoc?.stage_beacon || null,
                remaining_ms: Number.isFinite(Number(acceptDoc?.remaining_ms)) ? Number(acceptDoc.remaining_ms) : null,
              }
            : null,
          completion: completionDoc
            ? {
                completed_at: completionDoc?.completed_at || completionDoc?.created_at || null,
                reason: completionDoc?.reason || null,
                saved: completionSaved,
                skipped: typeof completionDoc?.skipped === "number" ? completionDoc.skipped : null,
                failed: typeof completionDoc?.failed === "number" ? completionDoc.failed : null,
                saved_ids: completionSavedIds,
                skipped_ids: Array.isArray(completionDoc?.skipped_ids) ? completionDoc.skipped_ids : [],
                skipped_duplicates: Array.isArray(completionDoc?.skipped_duplicates) ? completionDoc.skipped_duplicates : [],
                failed_items: Array.isArray(completionDoc?.failed_items) ? completionDoc.failed_items : [],
              }
            : null,
          resume: resumeDoc
            ? {
                status: resumeDoc?.status || null,
                attempt: Number.isFinite(Number(resumeDoc?.attempt)) ? Number(resumeDoc.attempt) : 0,
                lock_expires_at: resumeDoc?.lock_expires_at || null,
                updated_at: resumeDoc?.updated_at || null,
              }
            : null,
        };
      }
    } catch {
      report = null;
      saved = 0;
      saved_companies = [];
    }

    if (!report) {
      report = {
        session: null,
        accepted: false,
        accept: null,
        completion: null,
      };
    }

    report.primary_job = primaryJob
      ? {
          id: primaryJob?.id || null,
          job_state: finalJobState,
          stage_beacon: primaryJob?.stage_beacon || null,
          attempt: Number.isFinite(Number(primaryJob?.attempt)) ? Number(primaryJob.attempt) : 0,
          last_error: primaryJob?.last_error || null,
          created_at: primaryJob?.created_at || null,
          updated_at: primaryJob?.updated_at || null,
        }
      : null;

    const savedDocsForHealth =
      Array.isArray(savedCompanyDocs) && savedCompanyDocs.length > 0
        ? savedCompanyDocs
        : Array.isArray(primaryJob?.companies)
          ? primaryJob.companies
          : [];

    const lowQualityMaxAttempts = Number.isFinite(Number(process.env.NON_GROK_LOW_QUALITY_MAX_ATTEMPTS))
      ? Math.max(1, Math.trunc(Number(process.env.NON_GROK_LOW_QUALITY_MAX_ATTEMPTS)))
      : 2;

    let reconciledLowQualityCount = 0;
    for (const doc of Array.isArray(savedDocsForHealth) ? savedDocsForHealth : []) {
      if (reconcileLowQualityToTerminal(doc, lowQualityMaxAttempts)) {
        reconciledLowQualityCount += 1;
      }
    }

    if (reconciledLowQualityCount > 0) {
      stageBeaconValues.status_reconciled_low_quality_terminal = nowIso();
      stageBeaconValues.status_reconciled_low_quality_terminal_count = reconciledLowQualityCount;
    }

    saved_companies = toSavedCompanies(savedDocsForHealth);
    const enrichment_health_summary = summarizeEnrichmentHealth(saved_companies);

    // Always surface "verified save" fields while running so the Admin UI can render
    // stable saved counts + Open company links.
    if (!Number.isFinite(Number(saved_verified_count))) {
      saved_verified_count = saved_company_ids_verified.length > 0 ? saved_company_ids_verified.length : 0;
    }

    if (Array.isArray(saved_company_ids_verified) && saved_company_ids_verified.length === 0 && saved_companies.length > 0) {
      saved_company_ids_verified = saved_companies
        .map((c) => String(c?.company_id || "").trim())
        .filter(Boolean)
        .slice(0, 50);
    }

    const session = report?.session && typeof report.session === "object" ? report.session : {};
    if (report && typeof report === "object" && !report.session) report.session = session;

    session.saved_company_ids_verified = saved_company_ids_verified;
    session.saved_company_ids_unverified = saved_company_ids_unverified;
    session.saved_verified_count = saved_verified_count;
    session.saved = saved;

    // Canonical persisted ids computation. Never reference savedCompanies.
    const savedCompanyIdsVerified = Array.isArray(session?.saved_company_ids_verified)
      ? session.saved_company_ids_verified
      : [];

    const savedCompanyIdsUnverified = Array.isArray(session?.saved_company_ids_unverified)
      ? session.saved_company_ids_unverified
      : [];

    // Use case-insensitive id keys to avoid duplicates by casing, while preserving original id values.
    const persistedIds = Array.from(
      new Map(
        [...savedCompanyIdsVerified, ...savedCompanyIdsUnverified]
          .filter(Boolean)
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => [s.toLowerCase(), s])
      ).values()
    );

    const persistedCount = Math.max(
      persistedIds.length,
      Number(session?.saved_verified_count || 0),
      Number(session?.saved || 0),
      Array.isArray(session?.saved_companies) ? session.saved_companies.length : 0
    );

    saved = persistedCount;

    const resumeNeededFromSession = Boolean(report?.session && report.session.resume_needed);

    // Recompute missing fields on every status call, then reconcile terminal-only completion.
    // If the only missing fields are terminal (HQ/MFG "Not disclosed", reviews exhausted, logo not_found_on_site),
    // status must report resume_needed=false so imports do not stall forever.
    const resumeMissingAnalysis = analyzeMissingFieldsForResume(savedDocsForHealth);
    const resumeNeededFromHealth = resumeMissingAnalysis.total_retryable_missing > 0;

    stageBeaconValues.status_resume_missing_total = resumeMissingAnalysis.total_missing;
    stageBeaconValues.status_resume_missing_retryable = resumeMissingAnalysis.total_retryable_missing;
    stageBeaconValues.status_resume_missing_terminal = resumeMissingAnalysis.total_terminal_missing;
    if (resumeMissingAnalysis.terminal_only) stageBeaconValues.status_resume_terminal_only = nowIso();

    const missing_by_company = saved_companies
      .filter((c) => Array.isArray(c?.enrichment_health?.missing_fields) && c.enrichment_health.missing_fields.length > 0)
      .map((c) => ({
        company_id: c.company_id,
        company_name: c.company_name,
        website_url: c.website_url,
        missing_fields: c.enrichment_health.missing_fields,
      }));

    const resumeDocExists = Boolean(report?.resume);
    const resumeDocStatus = typeof report?.resume?.status === "string" ? report.resume.status.trim() : "";
    const forceTerminalComplete =
      resumeDocStatus === "complete" && resumeMissingAnalysis.total_retryable_missing === 0;

    // If the saved companies are only missing terminal fields (or none), ignore stale control-doc resume_needed/resume-doc existence.
    const retryableMissingCount = Number(resumeMissingAnalysis?.total_retryable_missing || 0) || 0;

    let resume_needed = forceResume ? true : retryableMissingCount > 0;

    // Reflect terminal completion in the report payload as well.
    if ((resumeMissingAnalysis.terminal_only || forceTerminalComplete) && report?.session) {
      report.session.resume_needed = false;
      report.session.status = "complete";
      report.session.stage_beacon = "complete";
    } else if (report?.session && report.session.resume_needed === true && resume_needed === false) {
      report.session.resume_needed = false;
    }

    let resume_doc_created = false;
    let resume_triggered = false;
    let resume_trigger_error = null;
    let resume_trigger_error_details = null;
    let resume_gateway_key_attached = null;
    let resume_trigger_request_id = null;

    resume_status = null;
    // Resume-worker is invoked in-process (no internal HTTP call), so Azure gateway/host-key requirements
    // do not gate the resume trigger.
    const resumeStalledByGatewayAuth = false;

    try {
      const { endpoint, key, databaseId, containerId } = getCosmosConfig();

      if (resume_needed && endpoint && key && CosmosClient) {
        const client = new CosmosClient({ endpoint, key });
        const container = client.database(databaseId).container(containerId);
        const resumeDocId = `_import_resume_${sessionId}`;

        const currentResume = await readControlDoc(container, resumeDocId, sessionId).catch(() => null);

        if (!currentResume && !STATUS_NO_ORCHESTRATION) {
          const now = nowIso();
          await upsertDoc(container, {
            id: resumeDocId,
            session_id: sessionId,
            normalized_domain: "import",
            partition_key: "import",
            type: "import_control",
            created_at: now,
            updated_at: now,
            status: resumeStalledByGatewayAuth ? "stalled" : "queued",
            resume_auth: buildResumeAuthDiagnostics(),
            ...(resumeStalledByGatewayAuth
              ? {
                  stalled_at: now,
                  last_error: buildResumeStallError(),
                }
              : {}),
            missing_by_company,
          }).catch(() => null);
          resume_doc_created = true;
        }

        const resumeDoc = currentResume || (await readControlDoc(container, resumeDocId, sessionId).catch(() => null));
        const resumeStatusRaw = String(resumeDoc?.status || "").trim();
        let lockUntil = Date.parse(String(resumeDoc?.lock_expires_at || "")) || 0;

        let resumeStatus = resumeStatusRaw;

        // Drift repair: if retryable missing fields still exist but the resume control doc says "complete",
        // reopen it so /import/status polling can keep auto-driving enrichment without requiring a manual click.
        if (!STATUS_NO_ORCHESTRATION && !forceResume && resume_needed && resumeStatus === "complete") {
          const reopenedAt = nowIso();
          stageBeaconValues.status_resume_reopened_from_complete = reopenedAt;
          resumeStatus = "queued";
          lockUntil = 0;

          try {
            await upsertDoc(container, {
              ...(resumeDoc && typeof resumeDoc === "object" ? resumeDoc : {}),
              id: resumeDocId,
              session_id: sessionId,
              normalized_domain: "import",
              partition_key: "import",
              type: "import_control",
              status: "queued",
              resume_error: null,
              resume_error_details: null,
              blocked_at: null,
              blocked_reason: null,
              last_error: null,
              lock_expires_at: null,
              updated_at: reopenedAt,
              missing_by_company,
            }).catch(() => null);
          } catch {}

          try {
            const sessionDocId = `_import_session_${sessionId}`;
            const sessionDocForReopen = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);
            if (sessionDocForReopen && typeof sessionDocForReopen === "object") {
              const sessionStatusRaw = String(sessionDocForReopen?.status || "").trim();
              const shouldDemote = sessionStatusRaw === "complete";

              await upsertDoc(container, {
                ...sessionDocForReopen,
                resume_needed: true,
                status: shouldDemote ? "running" : (sessionDocForReopen?.status || "running"),
                stage_beacon: shouldDemote
                  ? "enrichment_incomplete_retryable"
                  : (sessionDocForReopen?.stage_beacon || "enrichment_incomplete_retryable"),
                updated_at: reopenedAt,
              }).catch(() => null);
            }
          } catch {}
        }

        // Blocked should win over queued even if only the session control doc was persisted.
        const sessionBeaconRaw =
          typeof sessionDoc !== "undefined" && sessionDoc && typeof sessionDoc.stage_beacon === "string"
            ? sessionDoc.stage_beacon.trim()
            : "";
        if (!forceResume && sessionBeaconRaw === "enrichment_resume_blocked") {
          resumeStatus = "blocked";
        }

        if (resumeStalledByGatewayAuth) {
          const stalledAt = nowIso();
          const stall = buildResumeStallError();
          resumeStatus = "stalled";

          await upsertDoc(container, {
            ...resumeDoc,
            status: "stalled",
            stalled_at: stalledAt,
            resume_auth: buildResumeAuthDiagnostics(),
            last_error: buildResumeStallError(),
            updated_at: stalledAt,
            lock_expires_at: null,
          }).catch(() => null);

          try {
            const sessionDocId = `_import_session_${sessionId}`;
            const sessionDocForStall = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);
            if (sessionDocForStall && typeof sessionDocForStall === "object") {
              await upsertDoc(container, {
                ...sessionDocForStall,
                resume_error: stall.code,
                resume_error_details: {
                  root_cause: stall.root_cause,
                  message: stall.message,
                  missing_gateway_key: Boolean(stall.missing_gateway_key),
                  missing_internal_secret: Boolean(stall.missing_internal_secret),
                  ...buildResumeAuthDiagnostics(),
                  updated_at: stalledAt,
                },
                resume_needed: true,
                resume_worker_last_http_status: 401,
                resume_worker_last_reject_layer: "gateway",
                updated_at: stalledAt,
              }).catch(() => null);
            }
          } catch {}
        }

        resume_status = resumeStatus;
        const resumeUpdatedTs = Date.parse(String(resumeDoc?.updated_at || "")) || 0;
        const resumeAgeMs = resumeUpdatedTs ? Math.max(0, Date.now() - resumeUpdatedTs) : 0;

        // Hard stall detector: queued forever with no handler entry marker => label stalled.
        // Increased from 90s to 180s to allow more time for XAI enrichment calls
        // Wrapped in try-catch to prevent 500 errors from crashing the status endpoint
        try {
          if (resumeDoc && resumeStatus === "queued" && resumeAgeMs > 180_000) {
            const sessionDocId = `_import_session_${sessionId}`;
            const sessionDocForStall = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);
            const enteredTs = Date.parse(String(sessionDocForStall?.resume_worker_handler_entered_at || "")) || 0;
            const heartbeatTs = Date.parse(String(sessionDocForStall?.resume_worker_heartbeat_at || "")) || 0;
            // Check for last_finished_at - if set recently, worker completed successfully
            const finishedTs = Date.parse(String(
              sessionDocForStall?.resume_worker_last_finished_at ||
              resumeDoc?.last_finished_at || ""
            )) || 0;

            // Check for recent activity: handler entry OR heartbeat OR completion within 180s
            const mostRecentActivityTs = Math.max(enteredTs, heartbeatTs, finishedTs);
            const hasRecentActivity = mostRecentActivityTs && (Date.now() - mostRecentActivityTs < 180_000);

            // Check if resume doc indicates completion (don't mark completed work as stalled)
            const resumeIsComplete = resumeDoc?.status === "complete" ||
                                     (finishedTs && finishedTs >= resumeUpdatedTs);

            // If the worker never reached the handler after the resume doc was queued/updated, it's a gateway/host-key rejection.
            // Also don't mark as stalled if we have a recent heartbeat (worker is still running)
            // Also don't mark as stalled if the worker actually completed successfully
            if (!hasRecentActivity && !resumeIsComplete && (!enteredTs || (resumeUpdatedTs && enteredTs < resumeUpdatedTs))) {
              const stalledAt = nowIso();
              resumeStatus = "stalled";

              await upsertDoc(container, {
                ...resumeDoc,
                status: "stalled",
                stalled_at: stalledAt,
                last_error: {
                  code: "resume_stalled_no_worker_entry",
                  message: "Resume doc queued > 180s with no resume-worker handler entry marker",
                },
                updated_at: stalledAt,
                lock_expires_at: null,
              }).catch(() => null);

              if (sessionDocForStall && typeof sessionDocForStall === "object") {
                await upsertDoc(container, {
                  ...sessionDocForStall,
                  resume_error: "resume_stalled_no_worker_entry",
                  resume_error_details: {
                    root_cause: "resume_stalled_no_worker_entry",
                    message: "Resume doc queued > 180s and resume-worker handler entry marker never updated",
                    updated_at: stalledAt,
                  },
                  resume_needed: true,
                  updated_at: stalledAt,
                }).catch(() => null);
              }
            }
          }
        } catch (stallCheckErr) {
          console.error(`[import-status] Stall check error for session ${sessionId}: ${stallCheckErr?.message}`, stallCheckErr?.stack);
          // Don't re-throw - continue with other processing to avoid 500 errors
        }

        let canTrigger = !resumeStalledByGatewayAuth && (!lockUntil || Date.now() >= lockUntil);

        // Persisted blocked state: once blocked, /import/status must not keep auto-triggering the worker.
        // The worker may only resume via a manual force_resume=1 request (or future health-check/backoff logic).
        //
        // Exception: do NOT treat resume_no_progress_no_attempts as a hard block if we have evidence the resume-worker
        // entered recently (heartbeat/handler_entered_at) or we can explain "no attempts" via planner/budget state.
        if (!forceResume && resumeStatus === "blocked") {
          const activeResume = typeof currentResume !== "undefined" ? currentResume : resumeDoc;
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

            const sessionDocForUnblock = await readControlDoc(container, `_import_session_${sessionId}`, sessionId).catch(() => null);

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
              stageBeaconValues.status_resume_unblocked_planner_no_action = unblockedAt;

              if (activeResume && typeof activeResume === "object") {
                await upsertDoc(container, {
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
                await upsertDoc(container, {
                  ...sessionDocForUnblock,
                  resume_error: null,
                  resume_error_details: null,
                  // Keep session non-terminal; resume is still needed.
                  status: sessionDocForUnblock?.status === "complete" ? "running" : (sessionDocForUnblock?.status || "running"),
                  updated_at: unblockedAt,
                }).catch(() => null);
              }

              resumeStatus = "queued";
              resume_status = "queued";
            } else {
              stageBeaconValues.status_resume_blocked_auto_retry = nowIso();
            }
          } else {
            stageBeaconValues.status_resume_blocked_auto_retry = nowIso();
          }
        }

        const resumeStuckQueuedMs = Number.isFinite(Number(process.env.RESUME_STUCK_QUEUED_MS))
          ? Math.max(30_000, Math.trunc(Number(process.env.RESUME_STUCK_QUEUED_MS)))
          : 180_000;

        let watchdog_stuck_queued = false;
        let watchdog_last_finished_at = null;

        try {
          const sessionDocId = `_import_session_${sessionId}`;
          const sessionDocForWatchdog = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);
          watchdog_last_finished_at = sessionDocForWatchdog?.resume_worker_last_finished_at || null;

          const prevWatchdogAt =
            typeof sessionDocForWatchdog?.resume_worker_watchdog_stuck_queued_at === "string"
              ? sessionDocForWatchdog.resume_worker_watchdog_stuck_queued_at
              : null;

          const prevWatchdogTs = Date.parse(String(prevWatchdogAt || "")) || 0;
          const lastEnteredAt = sessionDocForWatchdog?.resume_worker_handler_entered_at || null;
          const lastEnteredTs = Date.parse(String(lastEnteredAt || "")) || 0;

          // Second-stage watchdog: if watchdog fired at time T, the very next status poll must observe a handler re-entry.
          if (prevWatchdogTs && resume_needed && resumeStatus === "queued" && (!lastEnteredTs || lastEnteredTs < prevWatchdogTs)) {
            const blockedAt = nowIso();
            stageBeaconValues.status_resume_watchdog_stuck_queued_no_progress = blockedAt;

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
            // Keep resume queued and allow /import/status to re-trigger resume-worker (with cooldown) automatically.
            resume_error = errorCode;
            resume_error_details = details;
            stageBeaconValues.status_resume_watchdog_retry_at = blockedAt;
          } else if (
            prevWatchdogTs &&
            lastEnteredTs &&
            lastEnteredTs >= prevWatchdogTs &&
            sessionDocForWatchdog &&
            typeof sessionDocForWatchdog === "object"
          ) {
            // Worker re-entered after the watchdog fired; clear marker so it can fire again if needed.
            await upsertDoc(container, {
              ...sessionDocForWatchdog,
              resume_worker_watchdog_stuck_queued_at: null,
              resume_worker_watchdog_resolved_at: nowIso(),
              updated_at: nowIso(),
            }).catch(() => null);
          }

          const lastFinishedTs = Date.parse(String(watchdog_last_finished_at || "")) || 0;

          if (resume_needed && resumeStatus === "queued" && lastFinishedTs && Date.now() - lastFinishedTs > resumeStuckQueuedMs) {
            watchdog_stuck_queued = true;
            const watchdogFiredAt = nowIso();
            stageBeaconValues.status_resume_watchdog_stuck_queued = watchdogFiredAt;

            if (sessionDocForWatchdog && typeof sessionDocForWatchdog === "object") {
              await upsertDoc(container, {
                ...sessionDocForWatchdog,
                resume_worker_watchdog_stuck_queued_at: watchdogFiredAt,
                resume_worker_watchdog_last_finished_at: watchdog_last_finished_at,
                updated_at: nowIso(),
              }).catch(() => null);
            }
          }
        } catch {}

        if (canTrigger && (resumeStatus === "queued" || resumeStatus === "blocked") && !forceResume) {
          const cooldownMs = 60_000;
          let lastTriggeredTs = 0;

          try {
            const sessionDocId = `_import_session_${sessionId}`;
            const sessionDocForTrigger = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);
            lastTriggeredTs = Date.parse(String(sessionDocForTrigger?.resume_worker_last_triggered_at || "")) || 0;
          } catch {}

          if (lastTriggeredTs && Date.now() - lastTriggeredTs < cooldownMs) {
            canTrigger = false;
            stageBeaconValues.status_resume_trigger_cooldown = nowIso();
            stageBeaconValues.status_resume_next_allowed_at = new Date(lastTriggeredTs + cooldownMs).toISOString();
          }
        }

        // Single-company deterministic termination: if we're stuck queued (or we've hit the cycle cap),
        // force terminal-only completion instead of allowing indefinite resume_needed=true.
        try {
          const sessionDocId = `_import_session_${sessionId}`;
          const sessionDocForPolicy = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);

          // Use extended function to get decision reason for definitive logging
          const singleCompanyResult = isSingleCompanyModeFromSessionWithReason({
            sessionDoc: sessionDocForPolicy,
            savedCount: saved,
            itemsCount: Array.isArray(saved_companies) ? saved_companies.length : 0,
          });
          const singleCompanyMode = singleCompanyResult.decision;

          // Definitive logging: show both inputs and decision at time of policy check
          try {
            console.log("[import-status] single_company_decision", {
              session_id: sessionId,
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
          const queued = resumeStatus === "queued" && resume_needed === true;
          const noRecentProgress = !hasRecentWorkerProgress(resumeWorkerForProgress, nowMs, resumeStuckQueuedMs);
          const activelyProcessing = Boolean(stageBeaconValues.status_active_processing_resume_override);
          const shouldForceByQueuedTimeout = Boolean(singleCompanyMode && queued && noRecentProgress && retryableMissingCount === 0 && !activelyProcessing);

          stageBeaconValues.status_single_company_mode = Boolean(singleCompanyMode);
          stageBeaconValues.status_resume_cycle_count = currentCycleCount;
          stageBeaconValues.status_resume_queued = queued;
          stageBeaconValues.status_resume_no_recent_worker_progress = noRecentProgress;
          stageBeaconValues.status_resume_stuck_ms = resumeStuckQueuedMs;
          stageBeaconValues.status_resume_worker_last_finished_at = resumeWorkerForProgress.last_finished_at;
          stageBeaconValues.status_resume_worker_handler_entered_at = resumeWorkerForProgress.handler_entered_at;
          stageBeaconValues.status_resume_should_force_by_queued_timeout = shouldForceByQueuedTimeout;
          if (activelyProcessing) stageBeaconValues.status_resume_force_skip_actively_processing = true;

          const docsForInfra =
            typeof savedDocsForHealth !== "undefined"
              ? savedDocsForHealth
              : typeof savedDocs !== "undefined"
                ? savedDocs
                : [];

          const infraRetryableAtPolicy = collectInfraRetryableMissing(docsForInfra);
          const infraOnlyTimeout =
            infraRetryableAtPolicy.length > 0 &&
            infraRetryableAtPolicy.every((x) => normalizeKey(x?.missing_reason) === "upstream_timeout");

          stageBeaconValues.status_infra_retryable_missing_count = infraRetryableAtPolicy.length;
          stageBeaconValues.status_infra_retryable_only_timeout = infraOnlyTimeout;

          // Enforce the cap only once it is actually reached.
          // (resume-worker increments resume_cycle_count on entry; allowing a final cycle at count==max is expected.)
          const preTriggerCap = Boolean(
            singleCompanyMode &&
              resume_needed &&
              currentCycleCount >= MAX_RESUME_CYCLES_SINGLE &&
              !infraOnlyTimeout
          );
          const watchdogNoProgress = Boolean(stageBeaconValues.status_resume_watchdog_stuck_queued_no_progress);

          const forceDecision = preTriggerCap
            ? { force: true, reason: "max_cycles" }
            : watchdogNoProgress && singleCompanyMode && queued && retryableMissingCount === 0
              ? { force: true, reason: "watchdog_no_progress" }
              : shouldForceByQueuedTimeout
                ? { force: true, reason: "queued_timeout_no_progress" }
                : shouldForceTerminalizeSingle({
                    single: singleCompanyMode,
                    resume_needed,
                    resume_status: resumeStatus,
                    resume_cycle_count: sessionDocForPolicy?.resume_cycle_count,
                    resume_worker: resumeWorkerForProgress,
                    resume_stuck_ms: resumeStuckQueuedMs,
                    infra_only_timeout: infraOnlyTimeout,
                    retryable_missing_count: retryableMissingCount,
                    actively_processing: activelyProcessing,
                  });

          // Instrumentation for max-cycles stalls (and other force-terminalize policies).
          stageBeaconValues.status_resume_force_terminalize_selected = !STATUS_NO_ORCHESTRATION && Boolean(forceDecision.force);
          if (!forceDecision.force) {
            const cap = infraOnlyTimeout
              ? Math.max(MAX_RESUME_CYCLES_SINGLE, MAX_RESUME_CYCLES_SINGLE_TIMEOUT_ONLY)
              : MAX_RESUME_CYCLES_SINGLE;
            stageBeaconValues.status_resume_force_terminalize_skip_reason = !singleCompanyMode
              ? "not_single_company_mode"
              : !resume_needed
                ? "resume_not_needed"
                : currentCycleCount + 1 < cap
                  ? "below_cycle_cap"
                  : infraOnlyTimeout
                    ? "infra_timeout_only"
                    : "policy_not_met";
          } else {
            stageBeaconValues.status_resume_force_terminalize_skip_reason = null;
          }

          if (!STATUS_NO_ORCHESTRATION && forceDecision.force) {
            const forcedAt = nowIso();
            stageBeaconValues.status_resume_blocked_reason = forceDecision.reason;

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

            stageBeaconValues.status_resume_blocked = forcedAt;
            stageBeaconValues.status_resume_blocked_code = errorCode;

            resume_error = errorCode;
            resume_error_details = details;

            // Deterministic convergence: if the policy says we cannot keep retrying, force terminalization
            // so the session reaches a stable terminal state without manual intervention.
            stageBeaconValues.status_resume_forced_terminalize = forcedAt;
            stageBeaconValues.status_resume_forced_terminalize_reason = forceDecision.reason;

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

            resume_triggered = Boolean(forceRes?.ok);
            resume_gateway_key_attached = Boolean(forceRes?.gateway_key_attached);
            resume_trigger_request_id = forceRes?.request_id || workerRequest.request_id;

            stageBeaconValues.status_resume_terminal_only = forcedAt;

            resume_error = null;
            resume_error_details = null;
            resume_trigger_error = null;
            resume_trigger_error_details = null;

            resume_needed = false;
            resume_status = "complete";
            resumeStatus = "complete";
            canTrigger = false;

            // Best-effort: persist stable terminal state onto the session doc so the UI
            // can rely on a single canonical completion beacon.
            try {
              const sessionDocId = `_import_session_${sessionId}`;
              const sessionDocForTerminal = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);
              if (sessionDocForTerminal && typeof sessionDocForTerminal === "object") {
                await upsertDoc(container, {
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

              const resumeDocId = `_import_resume_${sessionId}`;
              const resumeDocForTerminal = await readControlDoc(container, resumeDocId, sessionId).catch(() => null);
              if (resumeDocForTerminal && typeof resumeDocForTerminal === "object") {
                await upsertDoc(container, {
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

        if (!STATUS_NO_ORCHESTRATION &&
          canTrigger &&
          (resumeStatus === "queued" || resumeStatus === "blocked" || resumeStatus === "error" || resumeStatus === "stalled" || (forceResume && resumeStatus !== "running"))
        ) {
          const triggerAttemptAt = nowIso();
          stageBeaconValues.status_trigger_resume_worker = triggerAttemptAt;

          const workerRequest = buildInternalFetchRequest({
            job_kind: "import_resume",
          });

          // Dedupe guard: record that we attempted a trigger so repeated /import/status polling
          // doesn't spam resume-worker invocations while the resume doc is queued.
          try {
            const sessionDocId = `_import_session_${sessionId}`;
            const sessionDocForTrigger = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);
            if (sessionDocForTrigger && typeof sessionDocForTrigger === "object") {
              await upsertDoc(container, {
                ...sessionDocForTrigger,
                resume_worker_last_triggered_at: triggerAttemptAt,
                resume_last_triggered_at: triggerAttemptAt,
                // NOTE: resume_cycle_count is incremented by the resume-worker itself.
                // This keeps "cycles" aligned with real worker runs rather than status poll trigger attempts.
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
                session_id: sessionId,
                context,
                workerRequest,
                deadline_ms: INLINE_RESUME_DEADLINE_MS,
              });

              resume_gateway_key_attached = Boolean(invokeRes.gateway_key_attached);
              resume_trigger_request_id = invokeRes.request_id || workerRequest.request_id;

              return {
                ok: Boolean(invokeRes.ok),
                status: Number(invokeRes.status || 0) || 0,
                text: async () => String(invokeRes.bodyText || ""),
                _error: invokeRes.error,
              };
            } catch (e) {
              resume_gateway_key_attached = Boolean(workerRequest.gateway_key_attached);
              resume_trigger_request_id = workerRequest.request_id;
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
            bodySessionId === sessionId &&
            Boolean(enteredAtFromBody) &&
            enteredTimeOk;

          const triggerNoopOrNoEnter = Boolean(workerRes?.ok) && responseOk !== false && !strongTriggerOk;
          const triggerOk = strongTriggerOk;

          resume_triggered = triggerOk;

          const triggerResult = {
            ok: triggerOk,
            invocation: "in_process",
            http_status: statusCode,
            triggered_at: triggerAttemptAt,
            request_id: resume_trigger_request_id || null,
            gateway_key_attached: Boolean(resume_gateway_key_attached),
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

            resume_trigger_error = watchdog_stuck_queued ? "resume_worker_stuck_or_trigger_failed" : baseErr;
            resume_trigger_error_details = {
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
            const sessionDocId = `_import_session_${sessionId}`;
            const sessionDocAfter = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);

            const enteredTs = Date.parse(String(sessionDocAfter?.resume_worker_handler_entered_at || "")) || 0;
            const attemptTs = Date.parse(String(triggerAttemptAt || "")) || Date.now();

            const rejectLayer =
              statusCode === 401
                ? enteredTs && enteredTs >= attemptTs - 5000
                  ? "handler"
                  : "gateway"
                : null;

            if (sessionDocAfter && typeof sessionDocAfter === "object") {
              await upsertDoc(container, {
                ...sessionDocAfter,
                resume_worker_last_trigger_result: triggerResult,
                resume_worker_last_trigger_ok: triggerOk,
                resume_worker_last_trigger_http_status: statusCode,
                resume_worker_last_trigger_request_id: resume_trigger_request_id || null,
                resume_worker_last_gateway_key_attached: Boolean(resume_gateway_key_attached),
                ...(triggerOk
                  ? {}
                  : {
                      resume_error: String(resume_trigger_error || "").trim() || "resume_worker_trigger_failed",
                      resume_error_details:
                        resume_trigger_error_details && typeof resume_trigger_error_details === "object" ? resume_trigger_error_details : null,
                      resume_needed: true,
                      resume_worker_last_http_status: statusCode,
                      resume_worker_last_reject_layer: rejectLayer,
                    }),
                updated_at: nowIso(),
              }).catch(() => null);

              // After resume-worker completes, refresh saved_company_ids from the updated session doc
              // This fixes the timing race where the response would show stale zeros
              if (triggerOk && Array.isArray(sessionDocAfter.saved_company_ids_verified) && sessionDocAfter.saved_company_ids_verified.length > 0) {
                saved_company_ids_verified = sessionDocAfter.saved_company_ids_verified;
                if (typeof sessionDocAfter.saved_verified_count === "number" && Number.isFinite(sessionDocAfter.saved_verified_count)) {
                  saved_verified_count = sessionDocAfter.saved_verified_count;
                } else {
                  saved_verified_count = saved_company_ids_verified.length;
                }
              }
            }
          } catch {}

          if (watchdog_stuck_queued && !triggerOk) {
            const erroredAt = nowIso();
            resume_status = "error";

            try {
              const resumeDoc = await readControlDoc(container, resumeDocId, sessionId).catch(() => null);
              if (resumeDoc && typeof resumeDoc === "object") {
                await upsertDoc(container, {
                  ...resumeDoc,
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
              const sessionDocId = `_import_session_${sessionId}`;
              const sessionDocAfter = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);
              if (sessionDocAfter && typeof sessionDocAfter === "object") {
                await upsertDoc(container, {
                  ...sessionDocAfter,
                  resume_error: "resume_worker_stuck_or_trigger_failed",
                  resume_error_details: {
                    ...((resume_trigger_error_details && typeof resume_trigger_error_details === "object")
                      ? resume_trigger_error_details
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
      }
    } catch (e) {
      resume_trigger_error = e?.message || String(e);
    }

    const reportSessionStatus = typeof report?.session?.status === "string" ? report.session.status.trim() : "";
    const reportSessionStageBeacon = typeof report?.session?.stage_beacon === "string" ? report.session.stage_beacon.trim() : "";

    const forceComplete = Boolean(
      stageBeaconValues.status_resume_terminal_only ||
        (!forceResume &&
          (Number(saved || 0) > 0 || (Array.isArray(saved_companies) && saved_companies.length > 0)) &&
          Number(resumeMissingAnalysis?.total_retryable_missing || 0) === 0) ||
        resumeMissingAnalysis?.terminal_only ||
        ((reportSessionStatus === "complete" || reportSessionStageBeacon === "complete") && !resume_needed)
    );

    const effectiveStatus = forceComplete
      ? "complete"
      : status === "error"
        ? "error"
        : status === "complete" && resume_needed
          ? "running"
          : status;

    const effectiveState = forceComplete
      ? "complete"
      : status === "error"
        ? "failed"
        : state === "complete" && resume_needed
          ? "running"
          : state;

    const effectiveJobState = forceComplete ? "complete" : finalJobState;

    const stageBeaconFromPrimary =
      typeof primaryJob?.stage_beacon === "string" && primaryJob.stage_beacon.trim()
        ? primaryJob.stage_beacon.trim()
        : status === "complete"
          ? "primary_complete"
          : status === "queued"
            ? "primary_search_started"
            : status === "running"
              ? "primary_search_started"
              : "primary_search_started";

    const sessionStageBeacon =
      typeof report?.session?.stage_beacon === "string" && report.session.stage_beacon.trim()
        ? report.session.stage_beacon.trim()
        : "";

    // Safety net: if the watchdog decided "blocked" but doc persistence failed (or got lost behind routing),
    // the response must still surface blocked immediately so UI doesn't say "Resume queued" forever.
    const blockedReasonFromBeacon =
      typeof stageBeaconValues?.status_resume_blocked_reason === "string" && stageBeaconValues.status_resume_blocked_reason.trim()
        ? stageBeaconValues.status_resume_blocked_reason.trim()
        : stageBeaconValues?.status_resume_watchdog_stuck_queued_no_progress
          ? "watchdog_no_progress"
          : null;

    const blockedCodeFromBeacon =
      typeof stageBeaconValues?.status_resume_blocked_code === "string" && stageBeaconValues.status_resume_blocked_code.trim()
        ? stageBeaconValues.status_resume_blocked_code.trim()
        : null;

    if (!forceComplete && resume_needed && blockedReasonFromBeacon) {
      resume_status = "blocked";
      if (!resume_error && blockedCodeFromBeacon) resume_error = blockedCodeFromBeacon;

      if (!resume_error_details || typeof resume_error_details !== "object") {
        resume_error_details = {
          forced_by: blockedReasonFromBeacon,
          blocked_reason: blockedReasonFromBeacon,
          blocked_code: blockedCodeFromBeacon,
          blocked_at:
            stageBeaconValues.status_resume_blocked ||
            stageBeaconValues.status_resume_watchdog_stuck_queued_no_progress ||
            nowIso(),
          resume_cycle_count: stageBeaconValues.status_resume_cycle_count ?? null,
          updated_at: nowIso(),
        };
      }
    }

    const persistedResumeDocStatus =
      typeof resumeDoc !== "undefined" && resumeDoc && typeof resumeDoc.status === "string" ? resumeDoc.status.trim() : "";

    if (!forceComplete && resume_needed && persistedResumeDocStatus === "blocked") {
      resume_status = "blocked";
    }

    const resumeStatusForBeacon = String(resume_status || "").trim();

    const resumeStageBeacon = (() => {
      if (!forceComplete && !resume_needed) return null;
      if (resumeStatusForBeacon === "blocked") return "enrichment_resume_blocked";
      if (resumeStatusForBeacon === "queued") return "enrichment_resume_queued";
      if (resumeStatusForBeacon === "running") return "enrichment_resume_running";
      if (resumeStatusForBeacon === "stalled") return "enrichment_resume_stalled";
      if (resumeStatusForBeacon === "error") return "enrichment_resume_error";
      if (retryableMissingCount > 0) return "enrichment_incomplete_retryable";
      return "complete";
    })();

    const shouldShowCompleteBeacon = Boolean((effectiveStatus === "complete" && !resume_needed) || forceComplete);

    const completeBeacon =
      (resumeMissingAnalysis?.terminal_only || sessionStageBeacon === "status_resume_terminal_only")
        ? "status_resume_terminal_only"
        : "complete";

    const effectiveStageBeacon = shouldShowCompleteBeacon
      ? completeBeacon
      : resumeStageBeacon || sessionStageBeacon || stageBeaconFromPrimary;

    stageBeaconValues.status_enrichment_health_summary = nowIso();
    stageBeaconValues.status_enrichment_incomplete = enrichment_health_summary.incomplete;

    if (resumeStalledByGatewayAuth) {
      const stall = buildResumeStallError();
      resume_status ||= "stalled";

      // Ensure status does not look like "running forever" when the environment cannot
      // authenticate internal resume-worker calls.
      if (!resume_error) resume_error = stall.code;
      if (!resume_error_details) {
        resume_error_details = {
          root_cause: stall.root_cause,
          message: stall.message,
          missing_gateway_key: Boolean(stall.missing_gateway_key),
          missing_internal_secret: Boolean(stall.missing_internal_secret),
          ...buildResumeAuthDiagnostics(),
          updated_at: nowIso(),
        };
      }

      // Mirror deterministic 'gateway' rejection semantics for UI rendering.
      if (typeof sessionDoc !== "undefined" && sessionDoc && typeof sessionDoc === "object") {
        sessionDoc.resume_worker_last_reject_layer = "gateway";
        if (typeof sessionDoc.resume_worker_last_http_status !== "number") {
          sessionDoc.resume_worker_last_http_status = 401;
        }
      }
    }

    const resumeUpstreamCallsMade = Math.max(
      typeof resumeDoc !== "undefined" &&
        resumeDoc &&
        typeof resumeDoc.upstream_calls_made === "number" &&
        Number.isFinite(resumeDoc.upstream_calls_made)
        ? Math.max(0, resumeDoc.upstream_calls_made)
        : 0,
      typeof sessionDoc !== "undefined" &&
        sessionDoc &&
        typeof sessionDoc.resume_worker_upstream_calls_made === "number" &&
        Number.isFinite(sessionDoc.resume_worker_upstream_calls_made)
        ? Math.max(0, sessionDoc.resume_worker_upstream_calls_made)
        : 0
    );

    stageBeaconValues.status_resume_upstream_calls_made = resumeUpstreamCallsMade;

    // Ensure resume status/error surface even if the resume-handling block bailed out early.
    if (!resume_status) {
      const persistedResumeStatus =
        typeof resumeDoc !== "undefined" && resumeDoc && typeof resumeDoc.status === "string" ? resumeDoc.status.trim() : null;

      if (persistedResumeStatus) resume_status = persistedResumeStatus;

      if (!resume_error) {
        const persistedResumeError =
          typeof resumeDoc !== "undefined" && resumeDoc && typeof resumeDoc.resume_error === "string" && resumeDoc.resume_error.trim()
            ? resumeDoc.resume_error.trim()
            : null;
        if (persistedResumeError) resume_error = persistedResumeError;
      }

      if (!resume_error_details || typeof resume_error_details !== "object") {
        const persistedResumeErrorDetails =
          typeof resumeDoc !== "undefined" && resumeDoc && resumeDoc.resume_error_details && typeof resumeDoc.resume_error_details === "object"
            ? resumeDoc.resume_error_details
            : null;
        if (persistedResumeErrorDetails) resume_error_details = persistedResumeErrorDetails;
      }
    }

    const out = {
        ok: true,
        session_id: sessionId,
        status: effectiveStatus,
        state: effectiveState,
        stopped,
        job_state: effectiveJobState,
        stage_beacon: effectiveStageBeacon,
        stage_beacon_values: stageBeaconValues,
        primary_job_state: effectiveJobState,
        last_heartbeat_at: primaryJob?.last_heartbeat_at || null,
        lock_until: primaryJob?.lock_expires_at || null,
        attempts: Number.isFinite(Number(primaryJob?.attempt)) ? Number(primaryJob.attempt) : 0,
        last_error: primaryJob?.last_error || null,
        worker_meta: workerResult?.body?.meta || null,
        elapsed_ms: Number(progress?.elapsed_ms),
        remaining_budget_ms: Number(progress?.remaining_budget_ms),
        upstream_calls_made: (Number(progress?.upstream_calls_made) || 0) + resumeUpstreamCallsMade,
        companies_candidates_found: Number(progress?.companies_candidates_found),
        early_exit_triggered: Boolean(progress?.early_exit_triggered),
        companies_count:
          Number(saved || 0) > 0
            ? Number(saved)
            : Number.isFinite(Number(primaryJob?.companies_count))
              ? Number(primaryJob.companies_count)
              : 0,
        items: effectiveStatus === "error" ? [] : Array.isArray(primaryJob?.companies) ? primaryJob.companies : [],
        saved,
        saved_verified_count,
        saved_company_ids_verified,
        saved_company_ids_unverified,
        saved_company_urls,
        save_outcome,
        resume_error,
        resume_error_details,
        enrichment_last_write_error: (typeof sessionDoc !== "undefined" && sessionDoc)
          ? sessionDoc?.enrichment_last_write_error || null
          : null,
        reconciled,
        reconcile_strategy,
        reconciled_saved_ids,
        saved_companies,
        effective_resume_status,
        ...(progress_notice ? { progress_notice } : {}),
        resume_needed,
        resume_cycle_count:
          (typeof sessionDoc !== "undefined" && sessionDoc && typeof sessionDoc === "object")
            ? Number(sessionDoc?.resume_cycle_count || 0) || 0
            : 0,
        resume_last_triggered_at:
          (typeof sessionDoc !== "undefined" && sessionDoc && typeof sessionDoc === "object")
            ? sessionDoc?.resume_last_triggered_at || sessionDoc?.resume_worker_last_triggered_at || null
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
            typeof resumeDoc?.cycle_count === "number" && Number.isFinite(Number(resumeDoc.cycle_count))
              ? Number(resumeDoc.cycle_count)
              : (typeof sessionDoc !== "undefined" && sessionDoc && typeof sessionDoc === "object")
                ? Number(sessionDoc?.resume_cycle_count || 0) || 0
                : null,
          max_cycles_single: MAX_RESUME_CYCLES_SINGLE,
          max_resume_cycles_single: MAX_RESUME_CYCLES_SINGLE,
          last_triggered_at:
            (typeof sessionDoc !== "undefined" && sessionDoc && typeof sessionDoc === "object")
              ? sessionDoc?.resume_last_triggered_at || sessionDoc?.resume_worker_last_triggered_at || null
              : null,
          next_allowed_run_at:
            (typeof resumeDoc?.next_allowed_run_at === "string" && resumeDoc.next_allowed_run_at.trim())
              ? resumeDoc.next_allowed_run_at.trim()
              : (typeof sessionDoc?.resume_next_allowed_run_at === "string" && sessionDoc.resume_next_allowed_run_at.trim())
                ? sessionDoc.resume_next_allowed_run_at.trim()
                : null,
          ...buildResumeAuthDiagnostics(),
          missing_by_company,
        },
        resume_worker: buildResumeWorkerMeta({ sessionDoc, resumeDoc }),
        enrichment_health_summary,
        primary_job: {
          id: primaryJob?.id || null,
          job_state: finalJobState,
          attempt: Number.isFinite(Number(primaryJob?.attempt)) ? Number(primaryJob.attempt) : 0,
          attempts: Number.isFinite(Number(primaryJob?.attempt)) ? Number(primaryJob.attempt) : 0,
          last_error: primaryJob?.last_error || null,
          elapsed_ms: Number(progress?.elapsed_ms),
          remaining_budget_ms: Number(progress?.remaining_budget_ms),
          upstream_calls_made: Number(progress?.upstream_calls_made),
          companies_candidates_found: Number(progress?.companies_candidates_found),
          early_exit_triggered: Boolean(progress?.early_exit_triggered),
          last_heartbeat_at: primaryJob?.last_heartbeat_at || null,
          lock_expires_at: primaryJob?.lock_expires_at || null,
          locked_by: primaryJob?.locked_by || null,
          etag: primaryJob?._etag || primaryJob?.etag || null,
          storage: primaryJob?.storage || null,
        },
        inline_budget_ms: Number.isFinite(Number(primaryJob?.inline_budget_ms)) ? Number(primaryJob.inline_budget_ms) : 20_000,
        requested_deadline_ms:
          primaryJob?.requested_deadline_ms === null || primaryJob?.requested_deadline_ms === undefined
            ? null
            : Number.isFinite(Number(primaryJob.requested_deadline_ms))
              ? Number(primaryJob.requested_deadline_ms)
              : null,
        requested_stage_ms_primary:
          primaryJob?.requested_stage_ms_primary === null || primaryJob?.requested_stage_ms_primary === undefined
            ? null
            : Number.isFinite(Number(primaryJob.requested_stage_ms_primary))
              ? Number(primaryJob.requested_stage_ms_primary)
              : null,
        note:
          typeof primaryJob?.note === "string" && primaryJob.note.trim()
            ? primaryJob.note.trim()
            : "start endpoint is inline capped; long primary runs async",
        report,
      };

    // Fallback: if we ever observe a max-cycles blocked state, converge to terminal-only completion.
    // (This ensures we never return resume_needed=true + resume.status=blocked indefinitely.)
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

    const cap = stageBeaconValues.status_infra_retryable_only_timeout
      ? Math.max(MAX_RESUME_CYCLES_SINGLE, MAX_RESUME_CYCLES_SINGLE_TIMEOUT_ONLY)
      : MAX_RESUME_CYCLES_SINGLE;

    const cycleCount = Number(stageBeaconValues.status_resume_cycle_count || out?.resume_cycle_count || 0) || 0;

    // Never apply terminal-only completion while retryable missing remains AND cycles remain.
    // This prevents a stale persisted status_resume_terminal_only from incorrectly stopping resumable runs.
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

    if (!STATUS_NO_ORCHESTRATION && terminalOnlyReason) applyTerminalOnlyCompletion(out, terminalOnlyReason);
    else {
      // "complete" status can mean the *primary* job is finished, while enrichment may still be incomplete.
      // Only mark the overall import as completed when resume is not needed.
      out.completed = out.status === "complete" && out.resume_needed === false;
      out.terminal_only = false;

      if (out.completed) {
        out.resume = out.resume || {};
        out.resume.needed = false;
        out.resume.status = out.resume.status || "complete";
      }
    }

    // Reviews terminal contract: never return completed/terminal-only with reviews still pending.
    try {
      if ((out.completed || out.terminal_only) && Array.isArray(savedDocsForHealth)) {
        let finalized = 0;
        for (const doc of savedDocsForHealth) {
          if (finalizeReviewsForCompletion(doc, { reason: out.terminal_only ? terminalOnlyReason : "complete" })) {
            finalized += 1;
          }
        }
        if (finalized > 0) stageBeaconValues.status_reviews_finalized_on_completion = nowIso();
      }
    } catch {}

    return jsonWithSessionId(out, 200, req);
  }

  const mem = getImportSession(sessionId);
  if (mem) {
    stageBeaconValues.status_seen_session_memory = nowIso();
  }

  const { endpoint, key, databaseId, containerId } = getCosmosConfig();

  if (!endpoint || !key) {
    if (primaryJob) {
      return jsonWithSessionId(buildPrimaryJobNoCosmosResponse({ sessionId, primaryJob, stageBeaconValues }), 200, req);
    }

    if (mem) {
      return jsonWithSessionId(
        buildMemoryOnlyResponse({
          sessionId, mem, stageBeaconValues, gatewayKeyConfigured, internalAuthConfigured,
          buildResumeStallError, buildResumeAuthDiagnostics, sessionDoc: undefined, resumeDoc: undefined,
        }),
        200, req
      );
    }

    return jsonWithSessionId({ ok: false, error: "Unknown session_id", session_id: sessionId, ...EMPTY_RESUME_DIAGNOSTICS }, 404);
  }

  try {
    if (!CosmosClient) {
      if (mem) {
        return jsonWithSessionId(
          buildMemoryOnlyResponse({
            sessionId, mem, stageBeaconValues, gatewayKeyConfigured, internalAuthConfigured,
            buildResumeStallError, buildResumeAuthDiagnostics, sessionDoc: undefined, resumeDoc: undefined,
          }),
          200, req
        );
      }

      return jsonWithSessionId(
        {
          ok: false,
          session_id: sessionId,
          error: "Cosmos client module unavailable",
          code: "COSMOS_MODULE_MISSING",
          ...EMPTY_RESUME_DIAGNOSTICS,
        },
        200
      );
    }

    const client = new CosmosClient({ endpoint, key });
    const container = client.database(databaseId).container(containerId);

    const sessionDocId = `_import_session_${sessionId}`;
    const completionDocId = `_import_complete_${sessionId}`;
    const timeoutDocId = `_import_timeout_${sessionId}`;
    const stopDocId = `_import_stop_${sessionId}`;
    const errorDocId = `_import_error_${sessionId}`;
    const acceptDocId = `_import_accept_${sessionId}`;

    let [sessionDoc, completionDoc, timeoutDoc, stopDoc, errorDoc, acceptDoc, resumeDoc] = await Promise.all([
      readControlDoc(container, sessionDocId, sessionId),
      readControlDoc(container, completionDocId, sessionId),
      readControlDoc(container, timeoutDocId, sessionId),
      readControlDoc(container, stopDocId, sessionId),
      readControlDoc(container, errorDocId, sessionId),
      readControlDoc(container, acceptDocId, sessionId),
      readControlDoc(container, `_import_resume_${sessionId}`, sessionId),
    ]);

    let known = Boolean(sessionDoc || completionDoc || timeoutDoc || stopDoc || errorDoc || acceptDoc);
    if (!known && mem) known = true; // In-memory store knows this session
    if (!known) known = await hasAnyCompanyDocs(container, sessionId);

    if (!known) {
      return jsonWithSessionId({ ok: false, error: "Unknown session_id", session_id: sessionId, ...EMPTY_RESUME_DIAGNOSTICS }, 404);
    }

    stageBeaconValues.status_seen_control_docs = nowIso();

    // â”€â”€ Memory override: when the in-memory store has newer data than Cosmos â”€â”€
    // The same Azure Functions process may have updated the in-memory store
    // (via mark() or upsertImportSession()) but the Cosmos write may not have
    // replicated yet (new CosmosClient per request = no session consistency).
    if (mem) {
      if (!sessionDoc) {
        // Cosmos didn't find a session doc but memory has one â€” create a surrogate
        sessionDoc = {
          id: `_import_session_${sessionId}`,
          session_id: sessionId,
          stage_beacon: mem.stage_beacon || "init",
          status: mem.status || "running",
          saved: typeof mem.saved === "number" ? mem.saved : 0,
          saved_verified_count: typeof mem.saved_verified_count === "number" ? mem.saved_verified_count : 0,
          saved_company_ids_verified: Array.isArray(mem.saved_company_ids_verified) ? mem.saved_company_ids_verified : [],
          saved_company_ids_unverified: Array.isArray(mem.saved_company_ids_unverified) ? mem.saved_company_ids_unverified : [],
          resume_needed: typeof mem.resume_needed === "boolean" ? mem.resume_needed : false,
          request_id: mem.request_id || null,
          created_at: mem.created_at || nowIso(),
        };
        stageBeaconValues.status_mem_surrogate_session_doc = true;
      } else {
        // Cosmos found a session doc â€” check if memory has newer data
        const cosmosBeacon = String(sessionDoc.stage_beacon || "").trim();
        const memBeacon = String(mem.stage_beacon || "").trim();
        const memSaved = typeof mem.saved === "number" ? mem.saved : null;
        const cosmosSaved = typeof sessionDoc.saved === "number" ? sessionDoc.saved : null;

        // If Cosmos still shows "create_session" but memory has advanced further,
        // patch the session doc object with the in-memory values so downstream
        // computations use the freshest data.
        const STALE_BEACONS = new Set(["create_session", "init", ""]);
        if (STALE_BEACONS.has(cosmosBeacon) && memBeacon && !STALE_BEACONS.has(memBeacon)) {
          sessionDoc.stage_beacon = memBeacon;
          stageBeaconValues.status_mem_override_stage_beacon = memBeacon;
          stageBeaconValues.status_mem_override_cosmos_beacon = cosmosBeacon;
        }

        if ((cosmosSaved === null || cosmosSaved === 0) && memSaved !== null && memSaved > 0) {
          sessionDoc.saved = memSaved;
          stageBeaconValues.status_mem_override_saved = memSaved;
        }

        if (typeof mem.resume_needed === "boolean" && !sessionDoc.resume_needed && mem.resume_needed) {
          sessionDoc.resume_needed = mem.resume_needed;
          stageBeaconValues.status_mem_override_resume_needed = true;
        }

        // Merge verified IDs from memory if Cosmos has none
        if (
          (!Array.isArray(sessionDoc.saved_company_ids_verified) || sessionDoc.saved_company_ids_verified.length === 0) &&
          Array.isArray(mem.saved_company_ids_verified) && mem.saved_company_ids_verified.length > 0
        ) {
          sessionDoc.saved_company_ids_verified = mem.saved_company_ids_verified;
        }

        if (
          (typeof sessionDoc.saved_verified_count !== "number" || sessionDoc.saved_verified_count === 0) &&
          typeof mem.saved_verified_count === "number" && mem.saved_verified_count > 0
        ) {
          sessionDoc.saved_verified_count = mem.saved_verified_count;
        }
      }
    }

    // If Cosmos didn't find an accept doc but memory shows this session was accepted,
    // create a surrogate accept doc so the status response shows accepted: true.
    if (!acceptDoc && mem && mem.accepted) {
      acceptDoc = {
        id: `_import_accept_${sessionId}`,
        session_id: sessionId,
        accepted_at: mem.accepted_at || nowIso(),
        reason: mem.accepted_reason || "upstream_timeout_returning_202",
        stage_beacon: mem.stage_beacon || "unknown",
        created_at: mem.accepted_at || nowIso(),
      };
      stageBeaconValues.status_mem_surrogate_accept_doc = true;
    }

    const errorPayload = normalizeErrorPayload(errorDoc?.error || null);
    const timedOut = Boolean(timeoutDoc);
    const stopped = Boolean(stopDoc);
    const completed = Boolean(completionDoc);
    const completionOverride = Boolean(completionDoc && typeof completionDoc.completed_at === "string" && completionDoc.completed_at.trim());

    const effectiveResumeMeta = computeEffectiveResumeStatus({ resumeDoc, sessionDoc, stopDoc });
    effective_resume_status = effectiveResumeMeta.effective_resume_status;
    progress_notice = effectiveResumeMeta.progress_notice;

    const domainMeta = deriveDomainAndCreatedAfter({ sessionDoc, acceptDoc });

    const memVerifiedIds = Array.isArray(mem?.saved_company_ids_verified)
      ? mem.saved_company_ids_verified
      : Array.isArray(mem?.saved_ids)
        ? mem.saved_ids
        : [];

    const memUnverifiedIds = Array.isArray(mem?.saved_company_ids_unverified) ? mem.saved_company_ids_unverified : [];
    const memSavedCompanyUrls = Array.isArray(mem?.saved_company_urls) ? mem.saved_company_urls : [];

    const memSaveOutcome =
      typeof mem?.save_outcome === "string" && mem.save_outcome.trim() ? mem.save_outcome.trim() : null;

    const saveOutcomeRaw =
      typeof sessionDoc?.save_outcome === "string" && sessionDoc.save_outcome.trim()
        ? sessionDoc.save_outcome.trim()
        : typeof completionDoc?.save_outcome === "string" && completionDoc.save_outcome.trim()
          ? completionDoc.save_outcome.trim()
          : memSaveOutcome;

    let items = await fetchRecentCompanies(container, {
      sessionId,
      take,
      normalizedDomain: domainMeta.normalizedDomain,
      createdAfter: domainMeta.createdAfter,
    }).catch(() => []);
    const completionVerifiedIds = Array.isArray(completionDoc?.saved_company_ids_verified)
      ? completionDoc.saved_company_ids_verified
      : Array.isArray(completionDoc?.saved_ids)
        ? completionDoc.saved_ids
        : [];

    const sessionVerifiedIds = Array.isArray(sessionDoc?.saved_company_ids_verified)
      ? sessionDoc.saved_company_ids_verified
      : Array.isArray(sessionDoc?.saved_ids)
        ? sessionDoc.saved_ids
        : [];

    let savedIds = (completionVerifiedIds.length > 0
      ? completionVerifiedIds
      : sessionVerifiedIds.length > 0
        ? sessionVerifiedIds
        : memVerifiedIds)
      .map((id) => String(id || "").trim())
      .filter(Boolean);

    // Duplicate-detected reconciliation: the saved target can be an existing doc not linked to this session.
    // If the control-plane saved IDs didn't persist, fall back to normalized_domain lookups.
    if (
      savedIds.length === 0 &&
      typeof saveOutcomeRaw === "string" &&
      normalizeKey(saveOutcomeRaw).startsWith("duplicate_detected") &&
      domainMeta.normalizedDomain
    ) {
      const dupeDoc = await fetchCompanyByNormalizedDomain(container, domainMeta.normalizedDomain).catch(() => null);
      if (dupeDoc && dupeDoc.id) {
        savedIds = [String(dupeDoc.id).trim()].filter(Boolean);
        stageBeaconValues.status_reconciled_duplicate_by_domain = nowIso();
      }
    }

    const derivedVerifiedCount = savedIds.length;

    const savedVerifiedCount =
      (typeof completionDoc?.saved_verified_count === "number" ? completionDoc.saved_verified_count : null) ??
      (typeof sessionDoc?.saved_verified_count === "number" ? sessionDoc.saved_verified_count : null) ??
      (typeof mem?.saved_verified_count === "number" ? mem.saved_verified_count : null) ??
      (derivedVerifiedCount > 0 ? derivedVerifiedCount : null);

    const savedUnverifiedIdsRaw = Array.isArray(sessionDoc?.saved_company_ids_unverified)
      ? sessionDoc.saved_company_ids_unverified
      : memUnverifiedIds;

    const session = sessionDoc && typeof sessionDoc === "object" ? sessionDoc : {};
    session.saved_company_ids_verified = savedIds;
    session.saved_company_ids_unverified = savedUnverifiedIdsRaw;
    session.saved_verified_count = savedVerifiedCount;
    session.saved =
      (typeof completionDoc?.saved === "number" ? completionDoc.saved : null) ??
      (typeof sessionDoc?.saved === "number" ? sessionDoc.saved : null) ??
      0;

    // Canonical persisted ids computation. Never reference savedCompanies.
    const savedCompanyIdsVerified = Array.isArray(session?.saved_company_ids_verified)
      ? session.saved_company_ids_verified
      : [];

    const savedCompanyIdsUnverified = Array.isArray(session?.saved_company_ids_unverified)
      ? session.saved_company_ids_unverified
      : [];

    // Use case-insensitive id keys to avoid duplicates by casing, while preserving original id values.
    const persistedIds = Array.from(
      new Map(
        [...savedCompanyIdsVerified, ...savedCompanyIdsUnverified]
          .filter(Boolean)
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => [s.toLowerCase(), s])
      ).values()
    );

    const persistedCount = Math.max(
      persistedIds.length,
      Number(session?.saved_verified_count || 0),
      Number(session?.saved || 0),
      Array.isArray(session?.saved_companies) ? session.saved_companies.length : 0
    );

    // Persisted count includes verified + unverified saved ids.
    let saved = persistedCount;

    let savedDocs = persistedIds.length > 0 ? await fetchCompaniesByIds(container, persistedIds).catch(() => []) : [];

    // Ensure `items[]` always includes the saved target(s), even when the company doc is pre-existing and
    // therefore not linked to this session_id (e.g. save_outcome=duplicate_detected).
    if (Array.isArray(savedDocs) && savedDocs.length > 0) {
      if (!Array.isArray(items) || items.length === 0) {
        items = savedDocs;
        stageBeaconValues.status_items_from_saved_docs = nowIso();
      } else {
        const byId = new Map();
        for (const doc of [...items, ...savedDocs]) {
          const id = String(doc?.id || doc?.company_id || "").trim();
          if (!id) continue;
          if (!byId.has(id)) byId.set(id, doc);
        }
        items = Array.from(byId.values());
      }
    }

    const lowQualityMaxAttempts = Number.isFinite(Number(process.env.NON_GROK_LOW_QUALITY_MAX_ATTEMPTS))
      ? Math.max(1, Math.trunc(Number(process.env.NON_GROK_LOW_QUALITY_MAX_ATTEMPTS)))
      : 2;

    let reconciledLowQualityCount = 0;
    for (const doc of Array.isArray(savedDocs) ? savedDocs : []) {
      if (reconcileLowQualityToTerminal(doc, lowQualityMaxAttempts)) {
        reconciledLowQualityCount += 1;
      }
    }

    if (reconciledLowQualityCount > 0) {
      stageBeaconValues.status_reconciled_low_quality_terminal = nowIso();
      stageBeaconValues.status_reconciled_low_quality_terminal_count = reconciledLowQualityCount;

      const singleCompanyResultLowQuality = isSingleCompanyModeFromSessionWithReason({
        sessionDoc,
        savedCount: saved,
        itemsCount: savedDocs.length,
      });
      const singleCompanyMode = singleCompanyResultLowQuality.decision;

      // Definitive logging: show both inputs and decision at low quality reconciliation
      try {
        console.log("[import-status] single_company_decision_low_quality", {
          session_id: sessionId,
          ...singleCompanyResultLowQuality.inputs,
          decision_single_company_mode: singleCompanyResultLowQuality.decision,
          decision_reason: singleCompanyResultLowQuality.reason,
        });
      } catch {}

      if (singleCompanyMode) {
        for (const doc of Array.isArray(savedDocs) ? savedDocs : []) {
          try {
            await upsertDoc(container, { ...doc, updated_at: nowIso() });
          } catch {}
        }
      }
    }

    let saved_companies = savedDocs.length > 0 ? toSavedCompanies(savedDocs) : [];
    let completionReason = typeof completionDoc?.reason === "string" ? completionDoc.reason : null;

    let reconciled = false;
    let reconcile_strategy = null;
    let reconciled_saved_ids = [];

    // Authoritative reconciliation for control-plane vs data-plane mismatch (retroactive).
    if (Number(saved || 0) === 0) {
      stageBeaconValues.status_reconcile_saved_probe = nowIso();

      const authoritativeDocs = await fetchAuthoritativeSavedCompanies(container, {
        sessionId,
        sessionCreatedAt: domainMeta.sessionCreatedAt,
        normalizedDomain: domainMeta.normalizedDomain,
        createdAfter: domainMeta.createdAfter,
        limit: 200,
      }).catch(() => []);

      if (authoritativeDocs.length > 0) {
        const authoritativeIds = authoritativeDocs.map((d) => String(d?.id || "").trim()).filter(Boolean);
        const beaconForReason =
          (typeof acceptDoc?.stage_beacon === "string" && acceptDoc.stage_beacon.trim() ? acceptDoc.stage_beacon.trim() : "") ||
          (typeof sessionDoc?.stage_beacon === "string" && sessionDoc.stage_beacon.trim() ? sessionDoc.stage_beacon.trim() : "") ||
          (typeof completionDoc?.reason === "string" && completionDoc.reason.trim() ? completionDoc.reason.trim() : "");

        const reason =
          beaconForReason === "primary_early_exit" ? "saved_after_primary_async" : "post_primary_reconciliation";

        reconciled = true;
        reconcile_strategy = inferReconcileStrategy(authoritativeDocs, sessionId);
        reconciled_saved_ids = authoritativeIds;

        saved = authoritativeDocs.length;
        savedIds = authoritativeIds;
        savedDocs = authoritativeDocs;
        saved_companies = toSavedCompanies(authoritativeDocs);
        completionReason = reason;

        stageBeaconValues.status_reconciled_saved = nowIso();
        stageBeaconValues.status_reconciled_saved_count = saved;

        // Persist the corrected summary (best-effort)
        const now = nowIso();

        if (completionDoc) {
          await upsertDoc(container, {
            ...completionDoc,
            saved,
            saved_ids: authoritativeIds,
            reason,
            reconciled_at: now,
            updated_at: now,
          }).catch(() => null);
        }

        if (sessionDoc) {
          await upsertDoc(container, {
            ...sessionDoc,
            saved,
            companies_count: saved,
            reconciliation_reason: reason,
            reconciled_at: now,
            updated_at: now,
          }).catch(() => null);
        }
      } else {
        stageBeaconValues.status_reconciled_saved_none = nowIso();
      }
    }

    const lastCreatedAt = Array.isArray(items) && items.length > 0 ? String(items[0]?.created_at || "") : "";

    let stage_beacon =
      (typeof errorDoc?.stage === "string" && errorDoc.stage.trim() ? errorDoc.stage.trim() : null) ||
      (typeof errorDoc?.error?.step === "string" && errorDoc.error.step.trim() ? errorDoc.error.step.trim() : null) ||
      (typeof sessionDoc?.stage_beacon === "string" && sessionDoc.stage_beacon.trim() ? sessionDoc.stage_beacon.trim() : null) ||
      (typeof acceptDoc?.stage_beacon === "string" && acceptDoc.stage_beacon.trim() ? acceptDoc.stage_beacon.trim() : null) ||
      (completed ? "complete" : stopped ? "stopped" : "running");

    const cosmosTarget = (() => {
      const pick = (key) =>
        (sessionDoc && sessionDoc[key] != null ? sessionDoc[key] : null) ??
        (completionDoc && completionDoc[key] != null ? completionDoc[key] : null) ??
        (acceptDoc && acceptDoc[key] != null ? acceptDoc[key] : null) ??
        null;

      const diag = {
        cosmos_account_host_redacted: pick("cosmos_account_host_redacted"),
        cosmos_db_name: pick("cosmos_db_name"),
        cosmos_container_name: pick("cosmos_container_name"),
        cosmos_container_partition_key_path: pick("cosmos_container_partition_key_path"),
      };

      const hasAny = Object.values(diag).some((v) => typeof v === "string" ? v.trim() : v != null);
      return hasAny ? diag : null;
    })();

    const report = {
      session: sessionDoc
        ? {
            created_at: sessionDoc?.created_at || null,
            request_id: sessionDoc?.request_id || null,
            status: sessionDoc?.status || null,
            stage_beacon: sessionDoc?.stage_beacon || null,
            resume_needed: Boolean(sessionDoc?.resume_needed),
          }
        : null,
      accepted: Boolean(acceptDoc),
      accept: acceptDoc
        ? {
            accepted_at: acceptDoc?.accepted_at || acceptDoc?.created_at || null,
            reason: acceptDoc?.reason || null,
            stage_beacon: acceptDoc?.stage_beacon || null,
            remaining_ms: Number.isFinite(Number(acceptDoc?.remaining_ms)) ? Number(acceptDoc.remaining_ms) : null,
          }
        : null,
      completion: completionDoc
        ? {
            completed_at: completionDoc?.completed_at || completionDoc?.created_at || null,
            reason: completionReason || null,
            saved: typeof completionDoc?.saved === "number" ? completionDoc.saved : null,
            skipped: typeof completionDoc?.skipped === "number" ? completionDoc.skipped : null,
            failed: typeof completionDoc?.failed === "number" ? completionDoc.failed : null,
            saved_ids: savedIds,
            skipped_ids: Array.isArray(completionDoc?.skipped_ids) ? completionDoc.skipped_ids : [],
            failed_items: Array.isArray(completionDoc?.failed_items) ? completionDoc.failed_items : [],
          }
        : null,
      resume: resumeDoc
        ? {
            status: resumeDoc?.status || null,
            attempt: Number.isFinite(Number(resumeDoc?.attempt)) ? Number(resumeDoc.attempt) : 0,
            lock_expires_at: resumeDoc?.lock_expires_at || null,
            updated_at: resumeDoc?.updated_at || null,
          }
        : null,
    };

    const enrichment_health_summary = summarizeEnrichmentHealth(saved_companies);

    const resumeMissingAnalysis = analyzeMissingFieldsForResume(savedDocs);
    const resumeNeededFromHealth = resumeMissingAnalysis.total_retryable_missing > 0;

    const sessionStatus = typeof sessionDoc?.status === "string" ? sessionDoc.status.trim() : "";

    const retryableMissingCount = Number(resumeMissingAnalysis?.total_retryable_missing || 0) || 0;

    // resume_needed is derived from retryable missing fields only; it must not drift.
    let resume_needed = forceResume ? true : retryableMissingCount > 0;

    // Mutable resume_error / resume_error_details for the Cosmos-backed path.
    // These are assigned during the single-company policy check (lines ~4658, ~4855)
    // and read in the response object (lines ~5363, ~5639, etc.).
    let resume_error = null;
    let resume_error_details = null;

    // If the session is actively processing (not yet complete/errored), don't let
    // resume_needed=false prematurely signal completion.  The session may still be
    // saving companies and the saved count may be 0 simply because the first status
    // poll raced ahead of import-start.
    const ACTIVE_PROCESSING_BEACONS = new Set([
      "create_session", "init",
      "xai_primary_fetch_start", "xai_primary_fetch_done",
      "xai_primary_fallback_company_url_seed",
      "seed_saved_enriching_async", "fast_path_202_accepted",
    ]);

    if (
      !resume_needed &&
      !completed &&
      !stopped &&
      !timedOut &&
      Number(saved || 0) === 0 &&
      ACTIVE_PROCESSING_BEACONS.has(String(stage_beacon || "").trim())
    ) {
      resume_needed = true;
      stageBeaconValues.status_active_processing_resume_override = String(stage_beacon || "").trim();
    }

    const forceComplete = Boolean(
      stageBeaconValues.status_resume_terminal_only ||
        (!forceResume && Number(saved || 0) > 0 && retryableMissingCount === 0) ||
        resumeMissingAnalysis.terminal_only ||
        ((sessionStatus === "complete" || stage_beacon === "complete") && !resume_needed) ||
        stage_beacon === "status_resume_terminal_only"
    );

    if (forceComplete) {
      stage_beacon =
        stage_beacon === "status_resume_terminal_only" || sessionDoc?.stage_beacon === "status_resume_terminal_only"
          ? "status_resume_terminal_only"
          : "complete";
    }

    stageBeaconValues.status_resume_missing_total = resumeMissingAnalysis.total_missing;
    stageBeaconValues.status_resume_missing_retryable = resumeMissingAnalysis.total_retryable_missing;
    stageBeaconValues.status_resume_missing_terminal = resumeMissingAnalysis.total_terminal_missing;
    if (resumeMissingAnalysis.terminal_only) stageBeaconValues.status_resume_terminal_only = nowIso();

    const missing_by_company = saved_companies
      .filter((c) => Array.isArray(c?.enrichment_health?.missing_fields) && c.enrichment_health.missing_fields.length > 0)
      .map((c) => ({
        company_id: c.company_id,
        company_name: c.company_name,
        website_url: c.website_url,
        missing_fields: c.enrichment_health.missing_fields,
      }));

    const resumeDocStatus =
      typeof resumeDoc !== "undefined" && resumeDoc && typeof resumeDoc.status === "string" ? resumeDoc.status.trim() : "";
    const forceTerminalComplete = resumeDocStatus === "complete" && resumeMissingAnalysis.total_retryable_missing === 0;

    // Terminal-only missing fields must not keep the session "running".

    if ((resumeMissingAnalysis.terminal_only || forceTerminalComplete) && sessionDoc && sessionDoc.resume_needed) {
      const now = nowIso();
      sessionDoc.resume_needed = false;
      sessionDoc.status = "complete";
      sessionDoc.stage_beacon = "complete";
      sessionDoc.updated_at = now;
      await upsertDoc(container, { ...sessionDoc }).catch(() => null);
    }

    let resume_doc_created = false;
    let resume_triggered = false;
    let resume_trigger_error = null;
    let resume_trigger_error_details = null;
    let resume_gateway_key_attached = null;
    let resume_trigger_request_id = null;

    resume_status = null;
    const resumeStalledByGatewayAuth = Boolean(resume_needed && !gatewayKeyConfigured);

    if (resume_needed) {
      try {
        const resumeDocId = `_import_resume_${sessionId}`;
        let currentResume = typeof resumeDoc !== "undefined" ? resumeDoc : null;

        if (!currentResume && !STATUS_NO_ORCHESTRATION) {
          const now = nowIso();
          await upsertDoc(container, {
            id: resumeDocId,
            session_id: sessionId,
            normalized_domain: "import",
            partition_key: "import",
            type: "import_control",
            created_at: now,
            updated_at: now,
            status: resumeStalledByGatewayAuth ? "stalled" : "queued",
            resume_auth: buildResumeAuthDiagnostics(),
            ...(resumeStalledByGatewayAuth
              ? {
                  stalled_at: now,
                  last_error: buildResumeStallError(),
                }
              : {}),
            missing_by_company,
          }).catch(() => null);
          resume_doc_created = true;

          currentResume = await readControlDoc(container, resumeDocId, sessionId).catch(() => null);
        }

        let resumeStatus = String(currentResume?.status || "").trim();
        let lockUntil = Date.parse(String(currentResume?.lock_expires_at || "")) || 0;

        // Drift repair: if retryable missing fields still exist but the resume control doc says "complete",
        // reopen it so /import/status polling can keep auto-driving enrichment without requiring a manual click.
        if (!STATUS_NO_ORCHESTRATION && !forceResume && resume_needed && resumeStatus === "complete") {
          const reopenedAt = nowIso();
          stageBeaconValues.status_resume_reopened_from_complete = reopenedAt;
          resumeStatus = "queued";
          lockUntil = 0;

          await upsertDoc(container, {
            ...(currentResume && typeof currentResume === "object" ? currentResume : {}),
            status: "queued",
            resume_error: null,
            resume_error_details: null,
            blocked_at: null,
            blocked_reason: null,
            last_error: null,
            lock_expires_at: null,
            updated_at: reopenedAt,
            missing_by_company,
          }).catch(() => null);

          if (sessionDoc && typeof sessionDoc === "object") {
            const sessionStatusRaw = String(sessionDoc?.status || "").trim();
            if (sessionStatusRaw === "complete") {
              sessionDoc.status = "running";
              sessionDoc.stage_beacon = "enrichment_incomplete_retryable";
              sessionDoc.updated_at = reopenedAt;
              sessionDoc.resume_needed = true;
              await upsertDoc(container, { ...sessionDoc }).catch(() => null);
            }
          }
        }

        if (resumeStalledByGatewayAuth) {
          const stalledAt = nowIso();
          const stall = buildResumeStallError();
          resumeStatus = "stalled";

          await upsertDoc(container, {
            ...currentResume,
            status: "stalled",
            stalled_at: stalledAt,
            resume_auth: buildResumeAuthDiagnostics(),
            last_error: buildResumeStallError(),
            lock_expires_at: null,
            updated_at: stalledAt,
          }).catch(() => null);

          if (sessionDoc && typeof sessionDoc === "object") {
            const details = {
              root_cause: stall.root_cause,
              message: stall.message,
              missing_gateway_key: Boolean(stall.missing_gateway_key),
              missing_internal_secret: Boolean(stall.missing_internal_secret),
              ...buildResumeAuthDiagnostics(),
              updated_at: stalledAt,
            };

            // Ensure subsequent response shaping reads the deterministic failure signals.
            sessionDoc.resume_error = stall.code;
            sessionDoc.resume_error_details = details;
            sessionDoc.resume_worker_last_http_status = 401;
            sessionDoc.resume_worker_last_reject_layer = "gateway";

            await upsertDoc(container, {
              ...sessionDoc,
              resume_error: stall.code,
              resume_error_details: details,
              resume_needed: true,
              resume_worker_last_http_status: 401,
              resume_worker_last_reject_layer: "gateway",
              updated_at: stalledAt,
            }).catch(() => null);
          }
        }

        resume_status = resumeStatus;

        let canTrigger = !resumeStalledByGatewayAuth && (!lockUntil || Date.now() >= lockUntil);

        // Persisted blocked state: once blocked, /import/status must not keep auto-triggering the worker.
        // The worker may only resume via a manual force_resume=1 request (or future health-check/backoff logic).
        //
        // Exception: do NOT treat resume_no_progress_no_attempts as a hard block if we have evidence the resume-worker
        // entered recently (heartbeat/handler_entered_at) or we can explain "no attempts" via planner/budget state.
        if (!forceResume && resumeStatus === "blocked") {
          const activeResume = typeof currentResume !== "undefined" ? currentResume : resumeDoc;
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

            const sessionDocForUnblock = await readControlDoc(container, `_import_session_${sessionId}`, sessionId).catch(() => null);

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
              stageBeaconValues.status_resume_unblocked_planner_no_action = unblockedAt;

              if (activeResume && typeof activeResume === "object") {
                await upsertDoc(container, {
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
                await upsertDoc(container, {
                  ...sessionDocForUnblock,
                  resume_error: null,
                  resume_error_details: null,
                  // Keep session non-terminal; resume is still needed.
                  status: sessionDocForUnblock?.status === "complete" ? "running" : (sessionDocForUnblock?.status || "running"),
                  updated_at: unblockedAt,
                }).catch(() => null);
              }

              resumeStatus = "queued";
              resume_status = "queued";
            } else {
              stageBeaconValues.status_resume_blocked_auto_retry = nowIso();
            }
          } else {
            stageBeaconValues.status_resume_blocked_auto_retry = nowIso();
          }
        }

        const resumeStuckQueuedMs = Number.isFinite(Number(process.env.RESUME_STUCK_QUEUED_MS))
          ? Math.max(30_000, Math.trunc(Number(process.env.RESUME_STUCK_QUEUED_MS)))
          : 180_000;

        let watchdog_stuck_queued = false;
        let watchdog_last_finished_at = null;

        try {
          const sessionDocId = `_import_session_${sessionId}`;
          const sessionDocForWatchdog = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);
          watchdog_last_finished_at = sessionDocForWatchdog?.resume_worker_last_finished_at || null;

          const prevWatchdogAt =
            typeof sessionDocForWatchdog?.resume_worker_watchdog_stuck_queued_at === "string"
              ? sessionDocForWatchdog.resume_worker_watchdog_stuck_queued_at
              : null;

          const prevWatchdogTs = Date.parse(String(prevWatchdogAt || "")) || 0;
          const lastEnteredAt = sessionDocForWatchdog?.resume_worker_handler_entered_at || null;
          const lastEnteredTs = Date.parse(String(lastEnteredAt || "")) || 0;

          // Second-stage watchdog: if watchdog fired at time T, the very next status poll must observe a handler re-entry.
          if (prevWatchdogTs && resume_needed && resumeStatus === "queued" && (!lastEnteredTs || lastEnteredTs < prevWatchdogTs)) {
            const blockedAt = nowIso();
            stageBeaconValues.status_resume_watchdog_stuck_queued_no_progress = blockedAt;

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
            // Keep resume queued and allow /import/status to re-trigger resume-worker (with cooldown) automatically.
            resume_error = errorCode;
            resume_error_details = details;

            resume_trigger_error ||= errorCode;
            resume_trigger_error_details ||= details;

            stageBeaconValues.status_resume_watchdog_retry_at = blockedAt;

            if (sessionDoc && typeof sessionDoc === "object") {
              sessionDoc.resume_error = errorCode;
              sessionDoc.resume_error_details = details;
            }
          } else if (
            prevWatchdogTs &&
            lastEnteredTs &&
            lastEnteredTs >= prevWatchdogTs &&
            sessionDocForWatchdog &&
            typeof sessionDocForWatchdog === "object"
          ) {
            // Worker re-entered after the watchdog fired; clear marker so it can fire again if needed.
            await upsertDoc(container, {
              ...sessionDocForWatchdog,
              resume_worker_watchdog_stuck_queued_at: null,
              resume_worker_watchdog_resolved_at: nowIso(),
              updated_at: nowIso(),
            }).catch(() => null);
          }

          const lastFinishedTs = Date.parse(String(watchdog_last_finished_at || "")) || 0;

          if (resume_needed && resumeStatus === "queued" && lastFinishedTs && Date.now() - lastFinishedTs > resumeStuckQueuedMs) {
            watchdog_stuck_queued = true;
            const watchdogFiredAt = nowIso();
            stageBeaconValues.status_resume_watchdog_stuck_queued = watchdogFiredAt;

            if (sessionDocForWatchdog && typeof sessionDocForWatchdog === "object") {
              await upsertDoc(container, {
                ...sessionDocForWatchdog,
                resume_worker_watchdog_stuck_queued_at: watchdogFiredAt,
                resume_worker_watchdog_last_finished_at: watchdog_last_finished_at,
                updated_at: nowIso(),
              }).catch(() => null);
            }
          }
        } catch {}

        if (canTrigger && (resumeStatus === "queued" || resumeStatus === "blocked") && !forceResume) {
          const cooldownMs = 60_000;
          let lastTriggeredTs = 0;

          try {
            const sessionDocId = `_import_session_${sessionId}`;
            const sessionDocForTrigger = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);
            lastTriggeredTs = Date.parse(String(sessionDocForTrigger?.resume_worker_last_triggered_at || "")) || 0;
          } catch {}

          if (lastTriggeredTs && Date.now() - lastTriggeredTs < cooldownMs) {
            canTrigger = false;
            stageBeaconValues.status_resume_trigger_cooldown = nowIso();
            stageBeaconValues.status_resume_next_allowed_at = new Date(lastTriggeredTs + cooldownMs).toISOString();
          }
        }

        // Single-company deterministic termination: if we're stuck queued (or we've hit the cycle cap),
        // force terminal-only completion instead of allowing indefinite resume_needed=true.
        try {
          const sessionDocId = `_import_session_${sessionId}`;
          const sessionDocForPolicy = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);

          // Use extended function to get decision reason for definitive logging
          const singleCompanyResult = isSingleCompanyModeFromSessionWithReason({
            sessionDoc: sessionDocForPolicy,
            savedCount: saved,
            itemsCount: Array.isArray(saved_companies) ? saved_companies.length : 0,
          });
          const singleCompanyMode = singleCompanyResult.decision;

          // Definitive logging: show both inputs and decision at time of policy check
          try {
            console.log("[import-status] single_company_decision", {
              session_id: sessionId,
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
          const queued = resumeStatus === "queued" && resume_needed === true;
          const noRecentProgress = !hasRecentWorkerProgress(resumeWorkerForProgress, nowMs, resumeStuckQueuedMs);
          const activelyProcessing = Boolean(stageBeaconValues.status_active_processing_resume_override);
          const shouldForceByQueuedTimeout = Boolean(singleCompanyMode && queued && noRecentProgress && retryableMissingCount === 0 && !activelyProcessing);

          stageBeaconValues.status_single_company_mode = Boolean(singleCompanyMode);
          stageBeaconValues.status_resume_cycle_count = currentCycleCount;
          stageBeaconValues.status_resume_queued = queued;
          stageBeaconValues.status_resume_no_recent_worker_progress = noRecentProgress;
          stageBeaconValues.status_resume_stuck_ms = resumeStuckQueuedMs;
          stageBeaconValues.status_resume_worker_last_finished_at = resumeWorkerForProgress.last_finished_at;
          stageBeaconValues.status_resume_worker_handler_entered_at = resumeWorkerForProgress.handler_entered_at;
          stageBeaconValues.status_resume_should_force_by_queued_timeout = shouldForceByQueuedTimeout;
          if (activelyProcessing) stageBeaconValues.status_resume_force_skip_actively_processing = true;

          const docsForInfra =
            typeof savedDocsForHealth !== "undefined"
              ? savedDocsForHealth
              : typeof savedDocs !== "undefined"
                ? savedDocs
                : [];

          const infraRetryableAtPolicy = collectInfraRetryableMissing(docsForInfra);
          const infraOnlyTimeout =
            infraRetryableAtPolicy.length > 0 &&
            infraRetryableAtPolicy.every((x) => normalizeKey(x?.missing_reason) === "upstream_timeout");

          stageBeaconValues.status_infra_retryable_missing_count = infraRetryableAtPolicy.length;
          stageBeaconValues.status_infra_retryable_only_timeout = infraOnlyTimeout;

          // Enforce the cap only once it is actually reached.
          // (resume-worker increments resume_cycle_count on entry; allowing a final cycle at count==max is expected.)
          const preTriggerCap = Boolean(
            singleCompanyMode &&
              resume_needed &&
              currentCycleCount >= MAX_RESUME_CYCLES_SINGLE &&
              !infraOnlyTimeout
          );
          const watchdogNoProgress = Boolean(stageBeaconValues.status_resume_watchdog_stuck_queued_no_progress);

          const forceDecision = preTriggerCap
            ? { force: true, reason: "max_cycles" }
            : watchdogNoProgress && singleCompanyMode && queued && retryableMissingCount === 0
              ? { force: true, reason: "watchdog_no_progress" }
              : shouldForceByQueuedTimeout
                ? { force: true, reason: "queued_timeout_no_progress" }
                : shouldForceTerminalizeSingle({
                    single: singleCompanyMode,
                    resume_needed,
                    resume_status: resumeStatus,
                    resume_cycle_count: sessionDocForPolicy?.resume_cycle_count,
                    resume_worker: resumeWorkerForProgress,
                    resume_stuck_ms: resumeStuckQueuedMs,
                    infra_only_timeout: infraOnlyTimeout,
                    retryable_missing_count: retryableMissingCount,
                    actively_processing: activelyProcessing,
                  });

          // Instrumentation for max-cycles stalls (and other force-terminalize policies).
          stageBeaconValues.status_resume_force_terminalize_selected = !STATUS_NO_ORCHESTRATION && Boolean(forceDecision.force);
          if (!forceDecision.force) {
            const cap = infraOnlyTimeout
              ? Math.max(MAX_RESUME_CYCLES_SINGLE, MAX_RESUME_CYCLES_SINGLE_TIMEOUT_ONLY)
              : MAX_RESUME_CYCLES_SINGLE;
            stageBeaconValues.status_resume_force_terminalize_skip_reason = !singleCompanyMode
              ? "not_single_company_mode"
              : !resume_needed
                ? "resume_not_needed"
                : currentCycleCount + 1 < cap
                  ? "below_cycle_cap"
                  : infraOnlyTimeout
                    ? "infra_timeout_only"
                    : "policy_not_met";
          } else {
            stageBeaconValues.status_resume_force_terminalize_skip_reason = null;
          }

          if (!STATUS_NO_ORCHESTRATION && forceDecision.force) {
            const forcedAt = nowIso();
            stageBeaconValues.status_resume_blocked_reason = forceDecision.reason;

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

            stageBeaconValues.status_resume_blocked = forcedAt;
            stageBeaconValues.status_resume_blocked_code = errorCode;

            resume_error = errorCode;
            resume_error_details = details;

            // Deterministic convergence: if the policy says we cannot keep retrying, force terminalization
            // so the session reaches a stable terminal state without manual intervention.
            stageBeaconValues.status_resume_forced_terminalize = forcedAt;
            stageBeaconValues.status_resume_forced_terminalize_reason = forceDecision.reason;

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

            resume_triggered = Boolean(forceRes?.ok);
            resume_gateway_key_attached = Boolean(forceRes?.gateway_key_attached);
            resume_trigger_request_id = forceRes?.request_id || workerRequest.request_id;

            stageBeaconValues.status_resume_terminal_only = forcedAt;

            resume_error = null;
            resume_error_details = null;
            resume_trigger_error = null;
            resume_trigger_error_details = null;

            resume_needed = false;
            resume_status = "complete";
            resumeStatus = "complete";
            canTrigger = false;

            // Best-effort: persist stable terminal state onto the session doc so the UI
            // can rely on a single canonical completion beacon.
            try {
              const sessionDocId = `_import_session_${sessionId}`;
              const sessionDocForTerminal = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);
              if (sessionDocForTerminal && typeof sessionDocForTerminal === "object") {
                await upsertDoc(container, {
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

              const resumeDocId = `_import_resume_${sessionId}`;
              const resumeDocForTerminal = await readControlDoc(container, resumeDocId, sessionId).catch(() => null);
              if (resumeDocForTerminal && typeof resumeDocForTerminal === "object") {
                await upsertDoc(container, {
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

        if (!STATUS_NO_ORCHESTRATION &&
          canTrigger &&
          (resumeStatus === "queued" || resumeStatus === "blocked" || resumeStatus === "error" || resumeStatus === "stalled" || (forceResume && resumeStatus !== "running"))
        ) {
          const triggerAttemptAt = nowIso();
          stageBeaconValues.status_trigger_resume_worker = triggerAttemptAt;

          const workerRequest = buildInternalFetchRequest({
            job_kind: "import_resume",
          });

          // Dedupe guard: record that we attempted a trigger so repeated /import/status polling
          // doesn't spam resume-worker invocations while the resume doc is queued.
          try {
            const sessionDocId = `_import_session_${sessionId}`;
            const sessionDocForTrigger = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);
            if (sessionDocForTrigger && typeof sessionDocForTrigger === "object") {
              await upsertDoc(container, {
                ...sessionDocForTrigger,
                resume_worker_last_triggered_at: triggerAttemptAt,
                resume_last_triggered_at: triggerAttemptAt,
                // NOTE: resume_cycle_count is incremented by the resume-worker itself.
                // This keeps "cycles" aligned with real worker runs rather than status poll trigger attempts.
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
                session_id: sessionId,
                context,
                workerRequest,
                deadline_ms: INLINE_RESUME_DEADLINE_MS,
              });

              resume_gateway_key_attached = Boolean(invokeRes.gateway_key_attached);
              resume_trigger_request_id = invokeRes.request_id || workerRequest.request_id;

              return {
                ok: Boolean(invokeRes.ok),
                status: Number(invokeRes.status || 0) || 0,
                text: async () => String(invokeRes.bodyText || ""),
                _error: invokeRes.error,
              };
            } catch (e) {
              resume_gateway_key_attached = Boolean(workerRequest.gateway_key_attached);
              resume_trigger_request_id = workerRequest.request_id;
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
            bodySessionId === sessionId &&
            Boolean(enteredAtFromBody) &&
            enteredTimeOk;

          const triggerNoopOrNoEnter = Boolean(workerRes?.ok) && responseOk !== false && !strongTriggerOk;
          const triggerOk = strongTriggerOk;

          resume_triggered = triggerOk;

          const triggerResult = {
            ok: triggerOk,
            invocation: "in_process",
            http_status: statusCode,
            triggered_at: triggerAttemptAt,
            request_id: resume_trigger_request_id || null,
            gateway_key_attached: Boolean(resume_gateway_key_attached),
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

            resume_trigger_error = watchdog_stuck_queued ? "resume_worker_stuck_or_trigger_failed" : baseErr;
            resume_trigger_error_details = {
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
            const sessionDocId = `_import_session_${sessionId}`;
            const sessionDocAfter = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);

            const enteredTs = Date.parse(String(sessionDocAfter?.resume_worker_handler_entered_at || "")) || 0;
            const attemptTs = Date.parse(String(triggerAttemptAt || "")) || Date.now();

            const rejectLayer =
              statusCode === 401
                ? enteredTs && enteredTs >= attemptTs - 5000
                  ? "handler"
                  : "gateway"
                : null;

            if (sessionDocAfter && typeof sessionDocAfter === "object") {
              await upsertDoc(container, {
                ...sessionDocAfter,
                resume_worker_last_trigger_result: triggerResult,
                resume_worker_last_trigger_ok: triggerOk,
                resume_worker_last_trigger_http_status: statusCode,
                resume_worker_last_trigger_request_id: resume_trigger_request_id || null,
                resume_worker_last_gateway_key_attached: Boolean(resume_gateway_key_attached),
                ...(triggerOk
                  ? {}
                  : {
                      resume_error: String(resume_trigger_error || "").trim() || "resume_worker_trigger_failed",
                      resume_error_details:
                        resume_trigger_error_details && typeof resume_trigger_error_details === "object" ? resume_trigger_error_details : null,
                      resume_needed: true,
                      resume_worker_last_http_status: statusCode,
                      resume_worker_last_reject_layer: rejectLayer,
                    }),
                updated_at: nowIso(),
              }).catch(() => null);

              // After resume-worker completes, refresh saved_company_ids from the updated session doc
              // This fixes the timing race where the response would show stale zeros
              if (triggerOk && Array.isArray(sessionDocAfter.saved_company_ids_verified) && sessionDocAfter.saved_company_ids_verified.length > 0) {
                saved_company_ids_verified = sessionDocAfter.saved_company_ids_verified;
                if (typeof sessionDocAfter.saved_verified_count === "number" && Number.isFinite(sessionDocAfter.saved_verified_count)) {
                  saved_verified_count = sessionDocAfter.saved_verified_count;
                } else {
                  saved_verified_count = saved_company_ids_verified.length;
                }
              }
            }
          } catch {}

          if (watchdog_stuck_queued && !triggerOk) {
            const erroredAt = nowIso();
            resume_status = "error";

            try {
              const resumeDoc = await readControlDoc(container, resumeDocId, sessionId).catch(() => null);
              if (resumeDoc && typeof resumeDoc === "object") {
                await upsertDoc(container, {
                  ...resumeDoc,
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
              const sessionDocId = `_import_session_${sessionId}`;
              const sessionDocAfter = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);
              if (sessionDocAfter && typeof sessionDocAfter === "object") {
                await upsertDoc(container, {
                  ...sessionDocAfter,
                  resume_error: "resume_worker_stuck_or_trigger_failed",
                  resume_error_details: {
                    ...((resume_trigger_error_details && typeof resume_trigger_error_details === "object")
                      ? resume_trigger_error_details
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
      } catch (e) {
        resume_trigger_error = e?.message || String(e);
      }

      if (resume_trigger_error && sessionDoc) {
        const now = nowIso();
        await upsertDoc(container, {
          ...sessionDoc,
          resume_error: String(resume_trigger_error || "").trim(),
          resume_error_details:
            resume_trigger_error_details && typeof resume_trigger_error_details === "object" ? resume_trigger_error_details : null,
          resume_error_at: now,
          updated_at: now,
        }).catch(() => null);
      }
    }

    // Stage beacon must reflect resume control doc status so the UI can back off polling.
    const blockedReasonFromBeacon =
      typeof stageBeaconValues?.status_resume_blocked_reason === "string" && stageBeaconValues.status_resume_blocked_reason.trim()
        ? stageBeaconValues.status_resume_blocked_reason.trim()
        : stageBeaconValues?.status_resume_watchdog_stuck_queued_no_progress
          ? "watchdog_no_progress"
          : null;

    const blockedCodeFromBeacon =
      typeof stageBeaconValues?.status_resume_blocked_code === "string" && stageBeaconValues.status_resume_blocked_code.trim()
        ? stageBeaconValues.status_resume_blocked_code.trim()
        : null;

    if (!forceComplete && resume_needed && blockedReasonFromBeacon) {
      resume_status = "blocked";
      if (!sessionDoc?.resume_error && blockedCodeFromBeacon && sessionDoc && typeof sessionDoc === "object") {
        sessionDoc.resume_error = blockedCodeFromBeacon;
      }
      if (!sessionDoc?.resume_error_details && sessionDoc && typeof sessionDoc === "object") {
        sessionDoc.resume_error_details = {
          forced_by: blockedReasonFromBeacon,
          blocked_reason: blockedReasonFromBeacon,
          blocked_code: blockedCodeFromBeacon,
          blocked_at: stageBeaconValues.status_resume_blocked || nowIso(),
          updated_at: nowIso(),
        };
      }
    }

    const persistedResumeDocStatus =
      typeof resumeDoc !== "undefined" && resumeDoc && typeof resumeDoc.status === "string" ? resumeDoc.status.trim() : "";

    if (!forceComplete && resume_needed && persistedResumeDocStatus === "blocked") {
      resume_status = "blocked";
    }

    const resumeStatusForBeacon = String(resume_status || "").trim();

    const resumeStageBeacon = (() => {
      if (!forceComplete && !resume_needed) return null;
      if (resumeStatusForBeacon === "blocked") return "enrichment_resume_blocked";
      if (resumeStatusForBeacon === "queued") return "enrichment_resume_queued";
      if (resumeStatusForBeacon === "running") return "enrichment_resume_running";
      if (resumeStatusForBeacon === "stalled") return "enrichment_resume_stalled";
      if (resumeStatusForBeacon === "error") return "enrichment_resume_error";
      if (retryableMissingCount > 0) return "enrichment_incomplete_retryable";
      return "complete";
    })();

    if (!forceComplete) {
      stage_beacon = resumeStageBeacon || stage_beacon;
    }

    const effectiveCompleted = forceComplete || (completed && !resume_needed);

    const saved_verified_count =
      sessionDoc && typeof sessionDoc.saved_verified_count === "number" && Number.isFinite(sessionDoc.saved_verified_count)
        ? sessionDoc.saved_verified_count
        : Number.isFinite(Number(savedVerifiedCount))
          ? Number(savedVerifiedCount)
          : Number(saved || 0) || 0;

    const saved_company_ids_verified = Array.isArray(sessionDoc?.saved_company_ids_verified)
      ? sessionDoc.saved_company_ids_verified
      : Array.isArray(savedIds)
        ? savedIds
        : [];

    const saved_company_ids_unverified = Array.isArray(sessionDoc?.saved_company_ids_unverified)
      ? sessionDoc.saved_company_ids_unverified
      : memUnverifiedIds;

    const save_outcome =
      typeof sessionDoc?.save_outcome === "string" && sessionDoc.save_outcome.trim()
        ? sessionDoc.save_outcome.trim()
        : typeof completionDoc?.save_outcome === "string" && completionDoc.save_outcome.trim()
          ? completionDoc.save_outcome.trim()
          : memSaveOutcome;

    const saved_company_urls_raw = Array.isArray(sessionDoc?.saved_company_urls)
      ? sessionDoc.saved_company_urls
      : Array.isArray(completionDoc?.saved_company_urls)
        ? completionDoc.saved_company_urls
        : memSavedCompanyUrls;

    const saved_company_urls =
      Array.isArray(saved_company_urls_raw) && saved_company_urls_raw.length > 0
        ? saved_company_urls_raw
        : (Array.isArray(savedDocs) ? savedDocs : [])
            .map((d) => String(d?.website_url || d?.url || d?.canonical_url || "").trim())
            .filter(Boolean)
            .slice(0, 50);

    // NOTE: These MUST use different names from the `let resume_error` / `let resume_error_details`
    // declared earlier in the primary-job block (line ~1763). Using `const resume_error` here
    // caused a TDZ ReferenceError at line ~4855 where `resume_error = errorCode` was assigned
    // before this `const` initialization point.
    const sessionDoc_resume_error =
      typeof sessionDoc?.resume_error === "string" && sessionDoc.resume_error.trim() ? sessionDoc.resume_error.trim() : null;

    const sessionDoc_resume_error_details =
      sessionDoc?.resume_error_details && typeof sessionDoc.resume_error_details === "object" ? sessionDoc.resume_error_details : null;

    const requestObj = sessionDoc?.request && typeof sessionDoc.request === "object" ? sessionDoc.request : null;
    const requestQueryTypes = Array.isArray(requestObj?.queryTypes)
      ? requestObj.queryTypes.map((t) => String(t || "").trim()).filter(Boolean)
      : [];
    const isCompanyUrlImport = requestQueryTypes.includes("company_url");

    // IMPORTANT: _import_timeout_* is a control-doc signal that the *client/start handler* hit a deadline.
    // It must never be treated as a hard job failure, because resume cycles may still be queued/running.
    if (errorPayload || stopped) {
      const errorOut = errorPayload || (stopped ? { code: "IMPORT_STOPPED", message: "Import was stopped" } : null);

      const out = {
          ok: true,
          session_id: sessionId,
          status: "error",
          state: "failed",
          job_state: null,
          stage_beacon,
          stage_beacon_values: stageBeaconValues,
          ...(cosmosTarget ? cosmosTarget : {}),
          primary_job_state: null,
          elapsed_ms: null,
          remaining_budget_ms: null,
          upstream_calls_made: Math.max(
            typeof sessionDoc !== "undefined" && sessionDoc && Number.isFinite(Number(sessionDoc?.resume_worker_upstream_calls_made))
              ? Number(sessionDoc.resume_worker_upstream_calls_made)
              : 0,
            typeof resumeDoc !== "undefined" && resumeDoc && Number.isFinite(Number(resumeDoc?.upstream_calls_made))
              ? Number(resumeDoc.upstream_calls_made)
              : 0
          ),
          companies_candidates_found: 0,
          early_exit_triggered: false,
          last_heartbeat_at: null,
          lock_until: null,
          attempts: 0,
          last_error: errorOut,
          companies_count: saved,
          error: errorOut,
          items,
          saved,
          saved_verified_count,
          saved_company_ids_verified,
          saved_company_ids_unverified,
          saved_company_urls,
          save_outcome,
          resume_error: resume_error || sessionDoc_resume_error,
          resume_error_details: resume_error_details || sessionDoc_resume_error_details,
        resume_error_details: resume_error_details || sessionDoc_resume_error_details,
        enrichment_last_write_error: (typeof sessionDoc !== "undefined" && sessionDoc)
          ? sessionDoc?.enrichment_last_write_error || null
          : null,
        reconciled,
          reconcile_strategy,
          reconciled_saved_ids,
        saved_companies,
        effective_resume_status,
        ...(progress_notice ? { progress_notice } : {}),
        resume_needed,
        resume_cycle_count:
          (typeof sessionDoc !== "undefined" && sessionDoc && typeof sessionDoc === "object")
            ? Number(sessionDoc?.resume_cycle_count || 0) || 0
            : 0,
        resume_last_triggered_at:
          (typeof sessionDoc !== "undefined" && sessionDoc && typeof sessionDoc === "object")
            ? sessionDoc?.resume_last_triggered_at || sessionDoc?.resume_worker_last_triggered_at || null
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
            typeof resumeDoc?.cycle_count === "number" && Number.isFinite(Number(resumeDoc.cycle_count))
              ? Number(resumeDoc.cycle_count)
              : (typeof sessionDoc !== "undefined" && sessionDoc && typeof sessionDoc === "object")
                ? Number(sessionDoc?.resume_cycle_count || 0) || 0
                : null,
          max_cycles_single: MAX_RESUME_CYCLES_SINGLE,
          max_resume_cycles_single: MAX_RESUME_CYCLES_SINGLE,
          last_triggered_at:
            (typeof sessionDoc !== "undefined" && sessionDoc && typeof sessionDoc === "object")
              ? sessionDoc?.resume_last_triggered_at || sessionDoc?.resume_worker_last_triggered_at || null
              : null,
          next_allowed_run_at:
            (typeof resumeDoc?.next_allowed_run_at === "string" && resumeDoc.next_allowed_run_at.trim())
              ? resumeDoc.next_allowed_run_at.trim()
              : (typeof sessionDoc?.resume_next_allowed_run_at === "string" && sessionDoc.resume_next_allowed_run_at.trim())
                ? sessionDoc.resume_next_allowed_run_at.trim()
                : null,
          ...buildResumeAuthDiagnostics(),
          missing_by_company,
        },
        resume_worker: ((typeof sessionDoc !== "undefined" && sessionDoc) || (typeof resumeDoc !== "undefined" && resumeDoc))
          ? {
              last_invoked_at: sessionDoc?.resume_worker_last_invoked_at || resumeDoc?.last_invoked_at || null,
              handler_entered_at: sessionDoc?.resume_worker_handler_entered_at || resumeDoc?.handler_entered_at || null,
              handler_entered_build_id:
                sessionDoc?.resume_worker_handler_entered_build_id || resumeDoc?.handler_entered_build_id || null,
              last_reject_layer: sessionDoc?.resume_worker_last_reject_layer || resumeDoc?.last_reject_layer || null,
              last_auth: sessionDoc?.resume_worker_last_auth || resumeDoc?.last_auth || null,
              last_finished_at: sessionDoc?.resume_worker_last_finished_at || resumeDoc?.last_finished_at || null,
              last_result: sessionDoc?.resume_worker_last_result || resumeDoc?.last_result || null,
              last_enqueued_at: sessionDoc?.resume_worker_last_enqueued_at || null,
              last_enqueue_reason: sessionDoc?.resume_worker_last_enqueue_reason || null,
              last_enqueue_ok:
                typeof sessionDoc?.resume_worker_last_enqueue_ok === "boolean" ? sessionDoc.resume_worker_last_enqueue_ok : null,
              last_enqueue_error: sessionDoc?.resume_worker_last_enqueue_error || null,
              last_enqueue_queue: sessionDoc?.resume_worker_last_enqueue_queue || null,
              last_xai_attempt_at:
                sessionDoc?.resume_worker_last_xai_attempt_at || resumeDoc?.last_xai_attempt_at || sessionDoc?.last_xai_attempt_at || null,
              last_ok:
                typeof sessionDoc?.resume_worker_last_ok === "boolean"
                  ? sessionDoc.resume_worker_last_ok
                  : typeof resumeDoc?.last_ok === "boolean"
                    ? resumeDoc.last_ok
                    : null,
              last_http_status:
                typeof sessionDoc?.resume_worker_last_http_status === "number"
                  ? sessionDoc.resume_worker_last_http_status
                  : typeof resumeDoc?.last_http_status === "number"
                    ? resumeDoc.last_http_status
                    : null,
              last_trigger_request_id: sessionDoc?.resume_worker_last_trigger_request_id || resumeDoc?.last_trigger_request_id || null,
              last_trigger_result: sessionDoc?.resume_worker_last_trigger_result || resumeDoc?.last_trigger_result || null,
              last_trigger_ok:
                typeof sessionDoc?.resume_worker_last_trigger_ok === "boolean"
                  ? sessionDoc.resume_worker_last_trigger_ok
                  : typeof resumeDoc?.last_trigger_ok === "boolean"
                    ? resumeDoc.last_trigger_ok
                    : null,
              last_trigger_http_status:
                typeof sessionDoc?.resume_worker_last_trigger_http_status === "number"
                  ? sessionDoc.resume_worker_last_trigger_http_status
                  : typeof resumeDoc?.last_trigger_http_status === "number"
                    ? resumeDoc.last_trigger_http_status
                    : null,
              last_gateway_key_attached:
                typeof sessionDoc?.resume_worker_last_gateway_key_attached === "boolean"
                  ? sessionDoc.resume_worker_last_gateway_key_attached
                  : typeof resumeDoc?.last_gateway_key_attached === "boolean"
                    ? resumeDoc.last_gateway_key_attached
                    : null,
              last_error: sessionDoc?.resume_worker_last_error || resumeDoc?.last_error || null,
              last_company_id: sessionDoc?.resume_worker_last_company_id || resumeDoc?.last_company_id || null,
              last_written_fields: Array.isArray(sessionDoc?.resume_worker_last_written_fields)
                ? sessionDoc.resume_worker_last_written_fields
                : Array.isArray(resumeDoc?.last_written_fields)
                  ? resumeDoc.last_written_fields
                  : null,
              last_stage_beacon: sessionDoc?.resume_worker_last_stage_beacon || resumeDoc?.last_stage_beacon || null,
              last_resume_needed:
                typeof sessionDoc?.resume_worker_last_resume_needed === "boolean"
                  ? sessionDoc.resume_worker_last_resume_needed
                  : typeof resumeDoc?.last_resume_needed === "boolean"
                    ? resumeDoc.last_resume_needed
                    : null,
              planned_fields: Array.isArray(sessionDoc?.resume_worker_planned_fields)
                ? sessionDoc.resume_worker_planned_fields
                : Array.isArray(resumeDoc?.planned_fields)
                  ? resumeDoc.planned_fields
                  : null,
              planned_fields_reason: sessionDoc?.resume_worker_planned_fields_reason || resumeDoc?.planned_fields_reason || null,
              attempted_fields: Array.isArray(sessionDoc?.resume_worker_attempted_fields)
                ? sessionDoc.resume_worker_attempted_fields
                : Array.isArray(resumeDoc?.attempted_fields)
                  ? resumeDoc.attempted_fields
                  : null,
              attempted_fields_request_id:
                sessionDoc?.resume_worker_attempted_fields_request_id || resumeDoc?.attempted_fields_request_id || null,
              last_field_attempted: sessionDoc?.resume_worker_last_field_attempted || resumeDoc?.last_field_attempted || null,
              last_field_result: sessionDoc?.resume_worker_last_field_result || resumeDoc?.last_field_result || null,
              // Current enrichment status for real-time UI display
              current_field: sessionDoc?.resume_worker_current_field || null,
              current_company: sessionDoc?.resume_worker_current_company || null,
              ...(() => {
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
                  Array.isArray(sessionDoc?.resume_worker_attempted_fields),
                  Array.isArray(resumeDoc?.attempted_fields)
                );

                check(
                  "last_written_fields",
                  Array.isArray(sessionDoc?.resume_worker_last_written_fields),
                  Array.isArray(resumeDoc?.last_written_fields)
                );

                check(
                  "last_xai_attempt_at",
                  Boolean(sessionDoc?.resume_worker_last_xai_attempt_at || sessionDoc?.last_xai_attempt_at),
                  Boolean(resumeDoc?.last_xai_attempt_at)
                );

                check(
                  "next_allowed_run_at",
                  Boolean(sessionDoc?.resume_next_allowed_run_at),
                  Boolean(resumeDoc?.next_allowed_run_at)
                );

                const telemetry_missing = missing_fields.length > 0;

                return {
                  telemetry_missing,
                  telemetry_missing_fields: missing_fields,
                  telemetry_missing_session_fields: session_missing_fields,
                  telemetry_missing_resume_fields: resume_missing_fields,
                };
              })(),
            }
          : null,
        enrichment_health_summary,
          lastCreatedAt,
          timedOut,
          stopped,
          report,
        };

      if (!STATUS_NO_ORCHESTRATION && stageBeaconValues?.status_resume_force_terminalize_selected === true) {
        const forcedReason =
          typeof stageBeaconValues.status_resume_blocked_reason === "string" && stageBeaconValues.status_resume_blocked_reason.trim()
            ? stageBeaconValues.status_resume_blocked_reason.trim()
            : "force_terminalize_selected";

        applyTerminalOnlyCompletion(out, forcedReason);
      }

      if (completionOverride) {
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

      return jsonWithSessionId(out, 200, req);
    }

    const persistedSeedCount =
      (typeof saved_verified_count === "number" && Number.isFinite(saved_verified_count) ? saved_verified_count : 0) +
      (Array.isArray(saved_company_ids_unverified) ? saved_company_ids_unverified.length : 0);

    const hasPersistedSeed =
      persistedSeedCount > 0 ||
      (Array.isArray(saved_companies) && saved_companies.length > 0);

    if (isCompanyUrlImport && effectiveCompleted && !hasPersistedSeed) {
      const failed_items =
        Array.isArray(completionDoc?.failed_items)
          ? completionDoc.failed_items
          : Array.isArray(sessionDoc?.failed_items)
            ? sessionDoc.failed_items
            : [];

      const skipped_ids = Array.isArray(completionDoc?.skipped_ids)
        ? completionDoc.skipped_ids
        : Array.isArray(sessionDoc?.skipped_ids)
          ? sessionDoc.skipped_ids
          : [];

      const errorOut = {
        code: "COSMOS_SAVE_FAILED",
        message: "company_url import completed without a persisted seed company",
      };

      return jsonWithSessionId(
        {
          ok: false,
          root_cause: "cosmos_save_failed",
          session_id: sessionId,
          status: "error",
          state: "failed",
          job_state: null,
          stage_beacon: "cosmos_save_failed",
          stage_beacon_values: stageBeaconValues,
          ...(cosmosTarget ? cosmosTarget : {}),
          primary_job_state: null,
          elapsed_ms: null,
          remaining_budget_ms: null,
          upstream_calls_made: Math.max(
            typeof sessionDoc !== "undefined" && sessionDoc && Number.isFinite(Number(sessionDoc?.resume_worker_upstream_calls_made))
              ? Number(sessionDoc.resume_worker_upstream_calls_made)
              : 0,
            typeof resumeDoc !== "undefined" && resumeDoc && Number.isFinite(Number(resumeDoc?.upstream_calls_made))
              ? Number(resumeDoc.upstream_calls_made)
              : 0
          ),
          companies_candidates_found: 0,
          early_exit_triggered: false,
          last_heartbeat_at: null,
          lock_until: null,
          attempts: 0,
          last_error: errorOut,
          companies_count: 0,
          error: errorOut,
          items,
          saved: 0,
          saved_verified_count: 0,
          saved_company_ids_verified: [],
          saved_company_ids_unverified,
          saved_company_urls,
          save_outcome,
          resume_error,
          resume_error_details,
        resume_error_details,
          save_report: {
            saved: 0,
            saved_verified_count: 0,
            skipped:
              typeof completionDoc?.skipped === "number"
                ? completionDoc.skipped
                : typeof sessionDoc?.skipped === "number"
                  ? sessionDoc.skipped
                  : 0,
            failed:
              typeof completionDoc?.failed === "number"
                ? completionDoc.failed
                : typeof sessionDoc?.failed === "number"
                  ? sessionDoc.failed
                  : 0,
            skipped_ids,
            failed_items,
          },
          reconciled,
          reconcile_strategy,
          reconciled_saved_ids,
          saved_companies,
          resume_needed: false,
          resume: {
            needed: false,
            doc_created: false,
            triggered: false,
            trigger_error: null,
            missing_by_company: [],
          },
        resume_worker: ((typeof sessionDoc !== "undefined" && sessionDoc) || (typeof resumeDoc !== "undefined" && resumeDoc))
          ? {
              last_invoked_at: sessionDoc?.resume_worker_last_invoked_at || resumeDoc?.last_invoked_at || null,
              handler_entered_at: sessionDoc?.resume_worker_handler_entered_at || resumeDoc?.handler_entered_at || null,
              handler_entered_build_id:
                sessionDoc?.resume_worker_handler_entered_build_id || resumeDoc?.handler_entered_build_id || null,
              last_reject_layer: sessionDoc?.resume_worker_last_reject_layer || resumeDoc?.last_reject_layer || null,
              last_auth: sessionDoc?.resume_worker_last_auth || resumeDoc?.last_auth || null,
              last_finished_at: sessionDoc?.resume_worker_last_finished_at || resumeDoc?.last_finished_at || null,
              last_result: sessionDoc?.resume_worker_last_result || resumeDoc?.last_result || null,
              last_enqueued_at: sessionDoc?.resume_worker_last_enqueued_at || null,
              last_enqueue_reason: sessionDoc?.resume_worker_last_enqueue_reason || null,
              last_enqueue_ok:
                typeof sessionDoc?.resume_worker_last_enqueue_ok === "boolean" ? sessionDoc.resume_worker_last_enqueue_ok : null,
              last_enqueue_error: sessionDoc?.resume_worker_last_enqueue_error || null,
              last_enqueue_queue: sessionDoc?.resume_worker_last_enqueue_queue || null,
              last_xai_attempt_at:
                sessionDoc?.resume_worker_last_xai_attempt_at || resumeDoc?.last_xai_attempt_at || sessionDoc?.last_xai_attempt_at || null,
              last_ok:
                typeof sessionDoc?.resume_worker_last_ok === "boolean"
                  ? sessionDoc.resume_worker_last_ok
                  : typeof resumeDoc?.last_ok === "boolean"
                    ? resumeDoc.last_ok
                    : null,
              last_http_status:
                typeof sessionDoc?.resume_worker_last_http_status === "number"
                  ? sessionDoc.resume_worker_last_http_status
                  : typeof resumeDoc?.last_http_status === "number"
                    ? resumeDoc.last_http_status
                    : null,
              last_trigger_request_id: sessionDoc?.resume_worker_last_trigger_request_id || resumeDoc?.last_trigger_request_id || null,
              last_trigger_result: sessionDoc?.resume_worker_last_trigger_result || resumeDoc?.last_trigger_result || null,
              last_trigger_ok:
                typeof sessionDoc?.resume_worker_last_trigger_ok === "boolean"
                  ? sessionDoc.resume_worker_last_trigger_ok
                  : typeof resumeDoc?.last_trigger_ok === "boolean"
                    ? resumeDoc.last_trigger_ok
                    : null,
              last_trigger_http_status:
                typeof sessionDoc?.resume_worker_last_trigger_http_status === "number"
                  ? sessionDoc.resume_worker_last_trigger_http_status
                  : typeof resumeDoc?.last_trigger_http_status === "number"
                    ? resumeDoc.last_trigger_http_status
                    : null,
              last_gateway_key_attached:
                typeof sessionDoc?.resume_worker_last_gateway_key_attached === "boolean"
                  ? sessionDoc.resume_worker_last_gateway_key_attached
                  : typeof resumeDoc?.last_gateway_key_attached === "boolean"
                    ? resumeDoc.last_gateway_key_attached
                    : null,
              last_error: sessionDoc?.resume_worker_last_error || resumeDoc?.last_error || null,
              last_company_id: sessionDoc?.resume_worker_last_company_id || resumeDoc?.last_company_id || null,
              last_written_fields: Array.isArray(sessionDoc?.resume_worker_last_written_fields)
                ? sessionDoc.resume_worker_last_written_fields
                : Array.isArray(resumeDoc?.last_written_fields)
                  ? resumeDoc.last_written_fields
                  : null,
              last_stage_beacon: sessionDoc?.resume_worker_last_stage_beacon || resumeDoc?.last_stage_beacon || null,
              last_resume_needed:
                typeof sessionDoc?.resume_worker_last_resume_needed === "boolean"
                  ? sessionDoc.resume_worker_last_resume_needed
                  : typeof resumeDoc?.last_resume_needed === "boolean"
                    ? resumeDoc.last_resume_needed
                    : null,
              planned_fields: Array.isArray(sessionDoc?.resume_worker_planned_fields)
                ? sessionDoc.resume_worker_planned_fields
                : Array.isArray(resumeDoc?.planned_fields)
                  ? resumeDoc.planned_fields
                  : null,
              planned_fields_reason: sessionDoc?.resume_worker_planned_fields_reason || resumeDoc?.planned_fields_reason || null,
              attempted_fields: Array.isArray(sessionDoc?.resume_worker_attempted_fields)
                ? sessionDoc.resume_worker_attempted_fields
                : Array.isArray(resumeDoc?.attempted_fields)
                  ? resumeDoc.attempted_fields
                  : null,
              attempted_fields_request_id:
                sessionDoc?.resume_worker_attempted_fields_request_id || resumeDoc?.attempted_fields_request_id || null,
              last_field_attempted: sessionDoc?.resume_worker_last_field_attempted || resumeDoc?.last_field_attempted || null,
              last_field_result: sessionDoc?.resume_worker_last_field_result || resumeDoc?.last_field_result || null,
              // Current enrichment status for real-time UI display
              current_field: sessionDoc?.resume_worker_current_field || null,
              current_company: sessionDoc?.resume_worker_current_company || null,
              ...(() => {
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
                  Array.isArray(sessionDoc?.resume_worker_attempted_fields),
                  Array.isArray(resumeDoc?.attempted_fields)
                );

                check(
                  "last_written_fields",
                  Array.isArray(sessionDoc?.resume_worker_last_written_fields),
                  Array.isArray(resumeDoc?.last_written_fields)
                );

                check(
                  "last_xai_attempt_at",
                  Boolean(sessionDoc?.resume_worker_last_xai_attempt_at || sessionDoc?.last_xai_attempt_at),
                  Boolean(resumeDoc?.last_xai_attempt_at)
                );

                check(
                  "next_allowed_run_at",
                  Boolean(sessionDoc?.resume_next_allowed_run_at),
                  Boolean(resumeDoc?.next_allowed_run_at)
                );

                const telemetry_missing = missing_fields.length > 0;

                return {
                  telemetry_missing,
                  telemetry_missing_fields: missing_fields,
                  telemetry_missing_session_fields: session_missing_fields,
                  telemetry_missing_resume_fields: resume_missing_fields,
                };
              })(),
            }
          : null,
        enrichment_health_summary,
          lastCreatedAt,
          timedOut,
          stopped,
          report,
        },
        200,
        req
      );
    }

    if (effectiveCompleted) {
      const out = {
          ok: true,
          session_id: sessionId,
          status: "complete",
          state: "complete",
          job_state: null,
          stage_beacon,
          stage_beacon_values: stageBeaconValues,
          ...(cosmosTarget ? cosmosTarget : {}),
          primary_job_state: null,
          elapsed_ms: null,
          remaining_budget_ms: null,
          upstream_calls_made: Math.max(
            typeof sessionDoc !== "undefined" && sessionDoc && Number.isFinite(Number(sessionDoc?.resume_worker_upstream_calls_made))
              ? Number(sessionDoc.resume_worker_upstream_calls_made)
              : 0,
            typeof resumeDoc !== "undefined" && resumeDoc && Number.isFinite(Number(resumeDoc?.upstream_calls_made))
              ? Number(resumeDoc.upstream_calls_made)
              : 0
          ),
          companies_candidates_found: 0,
          early_exit_triggered: false,
          last_heartbeat_at: null,
          lock_until: null,
          attempts: 0,
          last_error: null,
          companies_count: saved,
          result: {
            saved,
            skipped: typeof completionDoc?.skipped === "number" ? completionDoc.skipped : null,
            failed: typeof completionDoc?.failed === "number" ? completionDoc.failed : null,
            completed_at: completionDoc?.completed_at || completionDoc?.created_at || null,
            reason: completionReason || null,
            saved_ids: savedIds,
            skipped_ids: Array.isArray(completionDoc?.skipped_ids) ? completionDoc.skipped_ids : [],
            failed_items: Array.isArray(completionDoc?.failed_items) ? completionDoc.failed_items : [],
          },
          items,
          saved,
          saved_verified_count,
          saved_company_ids_verified,
          saved_company_ids_unverified,
          saved_company_urls,
          save_outcome,
          resume_error: resume_error || sessionDoc_resume_error,
          resume_error_details: resume_error_details || sessionDoc_resume_error_details,
        resume_error_details: resume_error_details || sessionDoc_resume_error_details,
        enrichment_last_write_error: (typeof sessionDoc !== "undefined" && sessionDoc)
          ? sessionDoc?.enrichment_last_write_error || null
          : null,
        reconciled,
          reconcile_strategy,
          reconciled_saved_ids,
        saved_companies,
        effective_resume_status,
        ...(progress_notice ? { progress_notice } : {}),
        resume_needed,
        resume_cycle_count:
          (typeof sessionDoc !== "undefined" && sessionDoc && typeof sessionDoc === "object")
            ? Number(sessionDoc?.resume_cycle_count || 0) || 0
            : 0,
        resume_last_triggered_at:
          (typeof sessionDoc !== "undefined" && sessionDoc && typeof sessionDoc === "object")
            ? sessionDoc?.resume_last_triggered_at || sessionDoc?.resume_worker_last_triggered_at || null
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
            typeof resumeDoc?.cycle_count === "number" && Number.isFinite(Number(resumeDoc.cycle_count))
              ? Number(resumeDoc.cycle_count)
              : (typeof sessionDoc !== "undefined" && sessionDoc && typeof sessionDoc === "object")
                ? Number(sessionDoc?.resume_cycle_count || 0) || 0
                : null,
          max_cycles_single: MAX_RESUME_CYCLES_SINGLE,
          max_resume_cycles_single: MAX_RESUME_CYCLES_SINGLE,
          last_triggered_at:
            (typeof sessionDoc !== "undefined" && sessionDoc && typeof sessionDoc === "object")
              ? sessionDoc?.resume_last_triggered_at || sessionDoc?.resume_worker_last_triggered_at || null
              : null,
          next_allowed_run_at:
            (typeof resumeDoc?.next_allowed_run_at === "string" && resumeDoc.next_allowed_run_at.trim())
              ? resumeDoc.next_allowed_run_at.trim()
              : (typeof sessionDoc?.resume_next_allowed_run_at === "string" && sessionDoc.resume_next_allowed_run_at.trim())
                ? sessionDoc.resume_next_allowed_run_at.trim()
                : null,
          ...buildResumeAuthDiagnostics(),
          missing_by_company,
        },
        resume_worker: ((typeof sessionDoc !== "undefined" && sessionDoc) || (typeof resumeDoc !== "undefined" && resumeDoc))
          ? {
              last_invoked_at: sessionDoc?.resume_worker_last_invoked_at || resumeDoc?.last_invoked_at || null,
              handler_entered_at: sessionDoc?.resume_worker_handler_entered_at || resumeDoc?.handler_entered_at || null,
              handler_entered_build_id:
                sessionDoc?.resume_worker_handler_entered_build_id || resumeDoc?.handler_entered_build_id || null,
              last_reject_layer: sessionDoc?.resume_worker_last_reject_layer || resumeDoc?.last_reject_layer || null,
              last_auth: sessionDoc?.resume_worker_last_auth || resumeDoc?.last_auth || null,
              last_finished_at: sessionDoc?.resume_worker_last_finished_at || resumeDoc?.last_finished_at || null,
              last_result: sessionDoc?.resume_worker_last_result || resumeDoc?.last_result || null,
              last_enqueued_at: sessionDoc?.resume_worker_last_enqueued_at || null,
              last_enqueue_reason: sessionDoc?.resume_worker_last_enqueue_reason || null,
              last_enqueue_ok:
                typeof sessionDoc?.resume_worker_last_enqueue_ok === "boolean" ? sessionDoc.resume_worker_last_enqueue_ok : null,
              last_enqueue_error: sessionDoc?.resume_worker_last_enqueue_error || null,
              last_enqueue_queue: sessionDoc?.resume_worker_last_enqueue_queue || null,
              last_xai_attempt_at:
                sessionDoc?.resume_worker_last_xai_attempt_at || resumeDoc?.last_xai_attempt_at || sessionDoc?.last_xai_attempt_at || null,
              last_ok:
                typeof sessionDoc?.resume_worker_last_ok === "boolean"
                  ? sessionDoc.resume_worker_last_ok
                  : typeof resumeDoc?.last_ok === "boolean"
                    ? resumeDoc.last_ok
                    : null,
              last_http_status:
                typeof sessionDoc?.resume_worker_last_http_status === "number"
                  ? sessionDoc.resume_worker_last_http_status
                  : typeof resumeDoc?.last_http_status === "number"
                    ? resumeDoc.last_http_status
                    : null,
              last_trigger_request_id: sessionDoc?.resume_worker_last_trigger_request_id || resumeDoc?.last_trigger_request_id || null,
              last_trigger_result: sessionDoc?.resume_worker_last_trigger_result || resumeDoc?.last_trigger_result || null,
              last_trigger_ok:
                typeof sessionDoc?.resume_worker_last_trigger_ok === "boolean"
                  ? sessionDoc.resume_worker_last_trigger_ok
                  : typeof resumeDoc?.last_trigger_ok === "boolean"
                    ? resumeDoc.last_trigger_ok
                    : null,
              last_trigger_http_status:
                typeof sessionDoc?.resume_worker_last_trigger_http_status === "number"
                  ? sessionDoc.resume_worker_last_trigger_http_status
                  : typeof resumeDoc?.last_trigger_http_status === "number"
                    ? resumeDoc.last_trigger_http_status
                    : null,
              last_gateway_key_attached:
                typeof sessionDoc?.resume_worker_last_gateway_key_attached === "boolean"
                  ? sessionDoc.resume_worker_last_gateway_key_attached
                  : typeof resumeDoc?.last_gateway_key_attached === "boolean"
                    ? resumeDoc.last_gateway_key_attached
                    : null,
              last_error: sessionDoc?.resume_worker_last_error || resumeDoc?.last_error || null,
              last_company_id: sessionDoc?.resume_worker_last_company_id || resumeDoc?.last_company_id || null,
              last_written_fields: Array.isArray(sessionDoc?.resume_worker_last_written_fields)
                ? sessionDoc.resume_worker_last_written_fields
                : Array.isArray(resumeDoc?.last_written_fields)
                  ? resumeDoc.last_written_fields
                  : null,
              last_stage_beacon: sessionDoc?.resume_worker_last_stage_beacon || resumeDoc?.last_stage_beacon || null,
              last_resume_needed:
                typeof sessionDoc?.resume_worker_last_resume_needed === "boolean"
                  ? sessionDoc.resume_worker_last_resume_needed
                  : typeof resumeDoc?.last_resume_needed === "boolean"
                    ? resumeDoc.last_resume_needed
                    : null,
              planned_fields: Array.isArray(sessionDoc?.resume_worker_planned_fields)
                ? sessionDoc.resume_worker_planned_fields
                : Array.isArray(resumeDoc?.planned_fields)
                  ? resumeDoc.planned_fields
                  : null,
              planned_fields_reason: sessionDoc?.resume_worker_planned_fields_reason || resumeDoc?.planned_fields_reason || null,
              attempted_fields: Array.isArray(sessionDoc?.resume_worker_attempted_fields)
                ? sessionDoc.resume_worker_attempted_fields
                : Array.isArray(resumeDoc?.attempted_fields)
                  ? resumeDoc.attempted_fields
                  : null,
              attempted_fields_request_id:
                sessionDoc?.resume_worker_attempted_fields_request_id || resumeDoc?.attempted_fields_request_id || null,
              last_field_attempted: sessionDoc?.resume_worker_last_field_attempted || resumeDoc?.last_field_attempted || null,
              last_field_result: sessionDoc?.resume_worker_last_field_result || resumeDoc?.last_field_result || null,
              // Current enrichment status for real-time UI display
              current_field: sessionDoc?.resume_worker_current_field || null,
              current_company: sessionDoc?.resume_worker_current_company || null,
              ...(() => {
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
                  Array.isArray(sessionDoc?.resume_worker_attempted_fields),
                  Array.isArray(resumeDoc?.attempted_fields)
                );

                check(
                  "last_written_fields",
                  Array.isArray(sessionDoc?.resume_worker_last_written_fields),
                  Array.isArray(resumeDoc?.last_written_fields)
                );

                check(
                  "last_xai_attempt_at",
                  Boolean(sessionDoc?.resume_worker_last_xai_attempt_at || sessionDoc?.last_xai_attempt_at),
                  Boolean(resumeDoc?.last_xai_attempt_at)
                );

                check(
                  "next_allowed_run_at",
                  Boolean(sessionDoc?.resume_next_allowed_run_at),
                  Boolean(resumeDoc?.next_allowed_run_at)
                );

                const telemetry_missing = missing_fields.length > 0;

                return {
                  telemetry_missing,
                  telemetry_missing_fields: missing_fields,
                  telemetry_missing_session_fields: session_missing_fields,
                  telemetry_missing_resume_fields: resume_missing_fields,
                };
              })(),
            }
          : null,
        enrichment_health_summary,
          lastCreatedAt,
          report,
        };

      // Fallback: if we ever observe a max-cycles blocked state, converge to terminal-only completion.
    // (This ensures we never return resume_needed=true + resume.status=blocked indefinitely.)
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

    if (!STATUS_NO_ORCHESTRATION && terminalOnlyReason) applyTerminalOnlyCompletion(out, terminalOnlyReason);
    else {
        out.completed = true;
        out.terminal_only = false;

        out.resume_needed = false;
        out.resume = out.resume || {};
        out.resume.needed = false;
        out.resume.status = out.resume.status || "complete";
      }

      // Reviews terminal contract: never return completed/terminal-only with reviews still pending.
      try {
        if ((out.completed || out.terminal_only) && Array.isArray(savedDocs) && savedDocs.length > 0) {
          let finalized = 0;
          for (const doc of savedDocs) {
            const changed = finalizeReviewsForCompletion(doc, { reason: out.terminal_only ? terminalOnlyReason : "complete" });
            if (!changed) continue;
            finalized += 1;
            await upsertDoc(container, { ...doc, updated_at: nowIso() }).catch(() => null);
          }
          if (finalized > 0) stageBeaconValues.status_reviews_finalized_on_completion = nowIso();
        }
      } catch {}

      if (completionOverride) {
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

      return jsonWithSessionId(out, 200, req);
    }

    const out = {
        ok: true,
        session_id: sessionId,
        status: "running",
        state: "running",
        job_state: null,
        stage_beacon,
        stage_beacon_values: stageBeaconValues,
        ...(cosmosTarget ? cosmosTarget : {}),
        primary_job_state: null,
        elapsed_ms: null,
        remaining_budget_ms: null,
        upstream_calls_made: Math.max(
          typeof sessionDoc !== "undefined" && sessionDoc && Number.isFinite(Number(sessionDoc?.resume_worker_upstream_calls_made))
            ? Number(sessionDoc.resume_worker_upstream_calls_made)
            : 0,
          typeof resumeDoc !== "undefined" && resumeDoc && Number.isFinite(Number(resumeDoc?.upstream_calls_made))
            ? Number(resumeDoc.upstream_calls_made)
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
        resume_error: resume_error || sessionDoc_resume_error,
        resume_error_details: resume_error_details || sessionDoc_resume_error_details,
        enrichment_last_write_error: (typeof sessionDoc !== "undefined" && sessionDoc)
          ? sessionDoc?.enrichment_last_write_error || null
          : null,
        reconciled,
        reconcile_strategy,
        reconciled_saved_ids,
        saved_companies,
        effective_resume_status,
        ...(progress_notice ? { progress_notice } : {}),
        resume_needed,
        resume_cycle_count:
          (typeof sessionDoc !== "undefined" && sessionDoc && typeof sessionDoc === "object")
            ? Number(sessionDoc?.resume_cycle_count || 0) || 0
            : 0,
        resume_last_triggered_at:
          (typeof sessionDoc !== "undefined" && sessionDoc && typeof sessionDoc === "object")
            ? sessionDoc?.resume_last_triggered_at || sessionDoc?.resume_worker_last_triggered_at || null
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
            typeof resumeDoc?.cycle_count === "number" && Number.isFinite(Number(resumeDoc.cycle_count))
              ? Number(resumeDoc.cycle_count)
              : (typeof sessionDoc !== "undefined" && sessionDoc && typeof sessionDoc === "object")
                ? Number(sessionDoc?.resume_cycle_count || 0) || 0
                : null,
          max_cycles_single: MAX_RESUME_CYCLES_SINGLE,
          max_resume_cycles_single: MAX_RESUME_CYCLES_SINGLE,
          last_triggered_at:
            (typeof sessionDoc !== "undefined" && sessionDoc && typeof sessionDoc === "object")
              ? sessionDoc?.resume_last_triggered_at || sessionDoc?.resume_worker_last_triggered_at || null
              : null,
          next_allowed_run_at:
            (typeof resumeDoc?.next_allowed_run_at === "string" && resumeDoc.next_allowed_run_at.trim())
              ? resumeDoc.next_allowed_run_at.trim()
              : (typeof sessionDoc?.resume_next_allowed_run_at === "string" && sessionDoc.resume_next_allowed_run_at.trim())
                ? sessionDoc.resume_next_allowed_run_at.trim()
                : null,
          ...buildResumeAuthDiagnostics(),
          missing_by_company,
        },
        resume_worker: ((typeof sessionDoc !== "undefined" && sessionDoc) || (typeof resumeDoc !== "undefined" && resumeDoc))
          ? {
              last_invoked_at: sessionDoc?.resume_worker_last_invoked_at || resumeDoc?.last_invoked_at || null,
              handler_entered_at: sessionDoc?.resume_worker_handler_entered_at || resumeDoc?.handler_entered_at || null,
              handler_entered_build_id:
                sessionDoc?.resume_worker_handler_entered_build_id || resumeDoc?.handler_entered_build_id || null,
              last_reject_layer: sessionDoc?.resume_worker_last_reject_layer || resumeDoc?.last_reject_layer || null,
              last_auth: sessionDoc?.resume_worker_last_auth || resumeDoc?.last_auth || null,
              last_finished_at: sessionDoc?.resume_worker_last_finished_at || resumeDoc?.last_finished_at || null,
              last_result: sessionDoc?.resume_worker_last_result || resumeDoc?.last_result || null,
              last_enqueued_at: sessionDoc?.resume_worker_last_enqueued_at || null,
              last_enqueue_reason: sessionDoc?.resume_worker_last_enqueue_reason || null,
              last_enqueue_ok:
                typeof sessionDoc?.resume_worker_last_enqueue_ok === "boolean" ? sessionDoc.resume_worker_last_enqueue_ok : null,
              last_enqueue_error: sessionDoc?.resume_worker_last_enqueue_error || null,
              last_enqueue_queue: sessionDoc?.resume_worker_last_enqueue_queue || null,
              last_xai_attempt_at:
                sessionDoc?.resume_worker_last_xai_attempt_at || resumeDoc?.last_xai_attempt_at || sessionDoc?.last_xai_attempt_at || null,
              last_ok:
                typeof sessionDoc?.resume_worker_last_ok === "boolean"
                  ? sessionDoc.resume_worker_last_ok
                  : typeof resumeDoc?.last_ok === "boolean"
                    ? resumeDoc.last_ok
                    : null,
              last_http_status:
                typeof sessionDoc?.resume_worker_last_http_status === "number"
                  ? sessionDoc.resume_worker_last_http_status
                  : typeof resumeDoc?.last_http_status === "number"
                    ? resumeDoc.last_http_status
                    : null,
              last_trigger_request_id: sessionDoc?.resume_worker_last_trigger_request_id || resumeDoc?.last_trigger_request_id || null,
              last_trigger_result: sessionDoc?.resume_worker_last_trigger_result || resumeDoc?.last_trigger_result || null,
              last_trigger_ok:
                typeof sessionDoc?.resume_worker_last_trigger_ok === "boolean"
                  ? sessionDoc.resume_worker_last_trigger_ok
                  : typeof resumeDoc?.last_trigger_ok === "boolean"
                    ? resumeDoc.last_trigger_ok
                    : null,
              last_trigger_http_status:
                typeof sessionDoc?.resume_worker_last_trigger_http_status === "number"
                  ? sessionDoc.resume_worker_last_trigger_http_status
                  : typeof resumeDoc?.last_trigger_http_status === "number"
                    ? resumeDoc.last_trigger_http_status
                    : null,
              last_gateway_key_attached:
                typeof sessionDoc?.resume_worker_last_gateway_key_attached === "boolean"
                  ? sessionDoc.resume_worker_last_gateway_key_attached
                  : typeof resumeDoc?.last_gateway_key_attached === "boolean"
                    ? resumeDoc.last_gateway_key_attached
                    : null,
              last_error: sessionDoc?.resume_worker_last_error || resumeDoc?.last_error || null,
              last_company_id: sessionDoc?.resume_worker_last_company_id || resumeDoc?.last_company_id || null,
              last_written_fields: Array.isArray(sessionDoc?.resume_worker_last_written_fields)
                ? sessionDoc.resume_worker_last_written_fields
                : Array.isArray(resumeDoc?.last_written_fields)
                  ? resumeDoc.last_written_fields
                  : null,
              last_stage_beacon: sessionDoc?.resume_worker_last_stage_beacon || resumeDoc?.last_stage_beacon || null,
              last_resume_needed:
                typeof sessionDoc?.resume_worker_last_resume_needed === "boolean"
                  ? sessionDoc.resume_worker_last_resume_needed
                  : typeof resumeDoc?.last_resume_needed === "boolean"
                    ? resumeDoc.last_resume_needed
                    : null,
              planned_fields: Array.isArray(sessionDoc?.resume_worker_planned_fields)
                ? sessionDoc.resume_worker_planned_fields
                : Array.isArray(resumeDoc?.planned_fields)
                  ? resumeDoc.planned_fields
                  : null,
              planned_fields_reason: sessionDoc?.resume_worker_planned_fields_reason || resumeDoc?.planned_fields_reason || null,
              attempted_fields: Array.isArray(sessionDoc?.resume_worker_attempted_fields)
                ? sessionDoc.resume_worker_attempted_fields
                : Array.isArray(resumeDoc?.attempted_fields)
                  ? resumeDoc.attempted_fields
                  : null,
              attempted_fields_request_id:
                sessionDoc?.resume_worker_attempted_fields_request_id || resumeDoc?.attempted_fields_request_id || null,
              last_field_attempted: sessionDoc?.resume_worker_last_field_attempted || resumeDoc?.last_field_attempted || null,
              last_field_result: sessionDoc?.resume_worker_last_field_result || resumeDoc?.last_field_result || null,
              // Current enrichment status for real-time UI display
              current_field: sessionDoc?.resume_worker_current_field || null,
              current_company: sessionDoc?.resume_worker_current_company || null,
              ...(() => {
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
                  Array.isArray(sessionDoc?.resume_worker_attempted_fields),
                  Array.isArray(resumeDoc?.attempted_fields)
                );

                check(
                  "last_written_fields",
                  Array.isArray(sessionDoc?.resume_worker_last_written_fields),
                  Array.isArray(resumeDoc?.last_written_fields)
                );

                check(
                  "last_xai_attempt_at",
                  Boolean(sessionDoc?.resume_worker_last_xai_attempt_at || sessionDoc?.last_xai_attempt_at),
                  Boolean(resumeDoc?.last_xai_attempt_at)
                );

                check(
                  "next_allowed_run_at",
                  Boolean(sessionDoc?.resume_next_allowed_run_at),
                  Boolean(resumeDoc?.next_allowed_run_at)
                );

                const telemetry_missing = missing_fields.length > 0;

                return {
                  telemetry_missing,
                  telemetry_missing_fields: missing_fields,
                  telemetry_missing_session_fields: session_missing_fields,
                  telemetry_missing_resume_fields: resume_missing_fields,
                };
              })(),
            }
          : null,
        enrichment_health_summary,
        lastCreatedAt,
        report,
      };

    // Fallback: if we ever observe a max-cycles blocked state, converge to terminal-only completion.
    // (This ensures we never return resume_needed=true + resume.status=blocked indefinitely.)
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

    if (!STATUS_NO_ORCHESTRATION && terminalOnlyReason) applyTerminalOnlyCompletion(out, terminalOnlyReason);
    else {
      out.completed = false;
      out.terminal_only = false;
    }

    // Reviews terminal contract: never return completed/terminal-only with reviews still pending.
    try {
      if ((out.completed || out.terminal_only) && Array.isArray(savedDocs) && savedDocs.length > 0) {
        let finalized = 0;
        for (const doc of savedDocs) {
          const changed = finalizeReviewsForCompletion(doc, { reason: out.terminal_only ? terminalOnlyReason : "complete" });
          if (!changed) continue;
          finalized += 1;
          await upsertDoc(container, { ...doc, updated_at: nowIso() }).catch(() => null);
        }
        if (finalized > 0) stageBeaconValues.status_reviews_finalized_on_completion = nowIso();
      }
    } catch {}

    return jsonWithSessionId(out, 200, req);
  } catch (e) {
    const msg = e?.message || String(e);
    try {
      console.error(`[import-status] session=${sessionId} error: ${msg}`);
    } catch {}
    return jsonWithSessionId(
      {
        ok: false,
        session_id: sessionId,
        error: "Status handler failure",
        code: "STATUS_HANDLER_FAILURE",
        detail: msg,
      },
      200
    );
  }
}

function deprecatedHandler(req) {
  const method = String(req?.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: cors(req) };

  const url = new URL(req.url);
  const canonicalPath = "/api/import/status";
  const location = `${canonicalPath}${url.search || ""}`;

  return json(
    {
      ok: false,
      deprecated: true,
      deprecated_route: "/api/import-status",
      canonical_route: canonicalPath,
      redirect_to: location,
      message: "Deprecated. Use GET /api/import/status",
    },
    308,
    req,
    {
      Location: location,
      "Cache-Control": "no-store",
    }
  );
}

app.http("import-status", {
  route: "import/status",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler,
});

app.http("import-status-alt", {
  route: "import-status",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: deprecatedHandler,
});

// Raw session diagnostic endpoint - uses the EXACT SAME read path as import-status
// This guarantees we're inspecting the same data that the policy logic reads
app.http("import-status-session-raw", {
  route: "import/status/session-raw",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req) => {
    const method = String(req?.method || "").toUpperCase();
    if (method === "OPTIONS") return { status: 200, headers: cors(req) };

    const url = new URL(req.url);
    const sessionId = String(url.searchParams.get("session_id") || "").trim();

    if (!sessionId) {
      return json({ ok: false, error: "Missing session_id" }, 400, req);
    }

    const ts = nowIso();

    try {
      const { endpoint, key, databaseId, containerId } = getCosmosConfig();

      if (!endpoint || !key || !CosmosClient) {
        return json({
          ok: false,
          session_id: sessionId,
          ts,
          error: "Cosmos not configured",
          cosmos_configured: false,
        }, 200, req);
      }

      const client = new CosmosClient({ endpoint, key });
      const container = client.database(databaseId).container(containerId);

      // Use the EXACT SAME readControlDoc function that import-status uses
      const sessionDocId = `_import_session_${sessionId}`;
      const sessionDoc = await readControlDoc(container, sessionDocId, sessionId).catch((e) => ({
        _read_error: String(e?.message || e),
      }));

      const found = Boolean(sessionDoc && !sessionDoc._read_error);

      return json({
        ok: true,
        session_id: sessionId,
        ts,
        found,
        keys: found ? Object.keys(sessionDoc) : null,
        single_company_mode: sessionDoc?.single_company_mode,
        single_company_mode_type: typeof sessionDoc?.single_company_mode,
        request_kind: sessionDoc?.request_kind,
        request_kind_type: typeof sessionDoc?.request_kind,
        request: sessionDoc?.request || null,
        status: sessionDoc?.status,
        stage_beacon: sessionDoc?.stage_beacon,
        resume_needed: sessionDoc?.resume_needed,
        raw_sessionDoc: sessionDoc,
      }, 200, req);
    } catch (e) {
      return json({
        ok: false,
        session_id: sessionId,
        ts,
        error: String(e?.message || e),
      }, 200, req);
    }
  },
});

module.exports = { handler, _test: { handler } };
