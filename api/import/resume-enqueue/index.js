let app;
try {
  ({ app } = require("../../_app"));
} catch {
  app = { http() {} };
}

let CosmosClient;
try {
  ({ CosmosClient } = require("@azure/cosmos"));
} catch {
  CosmosClient = null;
}

const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
  getValueAtPath,
} = require("../../_cosmosPartitionKey");

const { enqueueResumeRun, resolveQueueConfig } = require("../../_enrichmentQueue");
const { invokeResumeWorkerInProcess } = require("../resume-worker/handler");

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function nowIso() {
  return new Date().toISOString();
}

function cors(req) {
  const origin = req?.headers?.get?.("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers":
      "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id",
  };
}

function json(obj, status = 200, req) {
  return {
    status,
    headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj),
  };
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

async function upsertWithPkCandidates(container, doc) {
  const id = asString(doc?.id).trim();
  if (!id) return { ok: false, error: "missing_id" };

  const pkPath = await getCompaniesPkPath(container);
  const pkValue = getValueAtPath(doc, pkPath);

  const candidates = buildPartitionKeyCandidates({
    pkValue,
    requested: asString(doc?.partition_key).trim() || asString(doc?.normalized_domain).trim() || asString(doc?.session_id).trim(),
    sessionId: asString(doc?.session_id).trim(),
    normalizedDomain: asString(doc?.normalized_domain).trim(),
    domain: asString(doc?.domain).trim(),
    max: 12,
  });

  for (const candidate of candidates) {
    try {
      const { resource } = await container.item(id, candidate).upsert(doc);
      return { ok: true, resource };
    } catch {
      // try next candidate
    }
  }

  return { ok: false, error: "upsert_failed" };
}

async function readWithPkCandidates(container, id, sessionId) {
  const pkPath = await getCompaniesPkPath(container);

  const candidates = buildPartitionKeyCandidates({
    pkValue: null,
    requested: "import",
    sessionId,
    normalizedDomain: "import",
    max: 12,
  });

  for (const candidate of candidates) {
    try {
      const { resource } = await container.item(id, candidate).read();
      if (resource) return resource;
    } catch {
      // ignore
    }
  }

  // Final brute-force attempt with session id partition key candidate.
  if (pkPath && pkPath !== "/normalized_domain") {
    try {
      const { resource } = await container.item(id, sessionId).read();
      if (resource) return resource;
    } catch {}
  }

  return null;
}

async function importResumeEnqueueHandler(req, context) {
  const method = asString(req?.method).toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: cors(req) };

    if (method !== "POST") {
      return json({ ok: false, error: "method_not_allowed" }, 405, req);
    }

    let body = {};
    try {
      body = (await req.json().catch(() => ({}))) || {};
    } catch {}

    const sessionId = asString(body?.session_id || body?.sessionId).trim();
    if (!sessionId) return json({ ok: false, error: "session_id is required" }, 400, req);

    const reason = asString(body?.reason).trim() || "manual_retry";
    const requestedBy = asString(body?.requested_by).trim() || "admin";

    // Check for direct=1 query parameter to bypass the Azure Queue and invoke the worker directly
    let directMode = false;
    try {
      const url = typeof req.url === "string" ? new URL(req.url, "http://localhost") : null;
      directMode = url?.searchParams?.get("direct") === "1";
    } catch {}

    // If direct mode, invoke the resume worker in-process (bypasses Azure Queue trigger issues)
    if (directMode) {
      const invokeStart = nowIso();
      let workerResult = null;
      let workerError = null;

      try {
        workerResult = await invokeResumeWorkerInProcess({
          session_id: sessionId,
          context,
        });
      } catch (e) {
        workerError = e?.message || String(e || "invoke_failed");
      }

      return json(
        {
          ok: Boolean(workerResult?.ok),
          session_id: sessionId,
          mode: "direct",
          invoked_at: invokeStart,
          reason,
          requested_by: requestedBy,
          worker_result: workerResult
            ? {
                ok: workerResult.ok,
                status: workerResult.status,
                gateway_key_attached: workerResult.gateway_key_attached,
                request_id: workerResult.request_id,
              }
            : null,
          error: workerError || (workerResult?.ok ? null : "worker_failed"),
        },
        workerResult?.ok ? 200 : 500,
        req
      );
    }

    const cfg = resolveQueueConfig();

    const endpoint = asString(process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT).trim();
    const key = asString(process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY).trim();
    const databaseId = asString(process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = asString(process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

    let cosmos = { enabled: Boolean(endpoint && key && CosmosClient), wrote_session: false, wrote_resume: false };

    let resumeDoc = null;
    let sessionDoc = null;
    let cycleCount = null;

    if (cosmos.enabled) {
      try {
        const client = new CosmosClient({ endpoint, key });
        const container = client.database(databaseId).container(containerId);

        resumeDoc = await readWithPkCandidates(container, `_import_resume_${sessionId}`, sessionId).catch(() => null);
        sessionDoc = await readWithPkCandidates(container, `_import_session_${sessionId}`, sessionId).catch(() => null);

        cycleCount = Number.isFinite(Number(resumeDoc?.cycle_count)) ? Number(resumeDoc.cycle_count) : null;
      } catch {
        cosmos.enabled = false;
      }
    }

    const enqueueAt = nowIso();

    const enqueueRes = await enqueueResumeRun({
      session_id: sessionId,
      reason,
      requested_by: requestedBy,
      enqueue_at: enqueueAt,
      ...(Number.isFinite(Number(cycleCount)) ? { cycle_count: cycleCount } : {}),
    });

    if (cosmos.enabled) {
      try {
        const client = new CosmosClient({ endpoint, key });
        const container = client.database(databaseId).container(containerId);

        // Session patch: write resume-related fields so status can reflect reality
        // Required fields: resume_last_triggered_at, resume_triggered_by, resume_trigger_reason, resume_message_id, resume_status
        const sessionDocId = `_import_session_${sessionId}`;
        const sessionBase = sessionDoc && typeof sessionDoc === "object"
          ? sessionDoc
          : {
              id: sessionDocId,
              session_id: sessionId,
              normalized_domain: "import",
              partition_key: "import",
              type: "import_session",
              created_at: enqueueAt,
            };

        const sessionPatched = {
          ...sessionBase,
          resume_last_triggered_at: enqueueRes.ok ? enqueueAt : sessionBase.resume_last_triggered_at || null,
          resume_triggered_by: enqueueRes.ok ? requestedBy : sessionBase.resume_triggered_by || null,
          resume_trigger_reason: enqueueRes.ok ? reason : sessionBase.resume_trigger_reason || null,
          resume_message_id: enqueueRes.ok ? (enqueueRes.message_id || null) : sessionBase.resume_message_id || null,
          resume_status: enqueueRes.ok ? "queued" : sessionBase.resume_status || null,
          resume_worker_last_enqueued_at: enqueueAt,
          resume_worker_last_enqueue_reason: reason,
          resume_worker_last_enqueue_ok: Boolean(enqueueRes.ok),
          resume_worker_last_enqueue_error: enqueueRes.ok ? null : enqueueRes.error || "enqueue_failed",
          updated_at: enqueueAt,
        };
        const sessionUp = await upsertWithPkCandidates(container, sessionPatched).catch(() => ({ ok: false }));
        cosmos.wrote_session = Boolean(sessionUp.ok);

        // Resume doc upsert: create or update with status, queue_name, message_id, enqueued_at, attempt
        // This makes status truthful even if the worker is slow
        const resumeDocId = `_import_resume_${sessionId}`;
        const currentAttempt = Number.isFinite(Number(resumeDoc?.attempt)) ? Number(resumeDoc.attempt) : 0;
        const nextAllowed = enqueueRes.ok ? null : resumeDoc?.next_allowed_run_at || null;

        const resumeBase = resumeDoc && typeof resumeDoc === "object"
          ? resumeDoc
          : {
              id: resumeDocId,
              session_id: sessionId,
              normalized_domain: "import",
              partition_key: "import",
              type: "import_control",
              created_at: enqueueAt,
              doc_created: false,
            };

        const resumePatched = {
          ...resumeBase,
          status: enqueueRes.ok ? "queued" : resumeBase.status || "queued",
          queue_name: cfg.queueName || "import-resume-worker",
          message_id: enqueueRes.ok ? (enqueueRes.message_id || null) : resumeBase.message_id || null,
          enqueued_at: enqueueRes.ok ? enqueueAt : resumeBase.enqueued_at || null,
          enrichment_queued_at: enqueueRes.ok ? enqueueAt : resumeBase.enrichment_queued_at || null,
          next_allowed_run_at: nextAllowed,
          attempt: currentAttempt,
          doc_created: true,
          updated_at: enqueueAt,
        };
        const resumeUp = await upsertWithPkCandidates(container, resumePatched).catch(() => ({ ok: false }));
        cosmos.wrote_resume = Boolean(resumeUp.ok);

        // Log for debugging
        try {
          console.log("[import-resume-enqueue] cosmos_write_result", {
            session_id: sessionId,
            wrote_session: cosmos.wrote_session,
            wrote_resume: cosmos.wrote_resume,
            enqueue_ok: Boolean(enqueueRes.ok),
            message_id: enqueueRes.message_id || null,
          });
        } catch {}
      } catch {
        // ignore
      }
    }

    return json(
      {
        ok: Boolean(enqueueRes.ok),
        session_id: sessionId,
        enqueued_at: enqueueAt,
        reason,
      requested_by: requestedBy,
      queue: enqueueRes.queue || (cfg.queueName ? { provider: cfg.provider, name: cfg.queueName } : null),
      message_id: enqueueRes.message_id || null,
      error: enqueueRes.ok ? null : enqueueRes.error || "enqueue_failed",
      cosmos,
    },
    200,
    req
  );
}

app.http("import-resume-enqueue", {
  route: "import/resume-enqueue",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: importResumeEnqueueHandler,
});

module.exports = { handler: importResumeEnqueueHandler };
