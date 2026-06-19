// Backfill homepages — WORKER endpoint.
// Mirrors xadmin-api-score-batch-worker. Claims the job lock, runs one bounded
// invocation of processBackfillHomepagesBatch (parallel waves of Microlink
// fetches), releases the lock, returns. Status endpoint self-drives further
// invocations on each poll.
const { app } = require("../_app");
const { CosmosClient } = require("@azure/cosmos");

const LOCK_TTL_MS = 5 * 60 * 1000;
const DEFAULT_INVOCATION_BUDGET_MS = 4 * 60 * 1000;

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}
const json = (obj, status = 200) => ({ status, headers: getCorsHeaders(), body: JSON.stringify(obj) });

let cosmosClient = null;
function getCosmosClient() {
  const endpoint = E("COSMOS_DB_ENDPOINT");
  const key = E("COSMOS_DB_KEY");
  if (!endpoint || !key) return null;
  cosmosClient ||= require("../_cosmosConfig").getCosmosClient();
  return cosmosClient;
}
function getBackfillJobsContainer() {
  const c = getCosmosClient();
  if (!c) return null;
  return c.database(E("COSMOS_DB_DATABASE", "tabarnam-db")).container(E("COSMOS_DB_BACKFILL_JOBS_CONTAINER", "backfill_jobs"));
}

async function tryClaimLock({ jobsContainer, jobId, workerId }) {
  let job;
  try {
    const { resource } = await jobsContainer.item(`job_${jobId}`, jobId).read();
    job = resource;
  } catch (e) { return { claimed: false, job: null, reason: `read_failed: ${e?.message || e}` }; }
  if (!job) return { claimed: false, job: null, reason: "job_not_found" };
  if (job.status !== "running") return { claimed: false, job, reason: `job_status=${job.status}` };

  const now = Date.now();
  const lockedBy = String(job.locked_by || "").trim();
  const lockExpiresAt = Date.parse(job.lock_expires_at || "") || 0;
  if (lockedBy && lockedBy !== workerId && lockExpiresAt > now) {
    return { claimed: false, job, reason: `locked_by=${lockedBy}, expires_in=${((lockExpiresAt - now) / 1000).toFixed(0)}s` };
  }

  job.locked_by = workerId;
  job.lock_expires_at = new Date(now + LOCK_TTL_MS).toISOString();
  job.last_heartbeat_at = new Date(now).toISOString();
  job.last_updated = job.last_heartbeat_at;

  try {
    await jobsContainer.items.upsert(job, { partitionKey: jobId });
    return { claimed: true, job };
  } catch (e) { return { claimed: false, job, reason: `upsert_failed: ${e?.message || e}` }; }
}

async function releaseLock({ jobsContainer, jobId, workerId, context }) {
  try {
    const { resource: fresh } = await jobsContainer.item(`job_${jobId}`, jobId).read();
    if (!fresh) return;
    if (String(fresh.locked_by || "") !== workerId) return;
    fresh.locked_by = null;
    fresh.lock_expires_at = null;
    fresh.last_updated = new Date().toISOString();
    await jobsContainer.items.upsert(fresh, { partitionKey: jobId });
  } catch (e) { context.log(`[backfill-homepages-worker] releaseLock failed: ${e?.message || e}`); }
}

async function handler(req, context) {
  const method = String(req?.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: getCorsHeaders() };

  let body = {};
  try { body = (await req.json()) || {}; } catch { body = {}; }

  const jobId = String(body?.job_id || body?.session_id || "").trim();
  if (!jobId) return json({ ok: false, error: "Missing job_id" }, 400);

  const invocationBudgetMs = Math.max(30_000, Math.min(9 * 60 * 1000, Number(body?.invocation_budget_ms) || DEFAULT_INVOCATION_BUDGET_MS));
  const jobsContainer = getBackfillJobsContainer();
  if (!jobsContainer) return json({ ok: false, error: "Cosmos DB not configured" }, 500);

  const workerId = `homepages-worker-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;

  let processBackfillHomepagesBatch;
  try {
    ({ processBackfillHomepagesBatch } = require("../xadmin-api-backfill-homepages-start/index.js"));
  } catch (e) {
    return json({ ok: false, error: "batch_processor_unavailable", detail: e?.message || String(e) }, 500);
  }

  const startedAt = Date.now();
  context.log(`[backfill-homepages-worker] start job=${jobId} worker=${workerId} budget=${(invocationBudgetMs / 1000).toFixed(0)}s`);

  const claim = await tryClaimLock({ jobsContainer, jobId, workerId });
  if (!claim.claimed) {
    context.log(`[backfill-homepages-worker] lock_not_claimed job=${jobId} reason=${claim.reason}`);
    return json({ ok: true, job_id: jobId, claimed: false, reason: claim.reason, job_status: claim.job?.status || null });
  }

  let result;
  try {
    result = await processBackfillHomepagesBatch({ session_id: jobId, requested_by: "homepages_worker", invocationBudgetMs }, context);
  } catch (e) {
    result = { ok: false, error: e?.message || String(e) };
  } finally {
    await releaseLock({ jobsContainer, jobId, workerId, context });
  }

  const elapsedMs = Date.now() - startedAt;
  context.log(`[backfill-homepages-worker] exit job=${jobId} processed=${result?.processed ?? "?"} failed=${result?.failed ?? "?"} remaining=${result?.remaining ?? "?"} elapsed=${(elapsedMs / 1000).toFixed(1)}s exit=${result?.exit_reason || result?.error || "?"}`);

  return json({
    ok: true,
    job_id: jobId,
    claimed: true,
    worker_id: workerId,
    processed: result?.processed ?? 0,
    failed: result?.failed ?? 0,
    remaining: result?.remaining ?? null,
    cycle_count: result?.cycle_count ?? null,
    exit_reason: result?.exit_reason || null,
    status: result?.status || null,
    elapsed_ms: elapsedMs,
    ...(result?.ok === false ? { error: result?.error } : {}),
  });
}

app.http("adminBackfillHomepagesWorker", {
  route: "xadmin-api-backfill-homepages-worker",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: require("../_adminAuth").withAdminGuard(handler),
});

module.exports = { handler };
