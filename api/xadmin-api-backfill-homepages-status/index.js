// Backfill homepages — STATUS endpoint.
// Mirrors xadmin-api-score-status. Returns counts + the latest job (filtered
// to job_type === "homepages"), self-drives the worker on each poll if the
// job is running and the lock is free, supports pause/resume/cancel actions.
const { app } = require("../_app");
const { CosmosClient } = require("@azure/cosmos");

const HEARTBEAT_STALE_MS = 120_000;
const SELF_DRIVE_TIMEOUT_MS = 8_000;

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
function getCompaniesContainer() {
  const c = getCosmosClient();
  if (!c) return null;
  return c.database(E("COSMOS_DB_DATABASE", "tabarnam-db")).container(E("COSMOS_DB_COMPANIES_CONTAINER", "companies"));
}
function getBackfillJobsContainer() {
  const c = getCosmosClient();
  if (!c) return null;
  return c.database(E("COSMOS_DB_DATABASE", "tabarnam-db")).container(E("COSMOS_DB_BACKFILL_JOBS_CONTAINER", "backfill_jobs"));
}

function getSelfOrigin(req) {
  const hdrs = req?.headers || {};
  const fwdHost = typeof hdrs.get === "function" ? hdrs.get("x-forwarded-host") : hdrs["x-forwarded-host"];
  const fwdProto = typeof hdrs.get === "function" ? hdrs.get("x-forwarded-proto") : hdrs["x-forwarded-proto"];
  if (fwdHost) return `${fwdProto || "https"}://${fwdHost}`;
  try { const u = new URL(req.url); return `${u.protocol}//${u.host}`; } catch { return "http://localhost"; }
}

async function fireBatchWorker({ origin, jobId, context }) {
  const url = `${origin}/api/xadmin-api-backfill-homepages-worker`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SELF_DRIVE_TIMEOUT_MS);
  try {
    const fetchPromise = fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId }),
      signal: ctl.signal,
      keepalive: true,
    });
    return await Promise.race([
      fetchPromise.then((r) => ({ ok: r.ok, status: r.status })),
      new Promise((res) => setTimeout(() => res({ ok: true, status: "fire_and_forget" }), 800)),
    ]);
  } catch (e) {
    context.log(`[backfill-homepages-status] fireBatchWorker soft-error: ${e?.message || e}`);
    return { ok: true, status: "dispatched_no_ack" };
  } finally { clearTimeout(timer); }
}

function isPending(c, includeFailed) {
  if (!c) return false;
  const hasUrl = typeof c.website_url === "string" && c.website_url.trim().length > 0;
  if (!hasUrl) return false;
  const hasImage = typeof c.homepage_image_url === "string" && c.homepage_image_url.trim().length > 0;
  if (hasImage) return false;
  if (!includeFailed && c.homepage_fetch_status === "failed") return false;
  return true;
}

async function handler(req, context) {
  const method = String(req.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: getCorsHeaders() };

  const companiesContainer = getCompaniesContainer();
  const jobsContainer = getBackfillJobsContainer();
  if (!companiesContainer || !jobsContainer) return json({ error: "Cosmos DB not configured" }, 500);

  try {
    const url = new URL(req.url || "http://localhost", "http://localhost");
    const action = url.searchParams.get("action");
    const actionJobId = url.searchParams.get("job_id");

    if (action && actionJobId) {
      let job;
      try { ({ resource: job } = await jobsContainer.item(`job_${actionJobId}`, actionJobId).read()); }
      catch (e) { return json({ error: `Job not found: ${e?.message || e}` }, 404); }
      if (!job) return json({ error: "Job not found" }, 404);

      if (action === "pause") {
        job.status = "paused";
        job.last_updated = new Date().toISOString();
        await jobsContainer.items.upsert(job, { partitionKey: actionJobId });
        return json({ ok: true, action: "paused", job_id: actionJobId });
      }
      if (action === "resume") {
        job.status = "running";
        job.locked_by = null;
        job.lock_expires_at = null;
        job.last_updated = new Date().toISOString();
        await jobsContainer.items.upsert(job, { partitionKey: actionJobId });
        return json({ ok: true, action: "resumed", job_id: actionJobId });
      }
      if (action === "cancel") {
        job.status = "cancelled";
        job.last_updated = new Date().toISOString();
        await jobsContainer.items.upsert(job, { partitionKey: actionJobId });
        return json({ ok: true, action: "cancelled", job_id: actionJobId });
      }
      return json({ error: `Unknown action: ${action}` }, 400);
    }

    // Default: counts + latest homepages job
    let totalCompanies = null, withImage = null, missingImage = null, failedImage = null, queryError = null;
    try {
      const allQuery = `SELECT c.id, c.website_url, c.homepage_image_url, c.homepage_fetch_status FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND NOT STARTSWITH(c.id, 'refresh_job_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')`;
      const { resources: rows } = await companiesContainer.items.query(allQuery, { enableCrossPartitionQuery: true }).fetchAll();
      const list = rows || [];
      totalCompanies = list.length;
      withImage = list.filter((c) => typeof c.homepage_image_url === "string" && c.homepage_image_url.trim().length > 0).length;
      failedImage = list.filter((c) => c.homepage_fetch_status === "failed" && !(typeof c.homepage_image_url === "string" && c.homepage_image_url.trim().length > 0)).length;
      missingImage = totalCompanies - withImage;
    } catch (e) { queryError = `allQuery: ${e?.message || e}`; }

    let latestJob = null;
    try {
      const { resources: jobs } = await jobsContainer.items
        .query("SELECT * FROM c WHERE c.job_type = 'homepages'", { enableCrossPartitionQuery: true })
        .fetchAll();
      if (jobs && jobs.length > 0) {
        jobs.sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
        latestJob = jobs[0];
      }
    } catch (e) { context.log(`[backfill-homepages-status] jobs query error: ${e?.message || e}`); }

    // NOTE: This endpoint is purely informational. It does NOT auto-start
    // the worker on a poll — backfill must be explicitly triggered by an
    // admin clicking Start (or by the import auto-trigger). The worker
    // re-fires itself between batches via processBackfillHomepagesBatch's
    // exit handoff, so jobs run to completion without page polling.

    return json({
      ok: true,
      total_companies: totalCompanies,
      companies_with_homepage: withImage,
      companies_missing_homepage: missingImage,
      companies_failed: failedImage,
      job: latestJob || null,
      ...(queryError ? { query_error: queryError } : {}),
    });
  } catch (e) {
    return json({ error: e?.message || "Internal error" }, 500);
  }
}

app.http("adminBackfillHomepagesStatus", {
  route: "xadmin-api-backfill-homepages-status",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler,
});

module.exports = { handler };
