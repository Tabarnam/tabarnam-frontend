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

    // Default: return status counts + latest active job.
    // Wrap each query in its own try/catch so one failure doesn't kill the whole response.

    let totalCompanies = null;
    let scoredCompanies = null;
    let missingCompanies = null;
    let queryError = null;

    // Count total companies (filter out internal docs like _import_, refresh_job_, import_control)
    try {
      const totalQuery = `SELECT VALUE c.id FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND NOT STARTSWITH(c.id, 'refresh_job_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')`;
      const { resources: totalIds } = await companiesContainer.items
        .query(totalQuery, { enableCrossPartitionQuery: true })
        .fetchAll();
      totalCompanies = (totalIds || []).length;
    } catch (e) {
      context.log(`[score-status] totalQuery error: ${e?.message || e}`);
      queryError = `totalQuery: ${e?.message || e}`;
    }

    // Count scored companies (star4.value is a positive number — IS_NUMBER guards against string values)
    try {
      const scoredQuery = `SELECT VALUE c.id FROM c WHERE IS_NUMBER(c.rating.star4.value) AND c.rating.star4.value > 0 AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND NOT STARTSWITH(c.id, 'refresh_job_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')`;
      const { resources: scoredIds } = await companiesContainer.items
        .query(scoredQuery, { enableCrossPartitionQuery: true })
        .fetchAll();
      scoredCompanies = (scoredIds || []).length;
    } catch (e) {
      context.log(`[score-status] scoredQuery error: ${e?.message || e}`);
      queryError = queryError || `scoredQuery: ${e?.message || e}`;
    }

    if (totalCompanies != null && scoredCompanies != null) {
      missingCompanies = totalCompanies - scoredCompanies;
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

    return json({
      ok: true,
      total_companies: totalCompanies,
      scored_companies: scoredCompanies,
      missing_companies: missingCompanies,
      job: latestJob || null,
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
