// Backfill logos — START endpoint.
// Mirrors xadmin-api-backfill-homepages-start. Creates a Cosmos `backfill_jobs`
// doc with job_type="logos", returns job_id. The status endpoint
// (xadmin-api-backfill-logos-status) self-drives the worker on every poll.
//
// Pending criterion: company has website_url AND (no logo_url OR logo_approved !== true),
// AND logo_stage_status is NOT "ok"/"imported" (the merge guard — a verified blob
// logo from the existing import pipeline never gets clobbered).
//
// Failed records (logo_status === "failed") are skipped unless body.include_failed
// is set. Backfilled logos land UNAPPROVED — admin reviews in /admin/images.
const { app } = require("../_app");
const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require("uuid");
const { fetchMicrolinkLogo } = require("../_microlinkClient");
const { uploadBufferToBlob } = require("../_logoImport");

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
  const c = getCosmosClient();
  if (!c) return null;
  return c.database(E("COSMOS_DB_DATABASE", "tabarnam-db")).container(E("COSMOS_DB_COMPANIES_CONTAINER", "companies"));
}
function getBackfillJobsContainer() {
  const c = getCosmosClient();
  if (!c) return null;
  return c.database(E("COSMOS_DB_DATABASE", "tabarnam-db")).container(E("COSMOS_DB_BACKFILL_JOBS_CONTAINER", "backfill_jobs"));
}

// Skip companies whose existing logo is already a verified blob from the
// import pipeline (logo_stage_status of "ok" or "imported"). The blob path
// or stage_status alone would each be insufficient — paired they uniquely
// identify "we own this and someone has reviewed it".
function isStageVerified(c) {
  return c?.logo_stage_status === "ok" || c?.logo_stage_status === "imported";
}

function isPending(c, includeFailed, maxAttempts) {
  if (!c) return false;
  const hasUrl = typeof c.website_url === "string" && c.website_url.trim().length > 0;
  if (!hasUrl) return false;

  const hasLogo = typeof c.logo_url === "string" && c.logo_url.trim().length > 0;
  const isApproved = c.logo_approved === true;
  // "missing or unapproved" scope — anything not yet approved is fair game,
  // unless the merge guard says hands off.
  if (hasLogo && isApproved) return false;
  if (isStageVerified(c)) return false;

  if (!includeFailed && c.logo_status === "failed") return false;
  // Even when retrying failures, give up on companies that have already failed
  // maxAttempts times so they stop starving the queue. Counter resets on
  // a successful fetch.
  if (includeFailed && Number.isFinite(maxAttempts) && (Number(c.logo_fetch_attempts) || 0) >= maxAttempts) return false;
  return true;
}

function uuid() {
  return uuidv4();
}

// HTTP entrypoint
async function handler(req, context) {
  const method = String(req.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: getCorsHeaders() };

  const companiesContainer = getCompaniesContainer();
  const jobsContainer = getBackfillJobsContainer();
  if (!companiesContainer || !jobsContainer) return json({ error: "Cosmos DB not configured" }, 500);

  if (!E("MICROLINK_API_KEY")) return json({ error: "MICROLINK_API_KEY not configured on Function App" }, 500);

  let body;
  try { body = await req.json(); } catch { body = {}; }

  const batchSize = Math.max(1, Math.min(500, Number(body?.batch_size) || 50));
  const concurrency = Math.max(1, Math.min(20, Number(body?.concurrency) || 5));
  const maxCompanies = body?.max_companies != null ? Math.max(1, Number(body.max_companies)) : null;
  const includeFailed = Boolean(body?.include_failed);
  const maxAttempts = Math.max(1, Math.min(20, Number(body?.max_attempts) || 3));

  // Count pending companies
  let totalPending = 0;
  try {
    const q = `SELECT c.id, c.website_url, c.logo_url, c.logo_approved, c.logo_stage_status, c.logo_status, c.logo_fetch_attempts FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND NOT STARTSWITH(c.id, 'refresh_job_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')`;
    const { resources } = await companiesContainer.items.query(q, { enableCrossPartitionQuery: true }).fetchAll();
    totalPending = (resources || []).filter((c) => isPending(c, includeFailed, maxAttempts)).length;
  } catch (e) {
    return json({ error: `pending count failed: ${e?.message || e}` }, 500);
  }

  if (totalPending === 0) {
    return json({ ok: true, message: "No companies need logo backfill", total_to_process: 0 });
  }

  const jobId = uuid();
  const now = new Date().toISOString();
  const jobDoc = {
    id: `job_${jobId}`,
    job_id: jobId,
    job_type: "logos",
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
  };

  await jobsContainer.items.upsert(jobDoc, { partitionKey: jobId });
  context.log(`[backfill-logos-start] job=${jobId} total=${totalPending} batch=${batchSize} concurrency=${concurrency} include_failed=${includeFailed} max_attempts=${maxAttempts}`);

  return json({
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
  });
}

// ── Batch processor (runs inside the worker invocation) ────────────────
// Logos are much faster than screenshots (no render, just meta-tag extraction
// + small download). Tighter timeouts let us pack more companies per
// invocation.
const DEFAULT_INVOCATION_BUDGET_MS = 4 * 60 * 1000;
const WAVE_SAFETY_MARGIN_MS = 45 * 1000;
const PER_CALL_TIMEOUT_MS = 35 * 1000;
const PER_CALL_HARD_TIMEOUT_MS = 45 * 1000;
const IN_WAVE_HEARTBEAT_MS = 20 * 1000;
const HEARTBEAT_LOCK_EXTENSION_MS = 60 * 1000;

async function uploadOneCompany(company, { ctx }) {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  try {
    const fetched = await fetchMicrolinkLogo(company.website_url, ctx);
    if (!fetched.ok) return { ok: false, reason: fetched.reason, started_at: startedAt, duration_ms: Date.now() - startedAtMs };

    // force=true: our pending-criterion has already decided the existing logo
    // (if any) is replaceable. The blob-size guard inside uploadBufferToBlob
    // would otherwise silently drop legitimate replacements.
    let blobUrl;
    try {
      blobUrl = await uploadBufferToBlob(
        { companyId: company.id, buffer: fetched.bytes, ext: fetched.ext, contentType: fetched.contentType },
        ctx,
        { force: true }
      );
    } catch (e) {
      return { ok: false, reason: `blob_upload_failed: ${e?.message || e}`, started_at: startedAt, duration_ms: Date.now() - startedAtMs };
    }

    return {
      ok: true,
      logo_url: blobUrl,
      logo_source_url: fetched.sourceUrl,
      started_at: startedAt,
      duration_ms: Date.now() - startedAtMs,
    };
  } catch (e) {
    return { ok: false, reason: `exception: ${e?.message || e}`, started_at: startedAt, duration_ms: Date.now() - startedAtMs };
  }
}

async function uploadOneCompanyWithHardTimeout(company, opts) {
  const hardMs = Math.max(20_000, Number(opts.perCallHardTimeoutMs) || PER_CALL_HARD_TIMEOUT_MS);
  let timer = null;
  const hard = new Promise((res) => { timer = setTimeout(() => res({ ok: false, reason: `hard_timeout_${hardMs}ms`, started_at: new Date().toISOString(), duration_ms: hardMs }), hardMs); });
  try { return await Promise.race([uploadOneCompany(company, opts), hard]); }
  finally { if (timer) clearTimeout(timer); }
}

async function processBackfillLogosBatch(queueBody, context) {
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
  const attemptedThisInv = new Set();

  async function persistJob(patch) {
    try {
      const { resource: fresh } = await jobsContainer.item(`job_${jobId}`, jobId).read();
      if (!fresh) return;
      Object.assign(fresh, patch, { last_updated: new Date().toISOString() });
      await jobsContainer.items.upsert(fresh, { partitionKey: jobId });
      job = fresh;
    } catch (e) { context.log(`[backfill-logos] persistJob failed: ${e?.message || e}`); }
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
      const listQuery = `SELECT c.id, c.normalized_domain, c.company_name, c.name, c.website_url, c.logo_url, c.logo_approved, c.logo_stage_status, c.logo_status, c.logo_fetch_attempts FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND NOT STARTSWITH(c.id, 'refresh_job_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')`;
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

    context.log(`[backfill-logos] wave size=${companies.length} batch=${companiesThisInv}/${batchSize} budget=${((budgetDeadlineMs - Date.now()) / 1000).toFixed(0)}s`);

    const remainingBudgetMs = Math.max(15_000, budgetDeadlineMs - Date.now() - 5_000);
    const perCallTimeoutMs = Math.min(PER_CALL_TIMEOUT_MS, remainingBudgetMs);
    const perCallHardTimeoutMs = Math.min(PER_CALL_HARD_TIMEOUT_MS, Math.max(perCallTimeoutMs + 10_000, remainingBudgetMs));

    const heartbeatTicker = setInterval(() => {
      persistJob({
        last_heartbeat_at: new Date().toISOString(),
        lock_expires_at: new Date(Date.now() + HEARTBEAT_LOCK_EXTENSION_MS).toISOString(),
      }).catch(() => {});
    }, IN_WAVE_HEARTBEAT_MS);

    let waveResults;
    try {
      waveResults = await Promise.allSettled(
        companies.map((c) => uploadOneCompanyWithHardTimeout(c, { perCallTimeoutMs, perCallHardTimeoutMs, ctx: context }))
      );
    } finally { clearInterval(heartbeatTicker); }

    // Persist per-company results to Cosmos and accumulate for the job log
    for (let i = 0; i < waveResults.length; i++) {
      const r = waveResults[i];
      const company = companies[i];
      const companyName = company.company_name || company.name || company.normalized_domain || "unknown";
      companiesThisInv++;

      const payload = r.status === "fulfilled" ? r.value : { ok: false, reason: r.reason?.message || String(r.reason || "rejected"), started_at: new Date(waveStartMs).toISOString(), duration_ms: Date.now() - waveStartMs };

      // Mutate the company doc with success or failure metadata
      try {
        const partitionKeyValue = String(company.normalized_domain || "unknown").trim();
        const { resource: doc } = await companiesContainer.item(company.id, partitionKeyValue).read();
        if (doc) {
          if (payload.ok) {
            doc.logo_url = payload.logo_url;
            doc.logo_source_url = payload.logo_source_url || null;
            doc.logo_source_type = "microlink_backfill";
            doc.logo_status = "imported";
            doc.logo_import_status = "imported";
            doc.logo_stage_status = "imported";
            doc.logo_error = null;
            doc.logo_fetched_at = new Date().toISOString();
            doc.logo_fetch_attempts = 0;
            // DO NOT auto-approve. Admin reviews the new logo in /admin/images
            // and flips logo_approved (or images_approved) manually.
            doc.logo_approved = false;
          } else {
            doc.logo_status = "failed";
            doc.logo_error = String(payload.reason || "unknown");
            doc.logo_fetched_at = new Date().toISOString();
            doc.logo_fetch_attempts = (Number(doc.logo_fetch_attempts) || 0) + 1;
          }
          doc.updated_at = new Date().toISOString();
          await companiesContainer.items.upsert(doc, { partitionKey: partitionKeyValue });
        }
      } catch (e) {
        context.log(`[backfill-logos] persist company ${company.id} failed: ${e?.message || e}`);
      }

      if (payload.ok) processedThisInv++;
      else failuresThisInv++;

      results.push({
        company_id: company.id,
        normalized_domain: company.normalized_domain || null,
        company_name: companyName,
        ok: payload.ok,
        ...(payload.ok ? { logo_url: payload.logo_url, logo_source_url: payload.logo_source_url } : { reason: payload.reason }),
        started_at: payload.started_at,
        duration_ms: payload.duration_ms,
      });
      context.log(`[backfill-logos] ${companyName} ${payload.ok ? "OK" : "FAIL " + payload.reason} (${(payload.duration_ms / 1000).toFixed(1)}s)`);
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
    } catch (e) { context.log(`[backfill-logos] wave publish failed: ${e?.message || e}`); }
  }

  // Finalize
  const invocationDurationMs = Date.now() - invocationStartMs;
  let remaining = null;
  try {
    const q = `SELECT c.id, c.website_url, c.logo_url, c.logo_approved, c.logo_stage_status, c.logo_status, c.logo_fetch_attempts FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND NOT STARTSWITH(c.id, 'refresh_job_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')`;
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
        context.log(`[backfill-logos] job=${jobId} completed processed=${fresh.processed} failed=${fresh.failed}`);
      }
      await jobsContainer.items.upsert(fresh, { partitionKey: jobId });
      job = fresh;
    }
  } catch (e) { context.log(`[backfill-logos] final persist failed: ${e?.message || e}`); }

  context.log(`[backfill-logos] invocation done processed=${processedThisInv} failed=${failuresThisInv} remaining=${job?.remaining ?? "?"} elapsed=${(invocationDurationMs / 1000).toFixed(1)}s exit=${exitReason}`);

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
  };
}

app.http("adminBackfillLogosStart", {
  route: "xadmin-api-backfill-logos-start",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler,
});

module.exports = { handler, processBackfillLogosBatch };
