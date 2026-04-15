const { app } = require("../_app");
const { CosmosClient } = require("@azure/cosmos");
const { computeReputationQualityScores } = require("../_companyScoring");

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

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── HTTP endpoint: POST /xadmin-api-score-all-missing ──────────────────

async function adminScoreAllMissingHandler(req, context) {
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
    let body;
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const batchSize = Math.max(1, Math.min(50, Number(body?.batch_size) || 12));
    const maxCompanies = body?.max_companies != null ? Math.max(1, Number(body.max_companies)) : null;
    const force = Boolean(body?.force);

    // Count unscored companies: query with admin filter + project star4.value,
    // filter unscored in JS (Cosmos AND doesn't guarantee short-circuit, so
    // a DB-side type-guard can still throw on heterogeneous rating fields).
    const countQuery = `SELECT c.id, c.rating FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND NOT STARTSWITH(c.id, 'refresh_job_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')`;
    const { resources: countRows } = await companiesContainer.items
      .query(countQuery, { enableCrossPartitionQuery: true })
      .fetchAll();
    const isScored = (r) => {
      const v = r && r.rating && typeof r.rating === "object" && !Array.isArray(r.rating)
        ? r.rating.star4 && typeof r.rating.star4 === "object" ? r.rating.star4.value : undefined
        : undefined;
      return typeof v === "number" && v > 0;
    };
    const totalToScore = (countRows || []).filter((r) => !isScored(r)).length;

    if (totalToScore === 0 && !force) {
      return json({ ok: true, message: "All companies already scored", total_to_score: 0 });
    }

    // Create job document
    const jobId = uuid();
    const now = new Date().toISOString();
    const jobDoc = {
      id: `job_${jobId}`,
      job_id: jobId,
      status: "running",
      batch_size: batchSize,
      max_companies: maxCompanies,
      force,
      total_to_score: totalToScore,
      processed: 0,
      failed: 0,
      remaining: totalToScore,
      estimated_minutes_remaining: null,
      started_at: now,
      last_updated: now,
      last_batch_results: [],
      cycle_count: 0,
    };

    await jobsContainer.items.upsert(jobDoc, { partitionKey: jobId });

    context.log(`[score-all-missing] Created job ${jobId}: total=${totalToScore}, batch_size=${batchSize}`);

    // The frontend fires a keepalive POST to /xadmin-api-score-batch-worker
    // immediately after this response returns; that worker drives scoring
    // inline via processBackfillScoreBatch until done OR the 9-minute time
    // cap. This mirrors the admin/import → primary-worker keepalive pattern
    // and avoids the Storage Queue path entirely (Flex Consumption doesn't
    // reliably poll queue triggers without Always Ready instances).
    return json({
      ok: true,
      job_id: jobId,
      status: "running",
      total_to_score: totalToScore,
      processed: 0,
      remaining: totalToScore,
      batch_size: batchSize,
      max_companies: maxCompanies,
    });
  } catch (e) {
    context.log("Error in admin-score-all-missing:", e?.message || e, e?.stack || "");
    return json({ error: e?.message || "Internal error" }, 500);
  }
}

// ── Queue batch processor (called by resume-worker) ────────────────────

async function processBackfillScoreBatch(queueBody, context) {
  const jobId = String(queueBody?.session_id || "").trim();
  if (!jobId) {
    context.log("[backfill-score] No job_id (session_id) in queue message, skipping");
    return { ok: false, error: "missing_job_id" };
  }

  const companiesContainer = getCompaniesContainer();
  const jobsContainer = getBackfillJobsContainer();
  if (!companiesContainer || !jobsContainer) {
    context.log("[backfill-score] Cosmos DB not configured");
    return { ok: false, error: "cosmos_not_configured" };
  }

  // Load job document
  let job;
  try {
    const { resource } = await jobsContainer.item(`job_${jobId}`, jobId).read();
    job = resource;
  } catch (e) {
    context.log(`[backfill-score] Failed to load job ${jobId}: ${e?.message || e}`);
    return { ok: false, error: `job_not_found: ${e?.message || e}` };
  }

  if (!job) {
    context.log(`[backfill-score] Job ${jobId} not found`);
    return { ok: false, error: "job_not_found" };
  }

  // Check status
  if (job.status !== "running") {
    context.log(`[backfill-score] Job ${jobId} status=${job.status}, not running — exiting`);
    return { ok: true, skipped: true, reason: `job status is ${job.status}` };
  }

  // Safety: auto-pause if too many cycles
  if ((job.cycle_count || 0) > 1000) {
    job.status = "paused";
    job.last_updated = new Date().toISOString();
    await jobsContainer.items.upsert(job, { partitionKey: jobId });
    context.log(`[backfill-score] Job ${jobId} auto-paused: cycle_count=${job.cycle_count} > 1000`);
    return { ok: true, auto_paused: true, reason: "cycle_count exceeded 1000" };
  }

  const batchSize = job.batch_size || 12;
  const batchStartMs = Date.now();

  // Select next batch: two-step to avoid Cosmos short-circuit issue on
  // heterogeneous rating fields. Step 1: list all non-deleted companies
  // with their star4.value; filter unscored in JS; take first N. Step 2:
  // fetch full docs for the selected IDs.
  let companies = [];
  try {
    const listQuery = `SELECT c.id, c.normalized_domain, c.rating FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND NOT STARTSWITH(c.id, 'refresh_job_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')`;
    const { resources: listRows } = await companiesContainer.items
      .query(listQuery, { enableCrossPartitionQuery: true })
      .fetchAll();
    const isScored = (r) => {
      const v = r && r.rating && typeof r.rating === "object" && !Array.isArray(r.rating)
        ? r.rating.star4 && typeof r.rating.star4 === "object" ? r.rating.star4.value : undefined
        : undefined;
      return typeof v === "number" && v > 0;
    };
    // Enforce max_companies here (not just on the shouldContinue tail).
    // Without this, a batch_size=12 job with max_companies=2 would still
    // score 12 before stopping.
    const maxCompanies = job.max_companies;
    const remainingAllowed = maxCompanies != null
      ? Math.max(0, Number(maxCompanies) - (job.processed || 0))
      : batchSize;
    const takeN = Math.min(batchSize, remainingAllowed);
    const unscored = takeN > 0
      ? (listRows || []).filter((r) => !isScored(r)).slice(0, takeN)
      : [];

    // Fetch full docs for the selected IDs (one read per doc; batch is small)
    for (const row of unscored) {
      try {
        const pk = String(row.normalized_domain || "unknown").trim();
        const { resource } = await companiesContainer.item(row.id, pk).read();
        if (resource) companies.push(resource);
      } catch (e) {
        context.log(`[backfill-score] Failed to read ${row.id}: ${e?.message || e}`);
      }
    }
  } catch (e) {
    context.log(`[backfill-score] Query error: ${e?.message || e}`);
    return { ok: false, error: `query_error: ${e?.message || e}` };
  }

  context.log(`[backfill-score] Job ${jobId} cycle=${job.cycle_count}: found ${companies.length} unscored companies`);

  let scored = 0;
  let failures = 0;
  const batchResults = [];

  // Helper: prepend a just-finished result to job.last_batch_results (capped at
  // 100) and upsert the doc. Gives the admin UI live per-company visibility
  // instead of a dump at end-of-cycle, which matters for long batches.
  async function publishCompletion(entry) {
    try {
      const existing = Array.isArray(job.last_batch_results) ? job.last_batch_results : [];
      job.last_batch_results = [entry, ...existing].slice(0, 100);
      job.last_updated = new Date().toISOString();
      await jobsContainer.items.upsert(job, { partitionKey: jobId });
    } catch (e) {
      context.log(`[backfill-score] publishCompletion upsert failed: ${e?.message || e}`);
    }
  }

  // Process each company sequentially.
  // Writes `current_company` to the job doc before each call so the admin UI
  // can show a "now processing X for Ys" indicator via status polling.
  for (const company of companies) {
    const companyName = company.company_name || company.name || company.normalized_domain || "unknown";
    const companyStartMs = Date.now();
    const companyStartedAt = new Date(companyStartMs).toISOString();

    // Publish current_company to the job doc for live visibility.
    try {
      job.current_company = {
        id: company.id,
        name: companyName,
        domain: company.normalized_domain || null,
        started_at: companyStartedAt,
      };
      job.last_updated = companyStartedAt;
      await jobsContainer.items.upsert(job, { partitionKey: jobId });
    } catch (e) {
      context.log(`[backfill-score] current_company upsert failed: ${e?.message || e}`);
    }

    try {
      // Initialize rating if missing
      if (!company.rating || typeof company.rating !== "object") {
        company.rating = {};
      }

      const scoring = await computeReputationQualityScores(company, { timeoutMs: 60000 });
      const companyDurationMs = Date.now() - companyStartMs;

      if (!scoring.ok) {
        context.log(`[backfill-score] scoring_call: company=${companyName}, ok=false, reason=${scoring.reason}, duration=${(companyDurationMs / 1000).toFixed(1)}s`);
        failures++;
        const entry = {
          company_id: company.id,
          normalized_domain: company.normalized_domain || null,
          company_name: companyName,
          ok: false,
          reason: scoring.reason,
          started_at: companyStartedAt,
          duration_ms: companyDurationMs,
        };
        batchResults.push(entry);
        await publishCompletion(entry);
        continue;
      }

      // Apply scores — preserve existing notes
      const existingStar4 = company.rating.star4 && typeof company.rating.star4 === "object"
        ? company.rating.star4 : { value: 0, notes: [] };
      const existingStar5 = company.rating.star5 && typeof company.rating.star5 === "object"
        ? company.rating.star5 : { value: 0, notes: [] };

      company.rating.star4 = { ...existingStar4, value: scoring.reputation_score, reasoning: scoring.reputation_reasoning };
      company.rating.star5 = { ...existingStar5, value: scoring.quality_score, reasoning: scoring.quality_reasoning };
      company.updated_at = new Date().toISOString();

      // Upsert to Cosmos DB
      const partitionKeyValue = String(company.normalized_domain || "unknown").trim();
      await companiesContainer.items.upsert(company, { partitionKey: partitionKeyValue });

      context.log(`[backfill-score] scoring_call: company=${companyName}, star4=${scoring.reputation_score.toFixed(2)}, star5=${scoring.quality_score.toFixed(2)}, reasoning_populated=true, duration=${(companyDurationMs / 1000).toFixed(1)}s`);
      scored++;
      const okEntry = {
        company_id: company.id,
        normalized_domain: company.normalized_domain || null,
        company_name: companyName,
        ok: true,
        star4: scoring.reputation_score,
        star5: scoring.quality_score,
        started_at: companyStartedAt,
        duration_ms: companyDurationMs,
      };
      batchResults.push(okEntry);
      await publishCompletion(okEntry);
    } catch (e) {
      const companyDurationMs = Date.now() - companyStartMs;
      context.log(`[backfill-score] Error scoring ${companyName}: ${e?.message || e}`);
      failures++;
      const errEntry = {
        company_id: company.id,
        normalized_domain: company.normalized_domain || null,
        company_name: companyName,
        ok: false,
        reason: e?.message || "exception",
        started_at: companyStartedAt,
        duration_ms: companyDurationMs,
      };
      batchResults.push(errEntry);
      await publishCompletion(errEntry);
    }
  }

  // Clear current_company — batch finished.
  job.current_company = null;

  const batchDurationMs = Date.now() - batchStartMs;

  // Update job document
  job.processed = (job.processed || 0) + scored;
  job.failed = (job.failed || 0) + failures;
  job.cycle_count = (job.cycle_count || 0) + 1;
  job.last_updated = new Date().toISOString();

  // Recalculate remaining: JS-side filter to avoid Cosmos short-circuit issue.
  try {
    const countQuery = `SELECT c.id, c.rating FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND NOT STARTSWITH(c.id, 'refresh_job_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')`;
    const { resources: countRows } = await companiesContainer.items
      .query(countQuery, { enableCrossPartitionQuery: true })
      .fetchAll();
    const isScored = (r) => {
      const v = r && r.rating && typeof r.rating === "object" && !Array.isArray(r.rating)
        ? r.rating.star4 && typeof r.rating.star4 === "object" ? r.rating.star4.value : undefined
        : undefined;
      return typeof v === "number" && v > 0;
    };
    job.remaining = (countRows || []).filter((r) => !isScored(r)).length;
  } catch {
    job.remaining = Math.max(0, (job.total_to_score || 0) - job.processed);
  }

  // Estimate remaining time
  if (job.processed > 0 && batchDurationMs > 0) {
    const msPerCompany = batchDurationMs / Math.max(1, scored + failures);
    job.estimated_minutes_remaining = Math.round((job.remaining * msPerCompany) / 60000);
  }

  // last_batch_results is already maintained live by publishCompletion().
  // Just persist the final counters/remaining/estimate update.
  await jobsContainer.items.upsert(job, { partitionKey: jobId });

  context.log(`[backfill-score] Job ${jobId} batch done: scored=${scored}, failed=${failures}, remaining=${job.remaining}, duration=${(batchDurationMs / 1000).toFixed(1)}s`);

  // Determine if we should continue
  const maxCompanies = job.max_companies;
  const shouldContinue =
    job.remaining > 0 &&
    job.status === "running" &&
    (maxCompanies == null || job.processed < maxCompanies);

  if (!shouldContinue) {
    job.status = "completed";
    job.last_updated = new Date().toISOString();
    await jobsContainer.items.upsert(job, { partitionKey: jobId });
    context.log(`[backfill-score] Job ${jobId} completed: processed=${job.processed}, failed=${job.failed}`);
  }
  // Else: the score-batch-worker loop (or the frontend stall watchdog) drives
  // the next cycle. No enqueue step.

  return {
    ok: true,
    job_id: jobId,
    scored,
    failed: failures,
    remaining: job.remaining,
    cycle_count: job.cycle_count,
    duration_ms: batchDurationMs,
  };
}

// ── Register HTTP endpoint ─────────────────────────────────────────────

app.http("adminScoreAllMissing", {
  route: "xadmin-api-score-all-missing",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: adminScoreAllMissingHandler,
});

module.exports = {
  handler: adminScoreAllMissingHandler,
  processBackfillScoreBatch,
};
