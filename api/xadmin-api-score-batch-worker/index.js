const { app } = require("../_app");
const { CosmosClient } = require("@azure/cosmos");

// Budget-aware single-cycle worker. Claims the job lock, drives one bounded
// invocation of processBackfillScoreBatch (which runs parallel waves inside
// its budget), releases the lock, and returns. To run a large backfill to
// completion UNATTENDED, the worker self-chains: when a cycle ends with the
// job still "running" and remaining > 0, it fires the next cycle (fire-and-
// forget). The frontend's /xadmin-api-score-status polling also re-invokes
// this worker when the Scores page is open; the per-invocation lock makes the
// two drivers safe to coexist (the loser of the race just gets claimed:false).
//
// Route: POST /api/xadmin-api-score-batch-worker
// Body:  { job_id | session_id, cycle_count?, invocation_budget_ms? }
// Anonymous (same posture as /api/import/primary-worker).

const LOCK_TTL_MS = 5 * 60 * 1000;   // 5 min — enough for one invocation + slack
const DEFAULT_INVOCATION_BUDGET_MS = 4 * 60 * 1000; // 4 min — stays well under Azure's 10-min kill

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

const json = (obj, status = 200) => ({
  status,
  headers: getCorsHeaders(),
  body: JSON.stringify(obj),
});

// Self-chain: fire the next cycle for this job (fire-and-forget). Uses
// WEBSITE_HOSTNAME (set on the Function App). The per-invocation lock prevents
// overlap with the status-endpoint self-drive.
async function fireNextCycle(jobId, context) {
  const host = (process.env.WEBSITE_HOSTNAME || "").trim();
  if (!host) {
    context.log(`[score-batch-worker] self-chain skipped: WEBSITE_HOSTNAME not set`);
    return;
  }
  const url = `https://${host}/api/xadmin-api-score-batch-worker`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    await Promise.race([
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...require("../_internalJobAuth").buildInternalFetchHeaders() },
        body: JSON.stringify({ job_id: jobId }),
        signal: ctl.signal,
        keepalive: true,
      }).catch(() => null),
      new Promise((res) => setTimeout(res, 800)),
    ]);
  } catch (e) {
    context.log(`[score-batch-worker] self-chain soft-error: ${e?.message || e}`);
  } finally {
    clearTimeout(timer);
  }
}

let cosmosClient = null;

function getCosmosClient() {
  const endpoint = E("COSMOS_DB_ENDPOINT");
  const key = E("COSMOS_DB_KEY");
  if (!endpoint || !key) return null;
  cosmosClient ||= require("../_cosmosConfig").getCosmosClient();
  return cosmosClient;
}

function getBackfillJobsContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_BACKFILL_JOBS_CONTAINER", "backfill_jobs");
  return client.database(databaseId).container(containerId);
}

/**
 * Try to claim the job lock for this worker invocation.
 * Returns { claimed: true, job } if we own the lock, or
 *         { claimed: false, job, reason } if another worker holds it.
 *
 * Mirrors the import primary-worker's pessimistic-lock pattern, but simpler:
 * we don't use etag-based compare-and-swap here because the Cosmos SDK's
 * `upsert` returns success even under write contention; instead we rely on
 * the lock TTL to bound orphan-lock damage to LOCK_TTL_MS.
 */
async function tryClaimLock({ jobsContainer, jobId, workerId, context }) {
  let job;
  try {
    const { resource } = await jobsContainer.item(`job_${jobId}`, jobId).read();
    job = resource;
  } catch (e) {
    return { claimed: false, job: null, reason: `read_failed: ${e?.message || e}` };
  }
  if (!job) return { claimed: false, job: null, reason: "job_not_found" };

  if (job.status !== "running") {
    return { claimed: false, job, reason: `job_status=${job.status}` };
  }

  const now = Date.now();
  const lockedBy = String(job.locked_by || "").trim();
  const lockExpiresAt = Date.parse(job.lock_expires_at || "") || 0;

  if (lockedBy && lockedBy !== workerId && lockExpiresAt > now) {
    return {
      claimed: false,
      job,
      reason: `locked_by=${lockedBy}, expires_in=${((lockExpiresAt - now) / 1000).toFixed(0)}s`,
    };
  }

  // Stale or free lock — claim it
  job.locked_by = workerId;
  job.lock_expires_at = new Date(now + LOCK_TTL_MS).toISOString();
  job.last_heartbeat_at = new Date(now).toISOString();
  job.last_updated = job.last_heartbeat_at;

  try {
    await jobsContainer.items.upsert(job, { partitionKey: jobId });
    return { claimed: true, job };
  } catch (e) {
    return { claimed: false, job, reason: `upsert_failed: ${e?.message || e}` };
  }
}

async function releaseLock({ jobsContainer, jobId, workerId, context }) {
  try {
    const { resource: fresh } = await jobsContainer.item(`job_${jobId}`, jobId).read();
    if (!fresh) return;
    // Only release if we still own it — avoid clobbering a successor's lock
    if (String(fresh.locked_by || "") !== workerId) return;
    fresh.locked_by = null;
    fresh.lock_expires_at = null;
    fresh.last_updated = new Date().toISOString();
    await jobsContainer.items.upsert(fresh, { partitionKey: jobId });
  } catch (e) {
    context.log(`[score-batch-worker] releaseLock failed: ${e?.message || e}`);
  }
}

async function adminScoreBatchWorkerHandler(req, context) {
  const method = String(req?.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: getCorsHeaders() };

  let body = {};
  try { body = (await req.json()) || {}; } catch { body = {}; }

  const jobId = String(body?.job_id || body?.session_id || "").trim();
  if (!jobId) return json({ ok: false, error: "Missing job_id" }, 400);

  const invocationBudgetMs = Math.max(
    30_000,
    Math.min(9 * 60 * 1000, Number(body?.invocation_budget_ms) || DEFAULT_INVOCATION_BUDGET_MS)
  );

  const jobsContainer = getBackfillJobsContainer();
  if (!jobsContainer) return json({ ok: false, error: "Cosmos DB not configured" }, 500);

  // Unique worker identity per invocation (used for lock ownership).
  const workerId = `score-batch-worker-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;

  let processBackfillScoreBatch;
  try {
    ({ processBackfillScoreBatch } = require("../xadmin-api-score-all-missing/index.js"));
  } catch (e) {
    context.log(`[score-batch-worker] Failed to load batch processor: ${e?.message || e}`);
    return json({ ok: false, error: "batch_processor_unavailable", detail: e?.message || String(e) }, 500);
  }

  const startedAt = Date.now();
  context.log(`[score-batch-worker] start job=${jobId} worker=${workerId} budget=${(invocationBudgetMs / 1000).toFixed(0)}s`);

  // Claim the lock
  const claim = await tryClaimLock({ jobsContainer, jobId, workerId, context });
  if (!claim.claimed) {
    context.log(`[score-batch-worker] lock_not_claimed job=${jobId} reason=${claim.reason}`);
    return json({
      ok: true,
      job_id: jobId,
      claimed: false,
      reason: claim.reason,
      job_status: claim.job?.status || null,
    });
  }

  // Drive one bounded invocation. processBackfillScoreBatch runs parallel
  // waves inside its budget and exits cleanly when budget is exhausted or
  // work is complete.
  let result;
  try {
    result = await processBackfillScoreBatch(
      {
        session_id: jobId,
        reason: "backfill_score",
        requested_by: "score_batch_worker",
        invocationBudgetMs,
      },
      context
    );
  } catch (e) {
    context.log(`[score-batch-worker] processBackfillScoreBatch threw: ${e?.message || e}`);
    result = { ok: false, error: e?.message || String(e) };
  } finally {
    await releaseLock({ jobsContainer, jobId, workerId, context });
  }

  const elapsedMs = Date.now() - startedAt;
  context.log(
    `[score-batch-worker] exit job=${jobId} worker=${workerId} ` +
    `scored=${result?.scored ?? "?"} failed=${result?.failed ?? "?"} ` +
    `remaining=${result?.remaining ?? "?"} exit=${result?.exit_reason || result?.error || "?"} ` +
    `elapsed=${(elapsedMs / 1000).toFixed(1)}s`
  );

  // Self-chain the next cycle when the job is still running with work left.
  // status != "running" (completed/paused/cancelled/max_companies) stops the
  // chain; remaining <= 0 stops it; a thrown batch (ok:false) stops it so a
  // hard failure can't hot-loop. The lock guards against overlapping firings.
  if (result?.ok !== false && String(result?.status) === "running" && Number(result?.remaining) > 0) {
    await fireNextCycle(jobId, context);
  }

  return json({
    ok: true,
    job_id: jobId,
    claimed: true,
    worker_id: workerId,
    scored: result?.scored ?? 0,
    failed: result?.failed ?? 0,
    remaining: result?.remaining ?? null,
    cycle_count: result?.cycle_count ?? null,
    exit_reason: result?.exit_reason || null,
    status: result?.status || null,
    elapsed_ms: elapsedMs,
    ...(result?.ok === false ? { error: result?.error } : {}),
  });
}

app.http("adminScoreBatchWorker", {
  route: "xadmin-api-score-batch-worker",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: require("../_adminAuth").withAdminGuard(adminScoreBatchWorkerHandler),
});

module.exports = { handler: adminScoreBatchWorkerHandler };
