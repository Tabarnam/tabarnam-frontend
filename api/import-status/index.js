let app;
try {
  ({ app } = require("@azure/functions"));
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
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
} = require("../_cosmosPartitionKey");

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
  return {
    status,
    headers: {
      ...cors(req),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
    },
    body: JSON.stringify(obj),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.trunc(n);
}

function getHeartbeatTimestamp(job) {
  const hb = Date.parse(job?.last_heartbeat_at || "") || 0;
  if (hb) return hb;
  const updated = Date.parse(job?.updated_at || "") || 0;
  if (updated) return updated;
  const started = Date.parse(job?.started_at || "") || 0;
  return started || 0;
}

function getJobCreatedTimestamp(job) {
  const created = Date.parse(job?.created_at || "") || 0;
  if (created) return created;
  const updated = Date.parse(job?.updated_at || "") || 0;
  if (updated) return updated;
  const started = Date.parse(job?.started_at || "") || 0;
  return started || 0;
}

function computePrimaryProgress(job, nowTs, hardMaxRuntimeMs) {
  const state = String(job?.job_state || "queued");
  const startedAtTs = Date.parse(job?.started_at || "") || 0;
  const createdAtTs = getJobCreatedTimestamp(job);

  const startTs = startedAtTs || (state === "queued" ? createdAtTs || nowTs : nowTs);
  const elapsedMs = Math.max(0, nowTs - startTs);

  const upstreamCallsMade = toPositiveInt(job?.upstream_calls_made, 0);
  const candidatesFound = Number.isFinite(Number(job?.companies_candidates_found))
    ? Math.max(0, Number(job.companies_candidates_found))
    : Number.isFinite(Number(job?.companies_count))
      ? Math.max(0, Number(job.companies_count))
      : 0;

  return {
    elapsed_ms: elapsedMs,
    remaining_budget_ms: Math.max(0, hardMaxRuntimeMs - elapsedMs),
    upstream_calls_made: upstreamCallsMade,
    companies_candidates_found: candidatesFound,
    early_exit_triggered: Boolean(job?.early_exit_triggered),
  };
}

async function ensurePrimaryJobProgressFields({ sessionId, job, hardMaxRuntimeMs, stageBeaconValues }) {
  const nowTs = Date.now();
  const progress = computePrimaryProgress(job, nowTs, hardMaxRuntimeMs);

  const patch = {};

  if (!(typeof job?.stage_beacon === "string" && job.stage_beacon.trim())) {
    patch.stage_beacon = "primary_search_started";
  }

  if (!Number.isFinite(Number(job?.elapsed_ms))) patch.elapsed_ms = progress.elapsed_ms;
  if (!Number.isFinite(Number(job?.remaining_budget_ms))) patch.remaining_budget_ms = progress.remaining_budget_ms;

  if (!Number.isFinite(Number(job?.upstream_calls_made))) patch.upstream_calls_made = progress.upstream_calls_made;

  if (!Number.isFinite(Number(job?.companies_candidates_found)) && !Number.isFinite(Number(job?.companies_count))) {
    patch.companies_candidates_found = progress.companies_candidates_found;
  }

  if (typeof job?.early_exit_triggered !== "boolean") patch.early_exit_triggered = progress.early_exit_triggered;

  const patchKeys = Object.keys(patch);
  if (patchKeys.length === 0) return { job, progress };

  stageBeaconValues.status_patched_progress_fields = nowIso();

  await patchImportPrimaryJob({
    sessionId,
    cosmosEnabled: true,
    patch: {
      ...patch,
      updated_at: nowIso(),
    },
  }).catch(() => null);

  const refreshed = await getImportPrimaryJob({ sessionId, cosmosEnabled: true }).catch(() => job);
  return { job: refreshed || job, progress: computePrimaryProgress(refreshed || job, Date.now(), hardMaxRuntimeMs) };
}

async function markPrimaryJobError({ sessionId, code, message, stageBeacon, details, stageBeaconValues }) {
  stageBeaconValues.status_marked_error = nowIso();
  if (code) stageBeaconValues.status_marked_error_code = String(code);

  await patchImportPrimaryJob({
    sessionId,
    cosmosEnabled: true,
    patch: {
      job_state: "error",
      stage_beacon: String(stageBeacon || "primary_search_started"),
      last_error: {
        code: String(code || "UNKNOWN"),
        message: String(message || "Job failed"),
        ...(details && typeof details === "object" ? details : {}),
      },
      last_heartbeat_at: nowIso(),
      updated_at: nowIso(),
      lock_expires_at: null,
      locked_by: null,
    },
  }).catch(() => null);

  return await getImportPrimaryJob({ sessionId, cosmosEnabled: true }).catch(() => null);
}

let companiesPkPathPromise;
async function getCompaniesPkPath(container) {
  if (!container) return "/normalized_domain";
  companiesPkPathPromise ||= getContainerPartitionKeyPath(container, "/normalized_domain");
  try {
    return await companiesPkPathPromise;
  } catch {
    return "/normalized_domain";
  }
}

async function readControlDoc(container, id, sessionId) {
  if (!container) return null;
  const containerPkPath = await getCompaniesPkPath(container);

  const docForCandidates = {
    id,
    session_id: sessionId,
    normalized_domain: "import",
    partition_key: "import",
    type: "import_control",
  };

  const candidates = buildPartitionKeyCandidates({
    doc: docForCandidates,
    containerPkPath,
    requestedId: id,
  });

  let lastErr = null;
  for (const partitionKeyValue of candidates) {
    try {
      const item =
        partitionKeyValue !== undefined
          ? container.item(id, partitionKeyValue)
          : container.item(id);
      const { resource } = await item.read();
      return resource || null;
    } catch (e) {
      lastErr = e;
      if (e?.code === 404) return null;
    }
  }

  if (lastErr && lastErr.code !== 404) {
    try {
      console.warn(`[import-status] session=${sessionId} control doc read failed: ${lastErr.message}`);
    } catch {}
  }
  return null;
}

async function hasAnyCompanyDocs(container, sessionId) {
  if (!container) return false;
  try {
    const q = {
      query: `SELECT TOP 1 c.id FROM c WHERE c.session_id = @sid AND NOT STARTSWITH(c.id, '_import_')`,
      parameters: [{ name: "@sid", value: sessionId }],
    };

    const { resources } = await container.items
      .query(q, { enableCrossPartitionQuery: true })
      .fetchAll();

    return Array.isArray(resources) && resources.length > 0;
  } catch (e) {
    try {
      console.warn(`[import-status] session=${sessionId} company probe failed: ${e?.message || String(e)}`);
    } catch {}
    return false;
  }
}

async function fetchRecentCompanies(container, sessionId, take) {
  if (!container) return [];
  const n = Math.max(0, Math.min(Number(take) || 10, 200));
  if (!n) return [];

  const q = {
    query: `
      SELECT c.id, c.company_name, c.name, c.url, c.website_url, c.industries, c.product_keywords, c.created_at
      FROM c
      WHERE c.session_id = @sid AND NOT STARTSWITH(c.id, '_import_')
      ORDER BY c.created_at DESC
    `,
    parameters: [{ name: "@sid", value: sessionId }],
  };

  const { resources } = await container.items
    .query(q, { enableCrossPartitionQuery: true })
    .fetchAll();

  return Array.isArray(resources) ? resources.slice(0, n) : [];
}

function normalizeErrorPayload(value) {
  if (!value) return null;
  if (typeof value === "string") return { message: value };
  if (typeof value === "object") return value;
  return { message: String(value) };
}

async function handler(req, context) {
  const method = String(req?.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: cors(req) };

  const url = new URL(req.url);
  const sessionId = String(url.searchParams.get("session_id") || "").trim();
  const take = Number(url.searchParams.get("take") || "10") || 10;

  if (!sessionId) {
    return json({ ok: false, error: "Missing session_id" }, 400, req);
  }

  const extraHeaders = { "x-session-id": sessionId };
  const jsonWithSessionId = (obj, status = 200) => json(obj, status, req, extraHeaders);

  const statusCheckedAt = nowIso();
  const stageBeaconValues = {
    status_checked_at: statusCheckedAt,
  };

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

    try {
      const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
      const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
      const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
      const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

      if (endpoint && key && CosmosClient) {
        const client = new CosmosClient({ endpoint, key });
        const container = client.database(databaseId).container(containerId);

        const [sessionDoc, completionDoc, acceptDoc] = await Promise.all([
          readControlDoc(container, `_import_session_${sessionId}`, sessionId),
          readControlDoc(container, `_import_complete_${sessionId}`, sessionId),
          readControlDoc(container, `_import_accept_${sessionId}`, sessionId),
        ]);

        report = {
          session: sessionDoc
            ? {
                created_at: sessionDoc?.created_at || null,
                request_id: sessionDoc?.request_id || null,
                status: sessionDoc?.status || null,
                stage_beacon: sessionDoc?.stage_beacon || null,
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
                saved: typeof completionDoc?.saved === "number" ? completionDoc.saved : null,
                skipped: typeof completionDoc?.skipped === "number" ? completionDoc.skipped : null,
                failed: typeof completionDoc?.failed === "number" ? completionDoc.failed : null,
                saved_ids: Array.isArray(completionDoc?.saved_ids) ? completionDoc.saved_ids : [],
                skipped_ids: Array.isArray(completionDoc?.skipped_ids) ? completionDoc.skipped_ids : [],
                failed_items: Array.isArray(completionDoc?.failed_items) ? completionDoc.failed_items : [],
              }
            : null,
        };
      }
    } catch {
      report = null;
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

    return jsonWithSessionId(
      {
        ok: true,
        session_id: sessionId,
        status,
        state,
        job_state: finalJobState,
        stage_beacon:
          typeof primaryJob?.stage_beacon === "string" && primaryJob.stage_beacon.trim()
            ? primaryJob.stage_beacon.trim()
            : status === "complete"
              ? "primary_complete"
              : status === "queued"
                ? "primary_search_started"
                : status === "running"
                  ? "primary_search_started"
                  : "primary_search_started",
        stage_beacon_values: stageBeaconValues,
        primary_job_state: finalJobState,
        last_heartbeat_at: primaryJob?.last_heartbeat_at || null,
        lock_until: primaryJob?.lock_expires_at || null,
        attempts: Number.isFinite(Number(primaryJob?.attempt)) ? Number(primaryJob.attempt) : 0,
        last_error: primaryJob?.last_error || null,
        worker_meta: workerResult?.body?.meta || null,
        elapsed_ms: Number(progress?.elapsed_ms),
        remaining_budget_ms: Number(progress?.remaining_budget_ms),
        upstream_calls_made: Number(progress?.upstream_calls_made),
        companies_candidates_found: Number(progress?.companies_candidates_found),
        early_exit_triggered: Boolean(progress?.early_exit_triggered),
        companies_count: Number.isFinite(Number(primaryJob?.companies_count)) ? Number(primaryJob.companies_count) : 0,
        items: status === "error" ? [] : Array.isArray(primaryJob?.companies) ? primaryJob.companies : [],
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
      },
      200,
      req
    );
  }

  const mem = getImportSession(sessionId);
  if (mem) {
    stageBeaconValues.status_seen_session_memory = nowIso();

    return jsonWithSessionId(
      {
        ok: true,
        session_id: sessionId,
        status: mem.status || "running",
        state: mem.status === "complete" ? "complete" : mem.status === "failed" ? "failed" : "running",
        job_state: null,
        stage_beacon: mem.stage_beacon || "init",
        stage_beacon_values: stageBeaconValues,
        elapsed_ms: null,
        remaining_budget_ms: null,
        upstream_calls_made: 0,
        companies_candidates_found: 0,
        early_exit_triggered: false,
        primary_job_state: null,
        last_heartbeat_at: null,
        lock_until: null,
        attempts: 0,
        last_error: null,
        companies_count: Number.isFinite(Number(mem.companies_count)) ? Number(mem.companies_count) : 0,
      },
      200,
      req
    );
  }

  const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
  const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
  const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
  const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

  if (!endpoint || !key) {
    if (primaryJob) {
      const jobState = String(primaryJob.job_state || "queued");
      const status = jobState === "error" ? "error" : jobState === "complete" ? "complete" : jobState === "running" ? "running" : "queued";
      const state = status === "error" ? "failed" : status === "complete" ? "complete" : "running";

      return jsonWithSessionId(
        {
          ok: true,
          session_id: sessionId,
          status,
          state,
          stage_beacon:
            typeof primaryJob.stage_beacon === "string" && primaryJob.stage_beacon.trim()
              ? primaryJob.stage_beacon.trim()
              : status === "complete"
                ? "primary_complete"
                : status === "error"
                  ? "primary_search_started"
                  : status === "running"
                    ? "primary_search_started"
                    : "primary_search_started",
          stage_beacon_values: stageBeaconValues,
          primary_job_state: jobState,
          last_heartbeat_at: primaryJob?.last_heartbeat_at || null,
          lock_until: primaryJob?.lock_expires_at || null,
          attempts: Number.isFinite(Number(primaryJob?.attempt)) ? Number(primaryJob.attempt) : 0,
          last_error: primaryJob?.last_error || null,
          elapsed_ms: Number.isFinite(Number(primaryJob?.elapsed_ms)) ? Number(primaryJob.elapsed_ms) : null,
          remaining_budget_ms: Number.isFinite(Number(primaryJob?.remaining_budget_ms)) ? Number(primaryJob.remaining_budget_ms) : null,
          upstream_calls_made: Number.isFinite(Number(primaryJob?.upstream_calls_made)) ? Number(primaryJob.upstream_calls_made) : 0,
          companies_candidates_found: Number.isFinite(Number(primaryJob?.companies_candidates_found))
            ? Number(primaryJob.companies_candidates_found)
            : Number.isFinite(Number(primaryJob?.companies_count))
              ? Number(primaryJob.companies_count)
              : 0,
          early_exit_triggered: Boolean(primaryJob?.early_exit_triggered),
          companies_count: Number.isFinite(Number(primaryJob.companies_count)) ? Number(primaryJob.companies_count) : 0,
          items: Array.isArray(primaryJob.companies) ? primaryJob.companies : [],
          primary_job: {
            id: primaryJob.id || null,
            job_state: jobState,
            attempt: Number.isFinite(Number(primaryJob.attempt)) ? Number(primaryJob.attempt) : 0,
            attempts: Number.isFinite(Number(primaryJob.attempt)) ? Number(primaryJob.attempt) : 0,
            last_error: primaryJob.last_error || null,
            elapsed_ms: Number.isFinite(Number(primaryJob?.elapsed_ms)) ? Number(primaryJob.elapsed_ms) : null,
            remaining_budget_ms: Number.isFinite(Number(primaryJob?.remaining_budget_ms)) ? Number(primaryJob.remaining_budget_ms) : null,
            upstream_calls_made: Number.isFinite(Number(primaryJob?.upstream_calls_made)) ? Number(primaryJob.upstream_calls_made) : 0,
            companies_candidates_found: Number.isFinite(Number(primaryJob?.companies_candidates_found))
              ? Number(primaryJob.companies_candidates_found)
              : Number.isFinite(Number(primaryJob?.companies_count))
                ? Number(primaryJob.companies_count)
                : 0,
            early_exit_triggered: Boolean(primaryJob?.early_exit_triggered),
            last_heartbeat_at: primaryJob?.last_heartbeat_at || null,
            lock_expires_at: primaryJob?.lock_expires_at || null,
            locked_by: primaryJob?.locked_by || null,
            etag: primaryJob?._etag || primaryJob?.etag || null,
            storage: primaryJob.storage || null,
          },
          inline_budget_ms: Number.isFinite(Number(primaryJob.inline_budget_ms)) ? Number(primaryJob.inline_budget_ms) : 20_000,
          requested_deadline_ms:
            primaryJob.requested_deadline_ms === null || primaryJob.requested_deadline_ms === undefined
              ? null
              : Number.isFinite(Number(primaryJob.requested_deadline_ms))
                ? Number(primaryJob.requested_deadline_ms)
                : null,
          requested_stage_ms_primary:
            primaryJob.requested_stage_ms_primary === null || primaryJob.requested_stage_ms_primary === undefined
              ? null
              : Number.isFinite(Number(primaryJob.requested_stage_ms_primary))
                ? Number(primaryJob.requested_stage_ms_primary)
                : null,
          note:
            typeof primaryJob.note === "string" && primaryJob.note.trim()
              ? primaryJob.note.trim()
              : "start endpoint is inline capped; long primary runs async",
        },
        200,
        req
      );
    }

    return jsonWithSessionId({ ok: false, error: "Unknown session_id", session_id: sessionId }, 404);
  }

  try {
    if (!CosmosClient) {
      return jsonWithSessionId(
        {
          ok: false,
          session_id: sessionId,
          error: "Cosmos client module unavailable",
          code: "COSMOS_MODULE_MISSING",
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

    const [sessionDoc, completionDoc, timeoutDoc, stopDoc, errorDoc, acceptDoc] = await Promise.all([
      readControlDoc(container, sessionDocId, sessionId),
      readControlDoc(container, completionDocId, sessionId),
      readControlDoc(container, timeoutDocId, sessionId),
      readControlDoc(container, stopDocId, sessionId),
      readControlDoc(container, errorDocId, sessionId),
      readControlDoc(container, acceptDocId, sessionId),
    ]);

    let known = Boolean(sessionDoc || completionDoc || timeoutDoc || stopDoc || errorDoc || acceptDoc);
    if (!known) known = await hasAnyCompanyDocs(container, sessionId);

    if (!known) {
      return jsonWithSessionId({ ok: false, error: "Unknown session_id", session_id: sessionId }, 404);
    }

    stageBeaconValues.status_seen_control_docs = nowIso();

    const errorPayload = normalizeErrorPayload(errorDoc?.error || null);
    const timedOut = Boolean(timeoutDoc);
    const stopped = Boolean(stopDoc);
    const completed = Boolean(completionDoc);

    const items = await fetchRecentCompanies(container, sessionId, take).catch(() => []);
    const saved =
      (typeof completionDoc?.saved === "number" ? completionDoc.saved : null) ??
      (typeof sessionDoc?.saved === "number" ? sessionDoc.saved : null) ??
      (Array.isArray(items) ? items.length : 0);

    const lastCreatedAt = Array.isArray(items) && items.length > 0 ? String(items[0]?.created_at || "") : "";

    const stage_beacon =
      (typeof errorDoc?.stage === "string" && errorDoc.stage.trim() ? errorDoc.stage.trim() : null) ||
      (typeof errorDoc?.error?.step === "string" && errorDoc.error.step.trim() ? errorDoc.error.step.trim() : null) ||
      (typeof sessionDoc?.stage_beacon === "string" && sessionDoc.stage_beacon.trim() ? sessionDoc.stage_beacon.trim() : null) ||
      (typeof acceptDoc?.stage_beacon === "string" && acceptDoc.stage_beacon.trim() ? acceptDoc.stage_beacon.trim() : null) ||
      (completed ? "complete" : timedOut ? "timeout" : stopped ? "stopped" : "running");

    const report = {
      session: sessionDoc
        ? {
            created_at: sessionDoc?.created_at || null,
            request_id: sessionDoc?.request_id || null,
            status: sessionDoc?.status || null,
            stage_beacon: sessionDoc?.stage_beacon || null,
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
            saved: typeof completionDoc?.saved === "number" ? completionDoc.saved : null,
            skipped: typeof completionDoc?.skipped === "number" ? completionDoc.skipped : null,
            failed: typeof completionDoc?.failed === "number" ? completionDoc.failed : null,
            saved_ids: Array.isArray(completionDoc?.saved_ids) ? completionDoc.saved_ids : [],
            skipped_ids: Array.isArray(completionDoc?.skipped_ids) ? completionDoc.skipped_ids : [],
            failed_items: Array.isArray(completionDoc?.failed_items) ? completionDoc.failed_items : [],
          }
        : null,
    };

    if (errorPayload || timedOut || stopped) {
      const errorOut =
        errorPayload ||
        (timedOut
          ? { code: "IMPORT_TIMEOUT", message: "Import timed out" }
          : stopped
            ? { code: "IMPORT_STOPPED", message: "Import was stopped" }
            : null);

      return jsonWithSessionId(
        {
          ok: true,
          session_id: sessionId,
          status: "error",
          state: "failed",
          job_state: null,
          stage_beacon,
          stage_beacon_values: stageBeaconValues,
          primary_job_state: null,
          elapsed_ms: null,
          remaining_budget_ms: null,
          upstream_calls_made: 0,
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
          lastCreatedAt,
          timedOut,
          stopped,
          report,
        },
        200,
        req
      );
    }

    if (completed) {
      return jsonWithSessionId(
        {
          ok: true,
          session_id: sessionId,
          status: "complete",
          state: "complete",
          job_state: null,
          stage_beacon,
          stage_beacon_values: stageBeaconValues,
          primary_job_state: null,
          elapsed_ms: null,
          remaining_budget_ms: null,
          upstream_calls_made: 0,
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
            reason: completionDoc?.reason || null,
            saved_ids: Array.isArray(completionDoc?.saved_ids) ? completionDoc.saved_ids : [],
            skipped_ids: Array.isArray(completionDoc?.skipped_ids) ? completionDoc.skipped_ids : [],
            failed_items: Array.isArray(completionDoc?.failed_items) ? completionDoc.failed_items : [],
          },
          items,
          saved,
          lastCreatedAt,
          report,
        },
        200,
        req
      );
    }

    return jsonWithSessionId(
      {
        ok: true,
        session_id: sessionId,
        status: "running",
        state: "running",
        job_state: null,
        stage_beacon,
        stage_beacon_values: stageBeaconValues,
        primary_job_state: null,
        elapsed_ms: null,
        remaining_budget_ms: null,
        upstream_calls_made: 0,
        companies_candidates_found: 0,
        early_exit_triggered: false,
        last_heartbeat_at: null,
        lock_until: null,
        attempts: 0,
        last_error: null,
        companies_count: saved,
        items,
        saved,
        lastCreatedAt,
        report,
      },
      200,
      req
    );
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

module.exports = { _test: { handler } };
