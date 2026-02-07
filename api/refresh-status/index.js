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

const { getBuildInfo } = require("../_buildInfo");

const HANDLER_ID = "refresh-status";
const BUILD_INFO = getBuildInfo();

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
      "X-Api-Handler": HANDLER_ID,
      "X-Api-Build-Id": String(BUILD_INFO.build_id || ""),
    },
    body: JSON.stringify(obj),
  };
}

function getCompaniesContainer() {
  const endpoint = asString(process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_ENDPOINT).trim();
  const key = asString(process.env.COSMOS_DB_KEY || process.env.COSMOS_KEY).trim();
  const database = asString(process.env.COSMOS_DB_DATABASE || process.env.COSMOS_DB || "tabarnam-db").trim();
  const containerName = asString(process.env.COSMOS_DB_COMPANIES_CONTAINER || process.env.COSMOS_CONTAINER || "companies").trim();

  if (!endpoint || !key) return null;
  if (!CosmosClient) return null;

  const client = new CosmosClient({ endpoint, key });
  return client.database(database).container(containerName);
}

async function loadRefreshJob(container, jobId) {
  const querySpec = {
    query: "SELECT * FROM c WHERE c.id = @id AND c.type = @type",
    parameters: [
      { name: "@id", value: jobId },
      { name: "@type", value: "refresh_job" },
    ],
  };
  const { resources } = await container.items.query(querySpec, { enableCrossPartitionQuery: true }).fetchAll();
  return Array.isArray(resources) && resources.length > 0 ? resources[0] : null;
}

async function refreshStatusHandler(req, context) {
  const startedAt = Date.now();
  const method = String(req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return json({ ok: true }, 200);
  }

  if (method !== "GET") {
    return json({
      ok: false,
      error: "Method not allowed",
      handler_id: HANDLER_ID,
      build_id: String(BUILD_INFO.build_id || ""),
      elapsed_ms: Date.now() - startedAt,
    }, 405);
  }

  // Get job_id from query params (handle both URLSearchParams and plain object)
  const q = req.query && typeof req.query.get === "function"
    ? Object.fromEntries(req.query.entries())
    : (req.query || {});
  const jobId = asString(q.job_id || q.refresh_job_id || "").trim();
  if (!jobId) {
    return json({
      ok: false,
      error: "job_id required",
      handler_id: HANDLER_ID,
      build_id: String(BUILD_INFO.build_id || ""),
      elapsed_ms: Date.now() - startedAt,
    }, 400);
  }

  const container = getCompaniesContainer();
  if (!container) {
    return json({
      ok: false,
      error: "Cosmos not configured",
      handler_id: HANDLER_ID,
      build_id: String(BUILD_INFO.build_id || ""),
      elapsed_ms: Date.now() - startedAt,
    }, 503);
  }

  try {
    const job = await loadRefreshJob(container, jobId);

    if (!job) {
      return json({
        ok: false,
        error: "Refresh job not found",
        job_id: jobId,
        handler_id: HANDLER_ID,
        build_id: String(BUILD_INFO.build_id || ""),
        elapsed_ms: Date.now() - startedAt,
      }, 404);
    }

    // Return job status
    return json({
      ok: true,
      job_id: jobId,
      company_id: job.company_id,
      status: job.status,  // pending, in_progress, complete, failed
      created_at: job.created_at,
      completed_at: job.completed_at,
      proposed: job.proposed,
      enrichment_status: job.enrichment_status,
      error: job.error,
      handler_id: HANDLER_ID,
      build_id: String(BUILD_INFO.build_id || ""),
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (e) {
    return json({
      ok: false,
      error: e?.message || "Internal error",
      job_id: jobId,
      handler_id: HANDLER_ID,
      build_id: String(BUILD_INFO.build_id || ""),
      elapsed_ms: Date.now() - startedAt,
    }, 500);
  }
}

app.http("refreshStatus", {
  route: "refresh-status",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: refreshStatusHandler,
});

module.exports = { handler: refreshStatusHandler };
