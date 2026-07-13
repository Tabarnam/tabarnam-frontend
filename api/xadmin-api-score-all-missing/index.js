const { app } = require("../_app");
const { CosmosClient } = require("@azure/cosmos");
const { computeReputationQualityScores } = require("../_companyScoring");
const { companyNeedsScoring } = require("../_scoringStatus");

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
  cosmosClient ||= require("../_cosmosConfig").getCosmosClient();
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

// Fire the first batch-worker cycle for a job. Mirrors the homepage/logo
// backfill pattern — without an initial fire the job sits idle until the
// Scores admin page is polled. Fire-and-forget; the worker self-chains the
// remaining cycles. Uses WEBSITE_HOSTNAME (set on the Function App).
async function fireScoreBatchWorker(jobId, logger) {
  const host = (process.env.WEBSITE_HOSTNAME || "").trim();
  if (!host) {
    logger?.log?.(`[score-all-missing] worker fire skipped: WEBSITE_HOSTNAME not set`);
    return;
  }
  const url = require("../_internalJobAuth").buildSelfInvokeUrl("/api/xadmin-api-score-batch-worker");
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
    logger?.log?.(`[score-all-missing] worker fire soft-error: ${e?.message || e}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a Rep & Quality scoring backfill job in Cosmos `backfill_jobs` and
 * fire the first batch-worker cycle. Used by both the HTTP endpoint (manual
 * admin backfill) and the import flow (auto-trigger after enrichment). Mirrors
 * createHomepageBackfillJob. Returns:
 *   { ok: true, job_id, total_to_score, ... }   on success
 *   { ok: true, total_to_score: 0 }             when nothing needs scoring
 *   { ok: false, error }                        on config/query failure
 *
 * Options: batchSize, concurrency, maxCompanies, force, source, logger
 */
async function createScoreJob(options = {}) {
  const logger = options.logger || console;
  const companiesContainer = getCompaniesContainer();
  const jobsContainer = getBackfillJobsContainer();
  if (!companiesContainer || !jobsContainer) {
    return { ok: false, error: "Cosmos DB not configured" };
  }

  const batchSize = Math.max(1, Math.min(200, Number(options.batchSize) || 12));
  // Parallelism cap 100 — grok-3-mini ran c=20 at ~36 companies/min with zero
  // failures; batch_size cap (200) keeps c=50 × 4 waves inside the 240s budget.
  const concurrency = Math.max(1, Math.min(100, Number(options.concurrency) || 4));
  const maxCompanies = options.maxCompanies != null ? Math.max(1, Number(options.maxCompanies)) : null;
  const force = Boolean(options.force);
  const source = typeof options.source === "string" ? options.source.trim() : "";

  // Dedupe concurrent auto-triggers: if a score job for the same source is
  // already running and started within 30s, reuse it (mirror of the
  // homepage/logo backfill dedupe). The existing job picks up newly-unscored
  // companies on its next wave. Only same-source callers (e.g. "import_auto")
  // dedupe; this prevents a batch of completing import sessions from spawning
  // many redundant score jobs.
  if (source) {
    try {
      const RECENT_JOB_WINDOW_MS = 30_000;
      const cutoffIso = new Date(Date.now() - RECENT_JOB_WINDOW_MS).toISOString();
      const query = `SELECT c.id, c.job_id, c.started_at, c.total_to_score, c.processed, c.failed, c.status FROM c WHERE c.job_type = "scores" AND c.source = @source AND c.status = "running" AND c.started_at > @cutoff ORDER BY c.started_at DESC`;
      const { resources: recent } = await jobsContainer.items
        .query(
          { query, parameters: [{ name: "@source", value: source }, { name: "@cutoff", value: cutoffIso }] },
          { enableCrossPartitionQuery: true }
        )
        .fetchAll();
      if (Array.isArray(recent) && recent.length > 0) {
        const existing = recent[0];
        logger.log?.(`[score-all-missing] dedupe_skip: existing job=${existing.job_id} source=${source} started_at=${existing.started_at} — reusing`);
        return { ok: true, job_id: existing.job_id, total_to_score: existing.total_to_score || 0, status: existing.status, deduped: true };
      }
    } catch (e) {
      logger.warn?.(`[score-all-missing] dedup_query_failed: ${e?.message || e} — proceeding with new job`);
    }
  }

  // Count companies needing scoring (project rating; filter in JS to avoid
  // Cosmos type-coercion errors on heterogeneous rating fields).
  let totalToScore = 0;
  try {
    const countQuery = `SELECT c.id, c.rating FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND NOT STARTSWITH(c.id, 'refresh_job_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')`;
    const { resources: countRows } = await companiesContainer.items
      .query(countQuery, { enableCrossPartitionQuery: true })
      .fetchAll();
    totalToScore = (countRows || []).filter((r) => companyNeedsScoring(r)).length;
  } catch (e) {
    return { ok: false, error: `count failed: ${e?.message || e}` };
  }

  if (totalToScore === 0 && !force) {
    return { ok: true, total_to_score: 0, message: "All companies already scored" };
  }

  const jobId = uuid();
  const now = new Date().toISOString();
  const jobDoc = {
    id: `job_${jobId}`,
    job_id: jobId,
    job_type: "scores", // distinguishes score jobs from homepages/logos in the shared backfill_jobs container
    status: "running",
    batch_size: batchSize,
    concurrency,
    max_companies: maxCompanies,
    force,
    total_to_score: totalToScore,
    processed: 0,
    failed: 0,
    remaining: totalToScore,
    estimated_minutes_remaining: null,
    started_at: now,
    last_updated: now,
    locked_by: null,
    lock_expires_at: null,
    last_heartbeat_at: null,
    current_companies: [],
    last_batch_results: [],
    cycle_count: 0,
    ...(source ? { source } : {}),
  };

  await jobsContainer.items.upsert(jobDoc, { partitionKey: jobId });
  logger.log?.(`[score-all-missing] job=${jobId} total=${totalToScore} batch=${batchSize} concurrency=${concurrency} source=${source || "n/a"}`);

  // Kick off the first cycle so the job starts immediately. The batch worker
  // self-chains the remaining cycles (and the status endpoint also self-drives
  // when the Scores page is open). Fire-and-forget.
  await fireScoreBatchWorker(jobId, logger);

  return {
    ok: true,
    job_id: jobId,
    status: "running",
    total_to_score: totalToScore,
    processed: 0,
    remaining: totalToScore,
    batch_size: batchSize,
    concurrency,
    max_companies: maxCompanies,
  };
}

// ── HTTP endpoint: POST /xadmin-api-score-all-missing ──────────────────

async function adminScoreAllMissingHandler(req, context) {
  const method = String(req.method || "").toUpperCase();
  if (method === "OPTIONS") {
    return { status: 200, headers: getCorsHeaders() };
  }

  try {
    let body;
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    // No default source — manual runs must NOT dedupe against each other, or a
    // capped test run immediately followed by a full run silently collapses into
    // the capped job. The 30s source-dedupe in createScoreJob is only for
    // tagged callers (e.g. a future import auto-trigger passing source).
    const result = await createScoreJob({
      batchSize: body?.batch_size,
      concurrency: body?.concurrency,
      maxCompanies: body?.max_companies,
      force: Boolean(body?.force),
      source: typeof body?.source === "string" && body.source.trim() ? body.source : "",
      logger: context,
    });

    if (!result.ok) {
      return json({ error: result.error || "Internal error" }, result.error === "Cosmos DB not configured" ? 500 : 500);
    }
    return json(result);
  } catch (e) {
    context.log("Error in admin-score-all-missing:", e?.message || e, e?.stack || "");
    return json({ error: e?.message || "Internal error" }, 500);
  }
}

// ── Budget-aware batch processor ───────────────────────────────────────
//
// New architecture (replaces the old 9-minute while(true) loop):
//   - Invocation is bounded by `invocationBudgetMs` (default 4 minutes).
//   - Inside the budget, we run parallel waves of N scoring calls
//     (N = job.concurrency).
//   - Before each wave, we check if the wall-clock has enough budget left
//     to finish ~one wave (70s safety). If not, we yield early.
//   - Between waves we refresh the heartbeat so the status endpoint can tell
//     a live worker from a recycled one.
//   - If more work remains when we exit, the status endpoint re-invokes
//     this worker on the next frontend poll.
//
// Lock semantics:
//   - Caller (batch-worker HTTP handler) holds the job lock. We DO NOT
//     re-claim it here; we just heartbeat it.
//
// Invocation budget:
//   - queueBody.invocationBudgetMs can override. Default 4 minutes.
//
// Wave size:
//   - Wave size = min(concurrency, batch_size, remaining).
//   - batch_size now acts as "max companies per invocation" — when exhausted,
//     we yield even if budget remains.

const DEFAULT_INVOCATION_BUDGET_MS = 4 * 60 * 1000;       // 4 min — half of Azure's 10-min kill
const WAVE_SAFETY_MARGIN_MS = 75 * 1000;                  // Abort a wave if < 75s remaining
const PER_CALL_TIMEOUT_MS = 70 * 1000;                    // Per-company scoring timeout (inner AbortController)
const PER_CALL_HARD_TIMEOUT_MS = 90 * 1000;               // Belt-and-suspenders: outer Promise.race cap
const IN_WAVE_HEARTBEAT_MS = 20 * 1000;                   // Refresh heartbeat every 20s during a wave
const HEARTBEAT_LOCK_EXTENSION_MS = 60 * 1000;            // Each heartbeat extends lock_expires_at by 60s (ticker is 20s, so 3x safety margin)

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

  const invocationStartMs = Date.now();
  const invocationBudgetMs = Math.max(
    30_000,
    Number(queueBody?.invocationBudgetMs) || DEFAULT_INVOCATION_BUDGET_MS
  );
  const budgetDeadlineMs = invocationStartMs + invocationBudgetMs;

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

  if (job.status !== "running") {
    context.log(`[backfill-score] Job ${jobId} status=${job.status}, not running — exiting`);
    return { ok: true, skipped: true, reason: `job status is ${job.status}` };
  }

  if ((job.cycle_count || 0) > 10_000) {
    job.status = "paused";
    job.last_updated = new Date().toISOString();
    await jobsContainer.items.upsert(job, { partitionKey: jobId });
    context.log(`[backfill-score] Job ${jobId} auto-paused: cycle_count=${job.cycle_count} > 10000`);
    return { ok: true, auto_paused: true, reason: "cycle_count exceeded 10000" };
  }

  const batchSize = Math.max(1, Number(job.batch_size) || 12);
  const concurrency = Math.max(1, Math.min(100, Number(job.concurrency) || 4));
  const maxCompanies = job.max_companies;

  let scoredThisInvocation = 0;
  let failuresThisInvocation = 0;
  let companiesThisInvocation = 0;
  const results = [];
  let exitReason = "completed_batch";

  // Helper: re-read job fields we care about for concurrent-safe updates.
  // Multiple waves will upsert in sequence; we keep a local mirror but
  // always re-read before writing totals to avoid stomping a parallel
  // status-endpoint update.
  async function persistJob(patch) {
    try {
      const { resource: fresh } = await jobsContainer.item(`job_${jobId}`, jobId).read();
      if (!fresh) return;
      Object.assign(fresh, patch, { last_updated: new Date().toISOString() });
      await jobsContainer.items.upsert(fresh, { partitionKey: jobId });
      job = fresh;
    } catch (e) {
      context.log(`[backfill-score] persistJob failed: ${e?.message || e}`);
    }
  }

  // Heartbeat extends both last_heartbeat_at AND lock_expires_at. Extending
  // the lock on every tick shrinks the orphan-lock recovery window from
  // LOCK_TTL_MS (5 min, held by the caller) down to HEARTBEAT_LOCK_EXTENSION_MS
  // (~60s): if this worker dies mid-wave, the next status-endpoint poll sees
  // the stale lock and re-drives the worker after ~60s instead of 5 minutes.
  async function heartbeat(extra = {}) {
    await persistJob({
      last_heartbeat_at: new Date().toISOString(),
      lock_expires_at: new Date(Date.now() + HEARTBEAT_LOCK_EXTENSION_MS).toISOString(),
      ...extra,
    });
  }

  // Main wave loop: each wave scores up to `concurrency` companies in parallel.
  while (true) {
    const now = Date.now();
    if (now + WAVE_SAFETY_MARGIN_MS >= budgetDeadlineMs) {
      exitReason = "budget_exhausted";
      break;
    }

    // Respect per-invocation cap (batch_size)
    if (companiesThisInvocation >= batchSize) {
      exitReason = "batch_size_reached";
      break;
    }

    // Pre-flight status check — admin may have paused/cancelled mid-run.
    try {
      const { resource: fresh } = await jobsContainer.item(`job_${jobId}`, jobId).read();
      if (fresh && fresh.status !== "running") {
        exitReason = `status_changed_to_${fresh.status}`;
        job = fresh;
        break;
      }
      if (fresh) job = fresh;
    } catch { /* ignore transient read failure, continue */ }

    // Select next wave of companies: list unscored → take next N
    let companies = [];
    try {
      const listQuery = `SELECT c.id, c.normalized_domain, c.rating FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND NOT STARTSWITH(c.id, 'refresh_job_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')`;
      const { resources: listRows } = await companiesContainer.items
        .query(listQuery, { enableCrossPartitionQuery: true })
        .fetchAll();
      const remainingAllowedByMax = maxCompanies != null
        ? Math.max(0, Number(maxCompanies) - (job.processed || 0) - scoredThisInvocation)
        : Infinity;
      const remainingAllowedByBatch = Math.max(0, batchSize - companiesThisInvocation);
      const waveSize = Math.min(concurrency, remainingAllowedByBatch, remainingAllowedByMax);

      if (waveSize <= 0) {
        exitReason = maxCompanies != null ? "max_companies_reached" : "batch_size_reached";
        break;
      }

      const unscoredRows = (listRows || []).filter((r) => companyNeedsScoring(r)).slice(0, waveSize);
      if (unscoredRows.length === 0) {
        exitReason = "no_unscored_remaining";
        break;
      }

      // Fetch full docs in parallel
      const reads = unscoredRows.map((row) => {
        const pk = String(row.normalized_domain || "unknown").trim();
        return companiesContainer.item(row.id, pk).read()
          .then((r) => r?.resource || null)
          .catch((e) => {
            context.log(`[backfill-score] Failed to read ${row.id}: ${e?.message || e}`);
            return null;
          });
      });
      companies = (await Promise.all(reads)).filter(Boolean);
    } catch (e) {
      context.log(`[backfill-score] Wave query error: ${e?.message || e}`);
      exitReason = `query_error: ${e?.message || e}`;
      break;
    }

    if (companies.length === 0) {
      exitReason = "no_unscored_remaining";
      break;
    }

    // Publish current_companies + heartbeat before starting the wave
    const waveStartMs = Date.now();
    const currentCompanies = companies.map((c) => ({
      id: c.id,
      name: c.company_name || c.name || c.normalized_domain || "unknown",
      domain: c.normalized_domain || null,
      started_at: new Date(waveStartMs).toISOString(),
    }));
    await heartbeat({ current_companies: currentCompanies });

    context.log(
      `[backfill-score] Job ${jobId} wave: size=${companies.length} ` +
      `(batch ${companiesThisInvocation}/${batchSize}, budget ${((budgetDeadlineMs - Date.now()) / 1000).toFixed(0)}s left)`
    );

    // Compute per-call timeout: shorter of PER_CALL_TIMEOUT_MS or remaining budget.
    // The outer hard-timeout (belt-and-suspenders) is slightly larger so it only
    // trips when the inner AbortController fails to cancel the fetch.
    const remainingBudgetMs = Math.max(15_000, budgetDeadlineMs - Date.now() - 5_000);
    const perCallTimeoutMs = Math.min(PER_CALL_TIMEOUT_MS, remainingBudgetMs);
    const perCallHardTimeoutMs = Math.min(
      PER_CALL_HARD_TIMEOUT_MS,
      Math.max(perCallTimeoutMs + 15_000, remainingBudgetMs)
    );

    // Start an in-wave heartbeat ticker. We refresh `last_heartbeat_at` AND
    // extend `lock_expires_at` every IN_WAVE_HEARTBEAT_MS. Extending the lock
    // on each tick drops the orphan-lock recovery window from ~5 min down to
    // ~HEARTBEAT_LOCK_EXTENSION_MS (60s): if this worker dies mid-wave, the
    // status endpoint's next poll sees the stale lock and re-drives the worker
    // in ~60s instead of 5 minutes. The ticker stops when the wave finishes
    // (or errors out).
    let heartbeatTicker = setInterval(() => {
      // Fire-and-forget: don't await, don't let a failed upsert take down the wave.
      persistJob({
        last_heartbeat_at: new Date().toISOString(),
        lock_expires_at: new Date(Date.now() + HEARTBEAT_LOCK_EXTENSION_MS).toISOString(),
      }).catch(() => {});
    }, IN_WAVE_HEARTBEAT_MS);

    // Run the wave in parallel. Each call is wrapped in an outer hard-timeout
    // so Promise.allSettled is guaranteed to resolve within perCallHardTimeoutMs
    // even if xAI's internal AbortController fails to cancel the fetch.
    let waveResults;
    try {
      waveResults = await Promise.allSettled(
        companies.map((company) => scoreOneCompanyWithHardTimeout(company, {
          companiesContainer,
          perCallTimeoutMs,
          perCallHardTimeoutMs,
        }))
      );
    } finally {
      clearInterval(heartbeatTicker);
      heartbeatTicker = null;
    }

    // Process wave results and persist each
    for (let i = 0; i < waveResults.length; i++) {
      const r = waveResults[i];
      const company = companies[i];
      const companyName = company.company_name || company.name || company.normalized_domain || "unknown";

      companiesThisInvocation++;

      let entry;
      if (r.status === "fulfilled") {
        const payload = r.value;
        if (payload.ok) {
          scoredThisInvocation++;
          entry = {
            company_id: company.id,
            normalized_domain: company.normalized_domain || null,
            company_name: companyName,
            ok: true,
            star4: payload.star4,
            star5: payload.star5,
            started_at: payload.started_at,
            duration_ms: payload.duration_ms,
          };
          context.log(`[backfill-score] scoring_call: company=${companyName}, star4=${payload.star4.toFixed(2)}, star5=${payload.star5.toFixed(2)}, reasoning_populated=true, duration=${(payload.duration_ms / 1000).toFixed(1)}s`);
        } else {
          failuresThisInvocation++;
          entry = {
            company_id: company.id,
            normalized_domain: company.normalized_domain || null,
            company_name: companyName,
            ok: false,
            reason: payload.reason || "unknown",
            started_at: payload.started_at,
            duration_ms: payload.duration_ms,
          };
          context.log(`[backfill-score] scoring_call: company=${companyName}, ok=false, reason=${payload.reason}, duration=${(payload.duration_ms / 1000).toFixed(1)}s`);
        }
      } else {
        failuresThisInvocation++;
        entry = {
          company_id: company.id,
          normalized_domain: company.normalized_domain || null,
          company_name: companyName,
          ok: false,
          reason: r.reason?.message || String(r.reason || "rejected"),
          started_at: new Date(waveStartMs).toISOString(),
          duration_ms: Date.now() - waveStartMs,
        };
        context.log(`[backfill-score] scoring_call: company=${companyName}, rejected=${entry.reason}`);
      }
      results.push(entry);
    }

    // Publish wave completion: prepend results, update counters, refresh remaining.
    try {
      const { resource: fresh } = await jobsContainer.item(`job_${jobId}`, jobId).read();
      if (fresh) {
        const existingResults = Array.isArray(fresh.last_batch_results) ? fresh.last_batch_results : [];
        fresh.last_batch_results = [...results.slice(-companies.length).reverse(), ...existingResults].slice(0, 100);
        // Don't update processed/failed/cycle_count here — we do it once at exit,
        // to keep invariants clean (cycle_count increments once per invocation).
        fresh.current_companies = [];
        fresh.last_heartbeat_at = new Date().toISOString();
        // Extend lock on wave boundary too: next wave starts immediately, but
        // if the invocation dies here the recovery window stays at ~60s.
        fresh.lock_expires_at = new Date(Date.now() + HEARTBEAT_LOCK_EXTENSION_MS).toISOString();
        fresh.last_updated = new Date().toISOString();
        await jobsContainer.items.upsert(fresh, { partitionKey: jobId });
        job = fresh;
      }
    } catch (e) {
      context.log(`[backfill-score] wave publish failed: ${e?.message || e}`);
    }
  }

  // ── Exit: finalize invocation totals ────────────────────────────────
  const invocationDurationMs = Date.now() - invocationStartMs;

  // Recalculate remaining from Cosmos (source of truth)
  let remaining = null;
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
    remaining = (countRows || []).filter((r) => !isScored(r)).length;
  } catch { /* leave null; we'll fall back below */ }

  try {
    const { resource: fresh } = await jobsContainer.item(`job_${jobId}`, jobId).read();
    if (fresh) {
      fresh.processed = (fresh.processed || 0) + scoredThisInvocation;
      fresh.failed = (fresh.failed || 0) + failuresThisInvocation;
      fresh.cycle_count = (fresh.cycle_count || 0) + 1;
      if (remaining != null) fresh.remaining = remaining;
      else fresh.remaining = Math.max(0, (fresh.total_to_score || 0) - fresh.processed);

      // ETA: companies per second measured across the invocation, scaled by concurrency
      if (companiesThisInvocation > 0 && invocationDurationMs > 0) {
        const secsPerCompany = invocationDurationMs / 1000 / companiesThisInvocation;
        fresh.estimated_minutes_remaining = Math.round((fresh.remaining * secsPerCompany) / 60);
      }

      fresh.current_companies = [];
      fresh.last_heartbeat_at = new Date().toISOString();
      fresh.last_updated = new Date().toISOString();

      const maxReached = fresh.max_companies != null && fresh.processed >= fresh.max_companies;
      const shouldComplete = fresh.status === "running" && (fresh.remaining === 0 || maxReached);

      if (shouldComplete) {
        fresh.status = "completed";
        fresh.completed_at = fresh.last_updated;
        fresh.locked_by = null;
        fresh.lock_expires_at = null;
        context.log(`[backfill-score] Job ${jobId} completed: processed=${fresh.processed}, failed=${fresh.failed}`);
      }

      await jobsContainer.items.upsert(fresh, { partitionKey: jobId });
      job = fresh;
    }
  } catch (e) {
    context.log(`[backfill-score] final persistJob failed: ${e?.message || e}`);
  }

  context.log(
    `[backfill-score] Job ${jobId} invocation done: scored=${scoredThisInvocation}, ` +
    `failed=${failuresThisInvocation}, remaining=${job?.remaining ?? "?"}, ` +
    `duration=${(invocationDurationMs / 1000).toFixed(1)}s, exit=${exitReason}`
  );

  return {
    ok: true,
    job_id: jobId,
    scored: scoredThisInvocation,
    failed: failuresThisInvocation,
    remaining: job?.remaining ?? null,
    cycle_count: job?.cycle_count ?? null,
    duration_ms: invocationDurationMs,
    exit_reason: exitReason,
    status: job?.status ?? "running",
  };
}

// Wrap scoreOneCompany in an outer Promise.race hard timeout. This is a safety
// net for cases where xAI's internal AbortController fails to actually cancel
// the fetch (rare Node-fetch edge case observed in prod). The inner timeout
// (perCallTimeoutMs) still fires first in the normal path; the hard timeout
// only trips when the inner abort is ignored.
//
// When the hard timeout trips we return a fulfilled POJO (like scoreOneCompany
// does), so Promise.allSettled sees a clean result and the wave proceeds.
// The orphaned inner fetch is abandoned; Azure will GC it when the invocation
// ends.
async function scoreOneCompanyWithHardTimeout(company, opts) {
  const hardMs = Math.max(30_000, Number(opts.perCallHardTimeoutMs) || 90_000);
  let hardTimer = null;
  const hardTimeoutPromise = new Promise((resolve) => {
    hardTimer = setTimeout(() => {
      resolve({
        ok: false,
        reason: `hard_timeout_${hardMs}ms`,
        started_at: new Date().toISOString(),
        duration_ms: hardMs,
        _hard_timed_out: true,
      });
    }, hardMs);
  });
  try {
    return await Promise.race([
      scoreOneCompany(company, opts),
      hardTimeoutPromise,
    ]);
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
  }
}

// Score one company. Returns a POJO — never throws, so Promise.allSettled
// consumers always get `fulfilled` with an ok/!ok payload.
async function scoreOneCompany(company, { companiesContainer, perCallTimeoutMs }) {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  try {
    const ratingExistedInStore = Boolean(company.rating && typeof company.rating === "object");
    if (!company.rating || typeof company.rating !== "object") {
      company.rating = {};
    }

    const scoring = await computeReputationQualityScores(company, { timeoutMs: perCallTimeoutMs });
    const durationMs = Date.now() - startedAtMs;

    if (!scoring.ok) {
      return { ok: false, reason: scoring.reason || "scoring_failed", started_at: startedAt, duration_ms: durationMs };
    }

    const existingStar4 = company.rating.star4 && typeof company.rating.star4 === "object"
      ? company.rating.star4 : { value: 0, notes: [] };
    const existingStar5 = company.rating.star5 && typeof company.rating.star5 === "object"
      ? company.rating.star5 : { value: 0, notes: [] };

    const newStar4 = { ...existingStar4, value: scoring.reputation_score, reasoning: scoring.reputation_reasoning };
    const newStar5 = { ...existingStar5, value: scoring.quality_score, reasoning: scoring.quality_reasoning };
    const nowIso = new Date().toISOString();
    company.rating.star4 = newStar4;
    company.rating.star5 = newStar5;
    company.updated_at = nowIso;

    // Field-scoped patch (not a full-doc upsert): this backfill runs in the
    // background and must not clobber concurrent admin edits (unknown_manufacturing,
    // no_amazon_store, amazon_url_approved, star1/star2…). A patch only touches the
    // rating scores.
    const partitionKeyValue = String(company.normalized_domain || "unknown").trim();
    const companyId = String(company.id || company.company_id || "").trim();
    const patchOps = [];
    if (!ratingExistedInStore) patchOps.push({ op: "add", path: "/rating", value: {} });
    patchOps.push({ op: "set", path: "/rating/star4", value: newStar4 });
    patchOps.push({ op: "set", path: "/rating/star5", value: newStar5 });
    patchOps.push({ op: "set", path: "/updated_at", value: nowIso });
    try {
      await companiesContainer.item(companyId, partitionKeyValue).patch(patchOps);
    } catch (patchErr) {
      // Recovery: re-read the current doc and set only the two stars on it.
      const { resource: fresh } = await companiesContainer.item(companyId, partitionKeyValue).read();
      const target = fresh && typeof fresh === "object" ? fresh : company;
      if (!target.rating || typeof target.rating !== "object") target.rating = {};
      target.rating.star4 = newStar4;
      target.rating.star5 = newStar5;
      target.updated_at = nowIso;
      await companiesContainer.items.upsert(target, { partitionKey: partitionKeyValue });
    }

    return {
      ok: true,
      star4: scoring.reputation_score,
      star5: scoring.quality_score,
      started_at: startedAt,
      duration_ms: durationMs,
    };
  } catch (e) {
    return {
      ok: false,
      reason: e?.message || "exception",
      started_at: startedAt,
      duration_ms: Date.now() - startedAtMs,
    };
  }
}

// ── Register HTTP endpoint ─────────────────────────────────────────────

app.http("adminScoreAllMissing", {
  route: "xadmin-api-score-all-missing",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: require("../_adminAuth").withAdminGuard(adminScoreAllMissingHandler),
});

module.exports = {
  handler: adminScoreAllMissingHandler,
  processBackfillScoreBatch,
  createScoreJob,
};
