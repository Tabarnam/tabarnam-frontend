// Backfill homepages — START endpoint.
// Mirrors xadmin-api-score-all-missing exactly: creates a Cosmos `backfill_jobs`
// doc with job_type="homepages", returns job_id. The status endpoint
// (xadmin-api-backfill-homepages-status) self-drives the worker on every poll.
//
// Pending criterion: company has website_url but no homepage_image_url.
// Failed records (homepage_fetch_status === "failed") are skipped unless
// body.include_failed === true.
const { app } = require("../_app");
const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require("uuid");
const { fetchAndPersistHomepageForCompany } = require("../_microlinkBackfill");

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
  const c = getCosmosClient();
  if (!c) return null;
  return c.database(E("COSMOS_DB_DATABASE", "tabarnam-db")).container(E("COSMOS_DB_COMPANIES_CONTAINER", "companies"));
}
function getBackfillJobsContainer() {
  const c = getCosmosClient();
  if (!c) return null;
  return c.database(E("COSMOS_DB_DATABASE", "tabarnam-db")).container(E("COSMOS_DB_BACKFILL_JOBS_CONTAINER", "backfill_jobs"));
}

function isPending(c, includeFailed, maxAttempts) {
  if (!c) return false;
  const hasUrl = typeof c.website_url === "string" && c.website_url.trim().length > 0;
  if (!hasUrl) return false;
  const hasImage = typeof c.homepage_image_url === "string" && c.homepage_image_url.trim().length > 0;
  if (hasImage) return false;
  if (!includeFailed && c.homepage_fetch_status === "failed") return false;
  // Even when retrying failures, give up on companies that have already failed
  // maxAttempts times. Otherwise sites that block all renderers (Cloudflare,
  // PerimeterX, dead domains) re-queue every wave forever and starve the rest
  // of the queue. Counter resets on a successful fetch.
  if (includeFailed && Number.isFinite(maxAttempts) && (Number(c.homepage_fetch_attempts) || 0) >= maxAttempts) return false;
  return true;
}

function uuid() {
  return uuidv4();
}

// Fire-and-forget HTTP POST to the worker endpoint to kick off processing.
// Mirrors the pattern in xadmin-api-backfill-homepages-status. Used to start
// the worker the moment a new job is created so admins (and the import flow)
// don't have to wait for the status endpoint to be polled. Lock semantics in
// the worker make double-fire safe — a second invocation just sees the lock
// and skips.
async function fireBatchWorker(jobId, logger) {
  const host = (process.env.WEBSITE_HOSTNAME || "").trim();
  if (!host) {
    logger?.log?.(`[backfill-homepages-start] worker fire skipped: WEBSITE_HOSTNAME not set`);
    return;
  }
  const url = `https://${host}/api/xadmin-api-backfill-homepages-worker`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    // Race a fire-and-forget timeout — we only care that the request was
    // dispatched, not that the worker finished. The worker has its own
    // 4-min budget and will run independently of this caller.
    await Promise.race([
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId }),
        signal: ctl.signal,
        keepalive: true,
      }).catch(() => null),
      new Promise((res) => setTimeout(res, 800)),
    ]);
  } catch (e) {
    logger?.log?.(`[backfill-homepages-start] worker fire soft-error: ${e?.message || e}`);
  } finally { clearTimeout(timer); }
}

/**
 * Create a homepage backfill job in Cosmos `backfill_jobs`. Used by both the
 * HTTP endpoint (manual admin-triggered backfill) and the import flow
 * (auto-triggered after companies are saved). Returns:
 *   { ok: true, job_id, total_to_process, ...job opts }   on success
 *   { ok: true, total_to_process: 0 }                     when nothing pending
 *   { ok: false, error }                                  on configuration / query failure
 *
 * Options:
 *   batchSize, concurrency, maxCompanies, includeFailed, maxAttempts
 *   source: free-form tag stored on the job doc (e.g. "admin_ui", "import_auto")
 *   logger: optional { log(msg) } (defaults to console)
 */
async function createHomepageBackfillJob(options = {}) {
  const logger = options.logger || console;
  const companiesContainer = getCompaniesContainer();
  const jobsContainer = getBackfillJobsContainer();
  if (!companiesContainer || !jobsContainer) {
    return { ok: false, error: "Cosmos DB not configured" };
  }
  if (!E("MICROLINK_API_KEY")) {
    return { ok: false, error: "MICROLINK_API_KEY not configured on Function App" };
  }

  const batchSize = Math.max(1, Math.min(500, Number(options.batchSize) || 50));
  const concurrency = Math.max(1, Math.min(20, Number(options.concurrency) || 5));
  const maxCompanies = options.maxCompanies != null ? Math.max(1, Number(options.maxCompanies)) : null;
  const includeFailed = Boolean(options.includeFailed);
  const maxAttempts = Math.max(1, Math.min(20, Number(options.maxAttempts) || 3));
  const source = typeof options.source === "string" ? options.source.trim() : "";

  // Phase 2.19.C — dedupe concurrent auto-trigger calls.
  //
  // Empirical (Sundance + Teepee Creepers 2026-05-09 00:20:06): each
  // resume-worker session auto-triggers a homepage backfill when its
  // session completes. With Phase 2.17's rolling-pool dispatcher, 4
  // companies in a batch can produce 4+ near-simultaneous trigger calls
  // — we observed two backfill jobs (4ef58e23 with pending=2 + 8a0a3465
  // with pending=3) running concurrently and re-processing the same
  // companies (Sundance and Teepee each appeared in both jobs, costing
  // ~25s of wasted Microlink calls + Cosmos writes per batch).
  //
  // Dedupe at the source: if a job for the same `source` value (e.g.
  // "import_auto") is already running and was started within the last
  // 30 seconds, return that job's id instead of creating a new one.
  // The existing job will pick up any newly-pending companies on its
  // next batch poll. Net: one job processes all 4 companies in a
  // batch, instead of 2-4 jobs racing.
  //
  // Only auto-trigger callers benefit (they share source="import_auto").
  // Manual admin triggers (different source string) still create their
  // own jobs.
  if (source) {
    try {
      const RECENT_JOB_WINDOW_MS = 30_000;
      const cutoffIso = new Date(Date.now() - RECENT_JOB_WINDOW_MS).toISOString();
      const query = `SELECT c.id, c.job_id, c.started_at, c.total_to_process, c.processed, c.failed, c.status FROM c WHERE c.job_type = "homepages" AND c.source = @source AND c.status = "running" AND c.started_at > @cutoff ORDER BY c.started_at DESC`;
      const { resources: recent } = await jobsContainer.items
        .query(
          { query, parameters: [{ name: "@source", value: source }, { name: "@cutoff", value: cutoffIso }] },
          { enableCrossPartitionQuery: true }
        )
        .fetchAll();
      if (Array.isArray(recent) && recent.length > 0) {
        const existing = recent[0];
        try {
          logger.log(`[backfill-homepages-start] dedupe_skip: existing job=${existing.job_id} source=${source} started_at=${existing.started_at} — returning existing job instead of creating new`);
        } catch {}
        return {
          ok: true,
          job_id: existing.job_id,
          total_to_process: existing.total_to_process || 0,
          processed: existing.processed || 0,
          failed: existing.failed || 0,
          status: existing.status,
          deduped: true,
          message: `Reusing recent job ${existing.job_id} (started ${existing.started_at})`,
        };
      }
    } catch (e) {
      // Dedup query failed — fall through to normal creation. Better to
      // create a duplicate than fail an auto-trigger entirely.
      try {
        logger.warn(`[backfill-homepages-start] dedup_query_failed: ${e?.message || e} — proceeding with new job`);
      } catch {}
    }
  }

  // Count pending companies
  let totalPending = 0;
  try {
    const q = `SELECT c.id, c.website_url, c.homepage_image_url, c.homepage_fetch_status, c.homepage_fetch_attempts FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND NOT STARTSWITH(c.id, 'refresh_job_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')`;
    const { resources } = await companiesContainer.items.query(q, { enableCrossPartitionQuery: true }).fetchAll();
    totalPending = (resources || []).filter((c) => isPending(c, includeFailed, maxAttempts)).length;
  } catch (e) {
    return { ok: false, error: `pending count failed: ${e?.message || e}` };
  }

  if (totalPending === 0) {
    return { ok: true, total_to_process: 0, message: "No companies need homepage backfill" };
  }

  const jobId = uuid();
  const now = new Date().toISOString();
  const jobDoc = {
    id: `job_${jobId}`,
    job_id: jobId,
    job_type: "homepages",
    status: "running",
    batch_size: batchSize,
    concurrency,
    max_companies: maxCompanies,
    include_failed: includeFailed,
    max_attempts: maxAttempts,
    total_to_process: totalPending,
    processed: 0,
    failed: 0,
    remaining: totalPending,
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
  logger.log?.(`[backfill-homepages-start] job=${jobId} total=${totalPending} batch=${batchSize} concurrency=${concurrency} include_failed=${includeFailed} max_attempts=${maxAttempts} source=${source || "n/a"}`);

  // Kick off the worker so the job actually starts processing — without this,
  // the job sits idle until /admin/backfill-homepages is polled. Fire-and-forget;
  // the worker has its own 4-min budget independent of this caller.
  await fireBatchWorker(jobId, logger);

  return {
    ok: true,
    job_id: jobId,
    status: "running",
    total_to_process: totalPending,
    processed: 0,
    remaining: totalPending,
    batch_size: batchSize,
    concurrency,
    max_companies: maxCompanies,
    include_failed: includeFailed,
    max_attempts: maxAttempts,
  };
}

// HTTP entrypoint
async function handler(req, context) {
  const method = String(req.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: getCorsHeaders() };

  let body;
  try { body = await req.json(); } catch { body = {}; }

  const result = await createHomepageBackfillJob({
    batchSize: body?.batch_size,
    concurrency: body?.concurrency,
    maxCompanies: body?.max_companies,
    includeFailed: body?.include_failed,
    maxAttempts: body?.max_attempts,
    source: typeof body?.source === "string" ? body.source : "admin_ui",
    logger: context,
  });

  if (!result.ok) {
    return json({ error: result.error }, 500);
  }
  if (result.total_to_process === 0) {
    return json({ ok: true, message: result.message, total_to_process: 0 });
  }
  return json(result);
}

// ── Batch processor (runs inside the worker invocation) ────────────────
const DEFAULT_INVOCATION_BUDGET_MS = 4 * 60 * 1000;
const WAVE_SAFETY_MARGIN_MS = 75 * 1000;
const PER_CALL_HARD_TIMEOUT_MS = 90 * 1000;
const IN_WAVE_HEARTBEAT_MS = 20 * 1000;
const HEARTBEAT_LOCK_EXTENSION_MS = 60 * 1000;

// Per-company fetch + persist now lives in api/_microlinkBackfill.js so both
// this bulk worker and the per-row admin endpoint share field-write logic.
// We keep a hard-timeout race here because the bulk job has a finite
// invocation budget and a single stuck Microlink call can otherwise burn it.
async function uploadOneCompanyWithHardTimeout(company, { perCallHardTimeoutMs, ctx }) {
  const hardMs = Math.max(30_000, Number(perCallHardTimeoutMs) || PER_CALL_HARD_TIMEOUT_MS);
  let timer = null;
  const hard = new Promise((res) => { timer = setTimeout(() => res({ ok: false, reason: `hard_timeout_${hardMs}ms`, started_at: new Date().toISOString(), duration_ms: hardMs }), hardMs); });
  try {
    return await Promise.race([
      fetchAndPersistHomepageForCompany(company, ctx, { autoApprove: false }),
      hard,
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function processBackfillHomepagesBatch(queueBody, context) {
  const jobId = String(queueBody?.session_id || queueBody?.job_id || "").trim();
  if (!jobId) return { ok: false, error: "missing_job_id" };

  const companiesContainer = getCompaniesContainer();
  const jobsContainer = getBackfillJobsContainer();
  if (!companiesContainer || !jobsContainer) return { ok: false, error: "cosmos_not_configured" };

  const invocationStartMs = Date.now();
  const invocationBudgetMs = Math.max(30_000, Number(queueBody?.invocationBudgetMs) || DEFAULT_INVOCATION_BUDGET_MS);
  const budgetDeadlineMs = invocationStartMs + invocationBudgetMs;

  let job;
  try {
    const { resource } = await jobsContainer.item(`job_${jobId}`, jobId).read();
    job = resource;
  } catch (e) { return { ok: false, error: `job_not_found: ${e?.message || e}` }; }
  if (!job) return { ok: false, error: "job_not_found" };
  if (job.status !== "running") return { ok: true, skipped: true, reason: `job status is ${job.status}` };

  if ((job.cycle_count || 0) > 10_000) {
    job.status = "paused";
    job.last_updated = new Date().toISOString();
    await jobsContainer.items.upsert(job, { partitionKey: jobId });
    return { ok: true, auto_paused: true, reason: "cycle_count exceeded 10000" };
  }

  const batchSize = Math.max(1, Number(job.batch_size) || 50);
  const concurrency = Math.max(1, Math.min(20, Number(job.concurrency) || 5));
  const maxCompanies = job.max_companies;
  const includeFailed = Boolean(job.include_failed);
  // Default to 3 for jobs created before this field existed.
  const maxAttempts = Math.max(1, Math.min(20, Number(job.max_attempts) || 3));

  let processedThisInv = 0;
  let failuresThisInv = 0;
  let companiesThisInv = 0;
  const results = [];
  let exitReason = "completed_batch";
  // Each company gets at most one Microlink call per worker invocation —
  // even with include_failed=true, otherwise sites that fail every time
  // (Cloudflare-blocked, dead, etc.) re-queue every wave and burn the whole
  // 4-min budget without making progress.
  const attemptedThisInv = new Set();

  async function persistJob(patch) {
    try {
      const { resource: fresh } = await jobsContainer.item(`job_${jobId}`, jobId).read();
      if (!fresh) return;
      Object.assign(fresh, patch, { last_updated: new Date().toISOString() });
      await jobsContainer.items.upsert(fresh, { partitionKey: jobId });
      job = fresh;
    } catch (e) { context.log(`[backfill-homepages] persistJob failed: ${e?.message || e}`); }
  }

  async function heartbeat(extra = {}) {
    await persistJob({
      last_heartbeat_at: new Date().toISOString(),
      lock_expires_at: new Date(Date.now() + HEARTBEAT_LOCK_EXTENSION_MS).toISOString(),
      ...extra,
    });
  }

  while (true) {
    const now = Date.now();
    if (now + WAVE_SAFETY_MARGIN_MS >= budgetDeadlineMs) { exitReason = "budget_exhausted"; break; }
    if (companiesThisInv >= batchSize) { exitReason = "batch_size_reached"; break; }

    try {
      const { resource: fresh } = await jobsContainer.item(`job_${jobId}`, jobId).read();
      if (fresh && fresh.status !== "running") { exitReason = `status_changed_to_${fresh.status}`; job = fresh; break; }
      if (fresh) job = fresh;
    } catch { /* ignore */ }

    let companies = [];
    try {
      const listQuery = `SELECT c.id, c.normalized_domain, c.company_name, c.name, c.website_url, c.homepage_image_url, c.homepage_fetch_status, c.homepage_fetch_attempts FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND NOT STARTSWITH(c.id, 'refresh_job_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')`;
      const { resources: listRows } = await companiesContainer.items.query(listQuery, { enableCrossPartitionQuery: true }).fetchAll();

      const remByMax = maxCompanies != null ? Math.max(0, Number(maxCompanies) - (job.processed || 0) - processedThisInv) : Infinity;
      const remByBatch = Math.max(0, batchSize - companiesThisInv);
      const waveSize = Math.min(concurrency, remByBatch, remByMax);
      if (waveSize <= 0) { exitReason = maxCompanies != null ? "max_companies_reached" : "batch_size_reached"; break; }

      const pendingRows = (listRows || [])
        .filter((r) => isPending(r, includeFailed, maxAttempts))
        .filter((r) => !attemptedThisInv.has(r.id))
        .slice(0, waveSize);
      if (pendingRows.length === 0) { exitReason = "no_pending_remaining"; break; }
      for (const r of pendingRows) attemptedThisInv.add(r.id);

      const reads = pendingRows.map((row) => {
        const pk = String(row.normalized_domain || "unknown").trim();
        return companiesContainer.item(row.id, pk).read().then((r) => r?.resource || null).catch(() => null);
      });
      companies = (await Promise.all(reads)).filter(Boolean);
    } catch (e) { exitReason = `query_error: ${e?.message || e}`; break; }

    if (companies.length === 0) { exitReason = "no_pending_remaining"; break; }

    const waveStartMs = Date.now();
    const currentCompanies = companies.map((c) => ({
      id: c.id,
      name: c.company_name || c.name || c.normalized_domain || "unknown",
      domain: c.normalized_domain || null,
      started_at: new Date(waveStartMs).toISOString(),
    }));
    await heartbeat({ current_companies: currentCompanies });

    context.log(`[backfill-homepages] wave size=${companies.length} batch=${companiesThisInv}/${batchSize} budget=${((budgetDeadlineMs - Date.now()) / 1000).toFixed(0)}s`);

    const remainingBudgetMs = Math.max(15_000, budgetDeadlineMs - Date.now() - 5_000);
    // Hard timeout bounded by what's left in the invocation budget so a stuck
    // Microlink call can't run past the wave deadline. The fetchMicrolink*
    // helpers enforce their own 60s soft timeout internally.
    const perCallHardTimeoutMs = Math.min(PER_CALL_HARD_TIMEOUT_MS, remainingBudgetMs);

    const heartbeatTicker = setInterval(() => {
      persistJob({
        last_heartbeat_at: new Date().toISOString(),
        lock_expires_at: new Date(Date.now() + HEARTBEAT_LOCK_EXTENSION_MS).toISOString(),
      }).catch(() => {});
    }, IN_WAVE_HEARTBEAT_MS);

    let waveResults;
    try {
      waveResults = await Promise.allSettled(
        // Hard-timeout race protects the bulk job's 4-min invocation budget
        // from a single stuck Microlink call. The inner fetch already
        // enforces its own per-request timeout.
        companies.map((c) => uploadOneCompanyWithHardTimeout(c, { perCallHardTimeoutMs, ctx: context }))
      );
    } finally { clearInterval(heartbeatTicker); }

    // The shared persist function in _microlinkBackfill.js has already
    // mutated each company doc; this loop just aggregates the wave's results
    // for the job log + counters.
    for (let i = 0; i < waveResults.length; i++) {
      const r = waveResults[i];
      const company = companies[i];
      const companyName = company.company_name || company.name || company.normalized_domain || "unknown";
      companiesThisInv++;

      const payload = r.status === "fulfilled" ? r.value : { ok: false, reason: r.reason?.message || String(r.reason || "rejected"), started_at: new Date(waveStartMs).toISOString(), duration_ms: Date.now() - waveStartMs };

      if (payload.ok) processedThisInv++;
      else failuresThisInv++;

      results.push({
        company_id: company.id,
        normalized_domain: company.normalized_domain || null,
        company_name: companyName,
        ok: payload.ok,
        ...(payload.ok ? { homepage_image_url: payload.homepage_image_url } : { reason: payload.reason }),
        started_at: payload.started_at,
        duration_ms: payload.duration_ms,
      });
      context.log(`[backfill-homepages] ${companyName} ${payload.ok ? "OK" : "FAIL " + payload.reason} (${(payload.duration_ms / 1000).toFixed(1)}s)`);
    }

    // Wave complete: prepend results, refresh heartbeat / lock
    try {
      const { resource: fresh } = await jobsContainer.item(`job_${jobId}`, jobId).read();
      if (fresh) {
        const existing = Array.isArray(fresh.last_batch_results) ? fresh.last_batch_results : [];
        fresh.last_batch_results = [...results.slice(-companies.length).reverse(), ...existing].slice(0, 100);
        fresh.current_companies = [];
        fresh.last_heartbeat_at = new Date().toISOString();
        fresh.lock_expires_at = new Date(Date.now() + HEARTBEAT_LOCK_EXTENSION_MS).toISOString();
        fresh.last_updated = new Date().toISOString();
        await jobsContainer.items.upsert(fresh, { partitionKey: jobId });
        job = fresh;
      }
    } catch (e) { context.log(`[backfill-homepages] wave publish failed: ${e?.message || e}`); }
  }

  // Finalize
  const invocationDurationMs = Date.now() - invocationStartMs;
  let remaining = null;
  try {
    const q = `SELECT c.id, c.website_url, c.homepage_image_url, c.homepage_fetch_status, c.homepage_fetch_attempts FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND NOT STARTSWITH(c.id, 'refresh_job_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')`;
    const { resources } = await companiesContainer.items.query(q, { enableCrossPartitionQuery: true }).fetchAll();
    remaining = (resources || []).filter((c) => isPending(c, includeFailed, maxAttempts)).length;
  } catch { /* leave null */ }

  try {
    const { resource: fresh } = await jobsContainer.item(`job_${jobId}`, jobId).read();
    if (fresh) {
      fresh.processed = (fresh.processed || 0) + processedThisInv;
      fresh.failed = (fresh.failed || 0) + failuresThisInv;
      fresh.cycle_count = (fresh.cycle_count || 0) + 1;
      if (remaining != null) fresh.remaining = remaining;
      else fresh.remaining = Math.max(0, (fresh.total_to_process || 0) - fresh.processed);
      if (companiesThisInv > 0 && invocationDurationMs > 0) {
        const secsPerCompany = invocationDurationMs / 1000 / companiesThisInv;
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
        context.log(`[backfill-homepages] job=${jobId} completed processed=${fresh.processed} failed=${fresh.failed}`);
      }
      await jobsContainer.items.upsert(fresh, { partitionKey: jobId });
      job = fresh;
    }
  } catch (e) { context.log(`[backfill-homepages] final persist failed: ${e?.message || e}`); }

  context.log(`[backfill-homepages] invocation done processed=${processedThisInv} failed=${failuresThisInv} remaining=${job?.remaining ?? "?"} elapsed=${(invocationDurationMs / 1000).toFixed(1)}s exit=${exitReason}`);

  // Self-re-fire: if the job is still running and there's work remaining,
  // fire another worker invocation so processing continues without
  // requiring admin polling. The status endpoint no longer self-drives,
  // so this handoff is what keeps long jobs progressing to completion.
  // Only re-fire on budget-exhausted or batch-size-reached exits — the
  // "no_pending_remaining" / status-changed exits mean we should stop.
  const shouldHandoff =
    job?.status === "running" &&
    (job?.remaining ?? 0) > 0 &&
    (exitReason === "budget_exhausted" || exitReason === "batch_size_reached");
  if (shouldHandoff) {
    context.log(`[backfill-homepages] handoff: re-firing worker for job=${jobId} remaining=${job.remaining}`);
    await fireBatchWorker(jobId, context);
  }

  return {
    ok: true,
    job_id: jobId,
    processed: processedThisInv,
    failed: failuresThisInv,
    remaining: job?.remaining ?? null,
    cycle_count: job?.cycle_count ?? null,
    duration_ms: invocationDurationMs,
    exit_reason: exitReason,
    status: job?.status ?? "running",
    ...(shouldHandoff ? { handoff_fired: true } : {}),
  };
}

app.http("adminBackfillHomepagesStart", {
  route: "xadmin-api-backfill-homepages-start",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: require("../_adminAuth").withAdminGuard(handler),
});

module.exports = { handler, processBackfillHomepagesBatch, createHomepageBackfillJob };
