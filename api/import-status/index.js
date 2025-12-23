const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");
const { getSession: getImportSession } = require("../_importSessionStore");
const { getJob: getImportPrimaryJob } = require("../_importPrimaryJobStore");
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

  const statusCheckedAt = nowIso();
  const stageBeaconValues = {
    status_checked_at: statusCheckedAt,
  };

  let primaryJob = await getImportPrimaryJob({ sessionId, cosmosEnabled: true }).catch(() => null);

  if (primaryJob && primaryJob.job_state) {
    stageBeaconValues.status_seen_primary_job = nowIso();

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

    return json(
      {
        ok: true,
        session_id: sessionId,
        status,
        state,
        stage_beacon:
          typeof primaryJob?.stage_beacon === "string" && primaryJob.stage_beacon.trim()
            ? primaryJob.stage_beacon.trim()
            : status === "complete"
              ? "xai_primary_fetch_complete"
              : status === "queued"
                ? "xai_primary_fetch_queued"
                : status === "running"
                  ? "xai_primary_fetch_running"
                  : "xai_primary_fetch_error",
        stage_beacon_values: stageBeaconValues,
        primary_job_state: finalJobState,
        last_heartbeat_at: primaryJob?.last_heartbeat_at || null,
        lock_until: primaryJob?.lock_expires_at || null,
        attempts: Number.isFinite(Number(primaryJob?.attempt)) ? Number(primaryJob.attempt) : 0,
        last_error: primaryJob?.last_error || null,
        worker_meta: workerResult?.body?.meta || null,
        companies_count: Number.isFinite(Number(primaryJob?.companies_count)) ? Number(primaryJob.companies_count) : 0,
        items: status === "error" ? [] : Array.isArray(primaryJob?.companies) ? primaryJob.companies : [],
        primary_job: {
          id: primaryJob?.id || null,
          job_state: finalJobState,
          attempt: Number.isFinite(Number(primaryJob?.attempt)) ? Number(primaryJob.attempt) : 0,
          attempts: Number.isFinite(Number(primaryJob?.attempt)) ? Number(primaryJob.attempt) : 0,
          last_error: primaryJob?.last_error || null,
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
      },
      200,
      req
    );
  }

  const mem = getImportSession(sessionId);
  if (mem) {
    stageBeaconValues.status_seen_session_memory = nowIso();

    return json(
      {
        ok: true,
        session_id: sessionId,
        status: mem.status || "running",
        state: mem.status === "complete" ? "complete" : mem.status === "failed" ? "failed" : "running",
        stage_beacon: mem.stage_beacon || "init",
        stage_beacon_values: stageBeaconValues,
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

      return json(
        {
          ok: true,
          session_id: sessionId,
          status,
          state,
          stage_beacon:
            typeof primaryJob.stage_beacon === "string" && primaryJob.stage_beacon.trim()
              ? primaryJob.stage_beacon.trim()
              : status === "complete"
                ? "xai_primary_fetch_complete"
                : status === "error"
                  ? "xai_primary_fetch_error"
                  : status === "running"
                    ? "xai_primary_fetch_running"
                    : "xai_primary_fetch_queued",
          stage_beacon_values: stageBeaconValues,
          primary_job_state: jobState,
          last_heartbeat_at: primaryJob?.last_heartbeat_at || null,
          lock_until: primaryJob?.lock_expires_at || null,
          attempts: Number.isFinite(Number(primaryJob?.attempt)) ? Number(primaryJob.attempt) : 0,
          last_error: primaryJob?.last_error || null,
          companies_count: Number.isFinite(Number(primaryJob.companies_count)) ? Number(primaryJob.companies_count) : 0,
          items: Array.isArray(primaryJob.companies) ? primaryJob.companies : [],
          primary_job: {
            id: primaryJob.id || null,
            job_state: jobState,
            attempt: Number.isFinite(Number(primaryJob.attempt)) ? Number(primaryJob.attempt) : 0,
            attempts: Number.isFinite(Number(primaryJob.attempt)) ? Number(primaryJob.attempt) : 0,
            last_error: primaryJob.last_error || null,
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

    return json({ ok: false, error: "Unknown session_id", session_id: sessionId }, 404, req);
  }

  try {
    const client = new CosmosClient({ endpoint, key });
    const container = client.database(databaseId).container(containerId);

    const sessionDocId = `_import_session_${sessionId}`;
    const completionDocId = `_import_complete_${sessionId}`;
    const timeoutDocId = `_import_timeout_${sessionId}`;
    const stopDocId = `_import_stop_${sessionId}`;
    const errorDocId = `_import_error_${sessionId}`;

    const [sessionDoc, completionDoc, timeoutDoc, stopDoc, errorDoc] = await Promise.all([
      readControlDoc(container, sessionDocId, sessionId),
      readControlDoc(container, completionDocId, sessionId),
      readControlDoc(container, timeoutDocId, sessionId),
      readControlDoc(container, stopDocId, sessionId),
      readControlDoc(container, errorDocId, sessionId),
    ]);

    let known = Boolean(sessionDoc || completionDoc || timeoutDoc || stopDoc || errorDoc);
    if (!known) known = await hasAnyCompanyDocs(container, sessionId);

    if (!known) {
      return json({ ok: false, error: "Unknown session_id", session_id: sessionId }, 404, req);
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
      (completed ? "complete" : timedOut ? "timeout" : stopped ? "stopped" : "running");

    if (errorPayload || timedOut || stopped) {
      const errorOut =
        errorPayload ||
        (timedOut
          ? { code: "IMPORT_TIMEOUT", message: "Import timed out" }
          : stopped
            ? { code: "IMPORT_STOPPED", message: "Import was stopped" }
            : null);

      return json(
        {
          ok: true,
          session_id: sessionId,
          status: "error",
          state: "failed",
          stage_beacon,
          companies_count: saved,
          error: errorOut,
          items,
          saved,
          lastCreatedAt,
          timedOut,
          stopped,
        },
        200,
        req
      );
    }

    if (completed) {
      return json(
        {
          ok: true,
          session_id: sessionId,
          status: "complete",
          state: "complete",
          stage_beacon,
          companies_count: saved,
          result: {
            saved,
            completed_at: completionDoc?.completed_at || completionDoc?.created_at || null,
            reason: completionDoc?.reason || null,
          },
          items,
          saved,
          lastCreatedAt,
        },
        200,
        req
      );
    }

    return json(
      {
        ok: true,
        session_id: sessionId,
        status: "running",
        state: "running",
        stage_beacon,
        companies_count: saved,
        items,
        saved,
        lastCreatedAt,
      },
      200,
      req
    );
  } catch (e) {
    const msg = e?.message || String(e);
    try {
      console.error(`[import-status] session=${sessionId} error: ${msg}`);
    } catch {}
    return json({ ok: false, error: "Status handler failure", detail: msg, session_id: sessionId }, 500, req);
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
