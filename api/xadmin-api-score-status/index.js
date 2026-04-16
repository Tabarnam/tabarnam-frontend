const { app } = require("../_app");
const { CosmosClient } = require("@azure/cosmos");
const { enqueueResumeRun } = require("../_enrichmentQueue");

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

// Self-drive tuning (mirrors import-status → primary-worker pattern):
//   - Every status poll invokes the batch worker ONLY if the job is running
//     AND the lock is free (or expired). The worker runs a bounded 4-min
//     invocation and yields; the next poll re-invokes to continue.
//   - Stale lock = lock_expires_at is in the past. Lets recovery happen
//     automatically after a function timeout / worker recycle.
//   - Stale heartbeat = last_heartbeat_at > HEARTBEAT_STALE_MS ago. This is
//     PURELY INFORMATIONAL for the UI ("this wave is taking a while"); it
//     does NOT drive a new worker fire. The worker itself heartbeats every
//     20s mid-wave (see IN_WAVE_HEARTBEAT_MS in xadmin-api-score-all-missing),
//     so a stale heartbeat WITH a valid lock means the worker is doing work
//     — firing another worker would just bounce off the lock and spam logs.
//   - The lock TTL (5 min, set by the worker) is the real recovery mechanism:
//     if a worker dies silently, the lock expires and the next poll drives
//     a fresh worker.
const HEARTBEAT_STALE_MS = 120_000;    // 2 min — surfaced to UI, not a drive trigger
const SELF_DRIVE_TIMEOUT_MS = 8_000;   // Don't let status calls block > 8s on worker fire-off

// Resolve worker URL from same env as frontend would hit. We call the worker
// via HTTP so it runs on its own Azure Function invocation (separate timeout
// budget from the status call).
function getSelfOrigin(req) {
  // Try x-forwarded-host first (SWA), then req.url
  const hdrs = req?.headers || {};
  const fwdHost = typeof hdrs.get === "function" ? hdrs.get("x-forwarded-host") : hdrs["x-forwarded-host"];
  const fwdProto = typeof hdrs.get === "function" ? hdrs.get("x-forwarded-proto") : hdrs["x-forwarded-proto"];
  if (fwdHost) {
    return `${fwdProto || "https"}://${fwdHost}`;
  }
  try {
    const u = new URL(req.url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "http://localhost";
  }
}

async function fireBatchWorker({ origin, jobId, context }) {
  const url = `${origin}/api/xadmin-api-score-batch-worker`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SELF_DRIVE_TIMEOUT_MS);
  try {
    // Fire-and-forget: we send the request but don't wait for scoring to
    // complete. The worker runs on its own Azure Function invocation and
    // keeps running after our status call returns. This is the same pattern
    // import-status uses to drive the primary-worker.
    //
    // We only wait long enough to confirm the worker accepted the request
    // (lock was claimed or declined). That response comes back within a few
    // ms of the HTTP 200 — but if it doesn't, we abort and return.
    const fetchPromise = fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId }),
      signal: ctl.signal,
      // keepalive lets the request continue after the status handler returns,
      // but Node's fetch implementation may not honor it; worst case the
      // worker is called but the response is discarded — that's fine.
      keepalive: true,
    });

    // We only need ~200ms — the worker responds quickly with lock claim status
    // and then keeps processing in the background. If we waited for the full
    // 4-min scoring cycle, the status endpoint would block poll responses.
    const race = await Promise.race([
      fetchPromise.then((r) => ({ ok: r.ok, status: r.status })),
      new Promise((res) => setTimeout(() => res({ ok: true, status: "fire_and_forget" }), 800)),
    ]);
    return race;
  } catch (e) {
    // AbortError or network error — the worker may still have started
    context.log(`[score-status] fireBatchWorker soft-error: ${e?.message || e}`);
    return { ok: true, status: "dispatched_no_ack" };
  } finally {
    clearTimeout(timer);
  }
}

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

const json = (obj, status = 200) => ({
  status,
  headers: getCorsHeaders(),
  body: JSON.stringify(obj),
});

let cosmosClient = null;

function getCosmosClient() {
  const endpoint = E("COSMOS_DB_ENDPOINT");
  const key = E("COSMOS_DB_KEY");
  if (!endpoint || !key) return null;
  cosmosClient ||= new CosmosClient({ endpoint, key });
  return cosmosClient;
}

function getCompaniesContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_COMPANIES_CONTAINER", "companies");
  return client.database(databaseId).container(containerId);
}

function getBackfillJobsContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_BACKFILL_JOBS_CONTAINER", "backfill_jobs");
  return client.database(databaseId).container(containerId);
}

async function adminScoreStatusHandler(req, context) {
  const method = String(req.method || "").toUpperCase();
  if (method === "OPTIONS") {
    return { status: 200, headers: getCorsHeaders() };
  }

  const companiesContainer = getCompaniesContainer();
  const jobsContainer = getBackfillJobsContainer();
  if (!companiesContainer || !jobsContainer) {
    return json({ error: "Cosmos DB not configured" }, 500);
  }

  try {
    const url = new URL(req.url || "http://localhost", "http://localhost");
    const action = url.searchParams.get("action");
    const actionJobId = url.searchParams.get("job_id");

    // Handle actions: pause, resume, cancel
    if (action && actionJobId) {
      let job;
      try {
        const { resource } = await jobsContainer.item(`job_${actionJobId}`, actionJobId).read();
        job = resource;
      } catch (e) {
        return json({ error: `Job not found: ${e?.message || e}` }, 404);
      }

      if (!job) {
        return json({ error: "Job not found" }, 404);
      }

      if (action === "pause") {
        job.status = "paused";
        job.last_updated = new Date().toISOString();
        await jobsContainer.items.upsert(job, { partitionKey: actionJobId });
        context.log(`[score-status] Paused job ${actionJobId}`);
        return json({ ok: true, action: "paused", job_id: actionJobId });
      }

      if (action === "resume") {
        job.status = "running";
        // Clear any stale lock so the next status poll will drive a fresh worker.
        job.locked_by = null;
        job.lock_expires_at = null;
        job.last_updated = new Date().toISOString();
        await jobsContainer.items.upsert(job, { partitionKey: actionJobId });

        // Legacy: also enqueue a queue-trigger run (harmless on Flex Consumption
        // where the queue trigger doesn't poll reliably). The self-drive loop
        // in the default status branch is the primary driver.
        const enqueueResult = await enqueueResumeRun({
          session_id: actionJobId,
          reason: "backfill_score",
          run_after_ms: 0,
          cycle_count: job.cycle_count || 0,
          requested_by: "admin_resume",
        });

        context.log(`[score-status] Resumed job ${actionJobId}, enqueue_ok=${enqueueResult?.ok}`);
        return json({ ok: true, action: "resumed", job_id: actionJobId, enqueue_ok: enqueueResult?.ok ?? false });
      }

      if (action === "cancel") {
        job.status = "cancelled";
        job.last_updated = new Date().toISOString();
        await jobsContainer.items.upsert(job, { partitionKey: actionJobId });
        context.log(`[score-status] Cancelled job ${actionJobId}`);
        return json({ ok: true, action: "cancelled", job_id: actionJobId });
      }

      return json({ error: `Unknown action: ${action}` }, 400);
    }

    // ?action=list-all — returns a compact summary of every company with
    // scoring status, suitable for client-side search/filter in the admin UI.
    if (action === "list-all") {
      const listQuery = `SELECT c.id, c.company_name, c.name, c.normalized_domain, c.domain, c.is_deleted, c.type, c.source, c.updated_at, c.rating FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND NOT STARTSWITH(c.id, 'refresh_job_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')`;
      const { resources } = await companiesContainer.items
        .query(listQuery, { enableCrossPartitionQuery: true })
        .fetchAll();
      const companies = (resources || []).map((c) => {
        const ratingObj =
          c && c.rating && typeof c.rating === "object" && !Array.isArray(c.rating) ? c.rating : {};
        const star4Obj = ratingObj.star4 && typeof ratingObj.star4 === "object" ? ratingObj.star4 : null;
        const star5Obj = ratingObj.star5 && typeof ratingObj.star5 === "object" ? ratingObj.star5 : null;
        const star4Value = star4Obj && typeof star4Obj.value === "number" ? star4Obj.value : null;
        const star5Value = star5Obj && typeof star5Obj.value === "number" ? star5Obj.value : null;
        const star4Reasoning = star4Obj && typeof star4Obj.reasoning === "string" ? star4Obj.reasoning : "";
        const star5Reasoning = star5Obj && typeof star5Obj.reasoning === "string" ? star5Obj.reasoning : "";
        const hasValue = typeof star4Value === "number" && star4Value > 0;
        const hasReasoning = Boolean(star4Reasoning);
        // scored = has an xAI-quality score (value AND reasoning)
        // manual = has value but no reasoning (admin-set)
        // unscored = no value
        let state = "unscored";
        if (hasValue && hasReasoning) state = "scored";
        else if (hasValue) state = "manual";
        return {
          id: c.id,
          name: c.company_name || c.name || null,
          domain: c.normalized_domain || c.domain || null,
          source: c.source ?? null,
          star4: star4Value,
          star5: star5Value,
          has_reasoning_star4: Boolean(star4Reasoning),
          has_reasoning_star5: Boolean(star5Reasoning),
          state,
          updated_at: c.updated_at ?? null,
        };
      });
      return json({ ok: true, count: companies.length, companies });
    }

    // Diagnostic: ?action=list-scored — returns the list of companies where
    // rating.star4.value > 0 with enough fields to identify them.
    if (action === "list-scored") {
      const listQuery = `SELECT c.id, c.company_name, c.name, c.normalized_domain, c.domain, c.is_deleted, c.type, c.source, c.created_at, c.updated_at, c.rating FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND NOT STARTSWITH(c.id, 'refresh_job_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')`;
      const { resources } = await companiesContainer.items
        .query(listQuery, { enableCrossPartitionQuery: true })
        .fetchAll();
      const scored = (resources || [])
        .filter((r) => {
          const v =
            r && r.rating && typeof r.rating === "object" && !Array.isArray(r.rating) && r.rating.star4 && typeof r.rating.star4 === "object"
              ? r.rating.star4.value
              : undefined;
          return typeof v === "number" && v > 0;
        })
        .map((c) => ({
          id: c.id,
          name: c.company_name || c.name || null,
          domain: c.normalized_domain || c.domain || null,
          is_deleted: c.is_deleted ?? null,
          type: c.type ?? null,
          source: c.source ?? null,
          star4: c.rating?.star4?.value ?? null,
          star5: c.rating?.star5?.value ?? null,
          has_reasoning_star4: Boolean(c.rating?.star4?.reasoning),
          has_reasoning_star5: Boolean(c.rating?.star5?.reasoning),
          created_at: c.created_at ?? null,
          updated_at: c.updated_at ?? null,
        }));
      // Sort by updated_at desc (most recent first)
      scored.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
      return json({ ok: true, count: scored.length, scored });
    }

    // Default: return status counts + latest active job.
    // Wrap each query in its own try/catch so one failure doesn't kill the whole response.

    let totalCompanies = null;
    let scoredCompanies = null;
    let missingCompanies = null;
    let queryError = null;

    // Single query projecting star4.value — count scored in JS to avoid
    // Cosmos type-coercion errors on heterogeneous rating fields (Cosmos AND
    // doesn't guarantee short-circuit, so IS_NUMBER + value > 0 can still
    // throw "One of the input values is invalid" on string-typed values).
    try {
      const allQuery = `SELECT c.id, c.rating FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND NOT STARTSWITH(c.id, 'refresh_job_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')`;
      const { resources: rows } = await companiesContainer.items
        .query(allQuery, { enableCrossPartitionQuery: true })
        .fetchAll();
      const list = rows || [];
      totalCompanies = list.length;
      scoredCompanies = list.filter((r) => {
        const v = r && r.rating && typeof r.rating === "object" && !Array.isArray(r.rating)
          ? r.rating.star4 && typeof r.rating.star4 === "object" ? r.rating.star4.value : undefined
          : undefined;
        return typeof v === "number" && v > 0;
      }).length;
      missingCompanies = totalCompanies - scoredCompanies;
    } catch (e) {
      context.log(`[score-status] allQuery error: ${e?.message || e}`);
      queryError = `allQuery: ${e?.message || e}`;
    }

    // Load latest job — fetch all and sort in JS (avoids ORDER BY indexing issues on empty container)
    let latestJob = null;
    try {
      const { resources: jobs } = await jobsContainer.items
        .query("SELECT * FROM c", { enableCrossPartitionQuery: true })
        .fetchAll();
      if (jobs && jobs.length > 0) {
        jobs.sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
        latestJob = jobs[0];
      }
    } catch (e) {
      context.log(`[score-status] jobs query error: ${e?.message || e}`);
      // Empty/missing container is OK — just no job to return
    }

    // ── Self-drive: if the latest job is "running" AND its worker lock is
    // free (or expired), fire off the batch worker. This is the mechanism
    // that drives a large backfill to completion across multiple function
    // invocations without the frontend needing to kick anything.
    //
    // We deliberately do NOT fire on a stale heartbeat alone — if the lock
    // is still held and valid, the worker is alive (or will be recovered
    // when its lock TTL expires). Firing a new worker against a live lock
    // just wastes invocations and spams the log with lock_not_claimed
    // bounces. Stale heartbeat is surfaced via `heartbeat_stale` in the
    // drive info so the UI can show a "this is taking a while" indicator.
    let driveInfo = null;
    if (latestJob && latestJob.status === "running") {
      const now = Date.now();
      const lockExpiresAt = Date.parse(latestJob.lock_expires_at || "") || 0;
      const lastHeartbeatAt = Date.parse(latestJob.last_heartbeat_at || "") || 0;
      const lockFree = !latestJob.locked_by || lockExpiresAt <= now;
      const heartbeatStale = lastHeartbeatAt && (now - lastHeartbeatAt) > HEARTBEAT_STALE_MS;

      if (lockFree) {
        const origin = getSelfOrigin(req);
        try {
          const fired = await fireBatchWorker({ origin, jobId: latestJob.job_id, context });
          driveInfo = {
            fired: true,
            lock_free: true,
            heartbeat_stale: heartbeatStale,
            response: fired?.status ?? null,
          };
          context.log(`[score-status] self-drive fired worker for ${latestJob.job_id} (lock_free=true, hb_stale=${heartbeatStale})`);
        } catch (e) {
          driveInfo = { fired: false, error: e?.message || String(e) };
        }
      } else {
        driveInfo = {
          fired: false,
          reason: "worker_active",
          lock_expires_in_s: Math.round((lockExpiresAt - now) / 1000),
          heartbeat_stale: heartbeatStale,
        };
      }
    }

    return json({
      ok: true,
      total_companies: totalCompanies,
      scored_companies: scoredCompanies,
      missing_companies: missingCompanies,
      job: latestJob || null,
      ...(driveInfo ? { drive: driveInfo } : {}),
      ...(queryError ? { query_error: queryError } : {}),
    });
  } catch (e) {
    context.log("Error in admin-score-status:", e?.message || e, e?.stack || "");
    return json({ error: e?.message || "Internal error" }, 500);
  }
}

app.http("adminScoreStatus", {
  route: "xadmin-api-score-status",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: adminScoreStatusHandler,
});

module.exports = { handler: adminScoreStatusHandler };
