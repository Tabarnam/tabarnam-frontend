const { app } = require("../_app");
const { CosmosClient } = require("@azure/cosmos");
const { enqueueResumeRun } = require("../_enrichmentQueue");

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

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
        job.last_updated = new Date().toISOString();
        await jobsContainer.items.upsert(job, { partitionKey: actionJobId });

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

    // Default: return status counts + latest active job

    // Count total companies
    const totalQuery = `SELECT VALUE c.id FROM c WHERE NOT STARTSWITH(c.id, '_')`;
    const { resources: totalIds } = await companiesContainer.items
      .query(totalQuery, { enableCrossPartitionQuery: true })
      .fetchAll();
    const totalCompanies = totalIds.length;

    // Count scored companies (star4 > 0)
    const scoredQuery = `SELECT VALUE c.id FROM c WHERE IS_DEFINED(c.rating.star4.value) AND c.rating.star4.value > 0 AND NOT STARTSWITH(c.id, '_')`;
    const { resources: scoredIds } = await companiesContainer.items
      .query(scoredQuery, { enableCrossPartitionQuery: true })
      .fetchAll();
    const scoredCompanies = scoredIds.length;

    const missingCompanies = totalCompanies - scoredCompanies;

    // Load latest active job
    let latestJob = null;
    try {
      const jobQuery = `SELECT * FROM c ORDER BY c.started_at DESC OFFSET 0 LIMIT 1`;
      const { resources: jobs } = await jobsContainer.items
        .query(jobQuery, { enableCrossPartitionQuery: true })
        .fetchAll();
      if (jobs && jobs.length > 0) {
        latestJob = jobs[0];
      }
    } catch (e) {
      context.log(`[score-status] Error loading job: ${e?.message || e}`);
      // Container may not exist yet — that's OK
    }

    return json({
      ok: true,
      total_companies: totalCompanies,
      scored_companies: scoredCompanies,
      missing_companies: missingCompanies,
      job: latestJob || null,
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
