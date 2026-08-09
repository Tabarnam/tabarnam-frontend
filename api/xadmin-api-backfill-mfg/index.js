/**
 * Two-phase manufacturing backfill (HQ-echo remediation) — operator endpoint.
 * Route: POST /api/xadmin-api-backfill-mfg   (withAdminGuard: EasyAuth admin
 * OR x-internal-job-secret, same as xadmin-api-cleanup-import-control)
 *
 * Actions (body.action):
 *  - "start":  { company_ids: [{ company_id, normalized_domain }] }
 *      Creates a job doc in backfill_jobs and enqueues one mfg-backfill queue
 *      message per company. Phase 1 runs on the queue (canonical calls exceed
 *      the ~45s SWA gateway budget). Returns { job_id }.
 *  - "status": { job_id } → job doc summary + proposals.
 *  - "apply":  { job_id, company_ids?, time_budget_ms? }
 *      Applies stored proposals to company docs: overwrite mfg, regenerate
 *      geocodes, rebuild search text, recompute completeness, write
 *      company_edit_history entries (batch_id = job_id). Paged under the
 *      time budget — loop until done=true (same operator pattern as the
 *      import-control cleanup).
 */

const { app } = require("../_app");
const { withAdminGuard } = require("../_adminAuth");
const { getCosmosClient } = require("../_cosmosConfig");
const { geocodeLocationArray } = require("../_geocode");
const { patchCompanyWithSearchText } = require("../_computeSearchText");
const { computeMissingFields } = require("../_requiredFields");
const { computeProfileCompleteness } = require("../_profileCompleteness");
const { writeCompanyEditHistoryEntry, writeBatchSummaryEntry } = require("../_companyEditHistory");

let QueueClient;
try {
  ({ QueueClient } = require("@azure/storage-queue"));
} catch {
  QueueClient = null;
}

const DB_ID = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const QUEUE_NAME = "mfg-backfill";

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-functions-key, x-internal-job-secret, x-ms-client-principal, x-session-id",
  "Content-Type": "application/json",
});
const json = (obj, status = 200) => ({ status, headers: cors(), body: JSON.stringify(obj) });

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function getDb() {
  return getCosmosClient().database(DB_ID);
}

async function getQueue() {
  if (!QueueClient) throw new Error("storage_queue_sdk_unavailable");
  const conn = asString(process.env.AzureWebJobsStorage).trim();
  if (!conn) throw new Error("missing_queue_connection");
  const client = new QueueClient(conn, QUEUE_NAME);
  await client.createIfNotExists();
  return client;
}

async function handleStart(body) {
  const list = Array.isArray(body?.company_ids) ? body.company_ids : [];
  const entries = list
    .map((e) =>
      typeof e === "string"
        ? { company_id: e.trim(), normalized_domain: "" }
        : { company_id: asString(e?.company_id || e?.id).trim(), normalized_domain: asString(e?.normalized_domain || e?.domain).trim() },
    )
    .filter((e) => e.company_id);
  if (!entries.length) return json({ ok: false, error: "company_ids required" }, 400);
  if (entries.length > 500) return json({ ok: false, error: "max 500 companies per job" }, 400);

  const jobId = `mfgfix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const jobs = getDb().container("backfill_jobs");
  await jobs.items.create(
    {
      id: jobId,
      job_id: jobId,
      type: "mfg_backfill",
      phase: "propose",
      created_at: new Date().toISOString(),
      total: entries.length,
      completed: 0,
      requested: entries,
      proposals: {},
      applied: {},
    },
    { partitionKey: jobId },
  );

  const queue = await getQueue();
  let enqueued = 0;
  for (const e of entries) {
    await queue.sendMessage(JSON.stringify({ job_id: jobId, company_id: e.company_id, normalized_domain: e.normalized_domain }));
    enqueued++;
  }
  return json({ ok: true, job_id: jobId, enqueued, total: entries.length });
}

async function handleStatus(body) {
  const jobId = asString(body?.job_id).trim();
  if (!jobId) return json({ ok: false, error: "job_id required" }, 400);
  const jobs = getDb().container("backfill_jobs");
  const { resource } = await jobs.item(jobId, jobId).read().catch(() => ({ resource: null }));
  if (!resource) return json({ ok: false, error: "job not found" }, 404);

  const proposals = resource.proposals || {};
  const counts = {};
  for (const p of Object.values(proposals)) counts[p.status] = (counts[p.status] || 0) + 1;
  return json({
    ok: true,
    job_id: jobId,
    phase: resource.phase,
    total: resource.total,
    completed: resource.completed || 0,
    applied_count: Object.keys(resource.applied || {}).length,
    counts,
    proposals,
  });
}

async function applyOne(companies, doc, proposal) {
  const before = JSON.parse(JSON.stringify(doc));

  doc.manufacturing_locations = [...proposal.proposed_mfg];
  doc.manufacturing_locations_status = "ok";
  doc.mfg_unknown = false;
  doc.mfg_unknown_reason = null;
  if (doc.import_missing_reason && typeof doc.import_missing_reason === "object") {
    delete doc.import_missing_reason.manufacturing_locations;
  }
  if (Array.isArray(proposal.mfg_source_urls) && proposal.mfg_source_urls.length) {
    doc.location_source_urls = {
      ...(doc.location_source_urls && typeof doc.location_source_urls === "object" ? doc.location_source_urls : {}),
      mfg_source_urls: proposal.mfg_source_urls,
    };
  }

  const seeds = doc.manufacturing_locations.map((loc) => ({ location: loc, address: loc }));
  const geocoded = await geocodeLocationArray(seeds, { timeoutMs: 5000, concurrency: 4 }).catch(() => null);
  if (Array.isArray(geocoded) && geocoded.length) {
    doc.manufacturing_geocodes = geocoded;
  } else {
    // Old geocodes describe the old (wrong) value — never leave them behind.
    doc.manufacturing_geocodes = [];
  }

  patchCompanyWithSearchText(doc);
  doc.import_missing_fields = computeMissingFields(doc);
  const completeness = computeProfileCompleteness(doc);
  doc.profile_completeness = completeness.profile_completeness;
  doc.profile_completeness_version = completeness.profile_completeness_version;
  doc.profile_completeness_meta = completeness.profile_completeness_meta;
  doc.updated_at = new Date().toISOString();

  await companies.items.upsert(doc, { partitionKey: doc.normalized_domain });
  return before;
}

async function handleApply(body) {
  const jobId = asString(body?.job_id).trim();
  if (!jobId) return json({ ok: false, error: "job_id required" }, 400);
  const timeBudgetMs = Number.isFinite(Number(body?.time_budget_ms)) ? Number(body.time_budget_ms) : 35_000;
  const onlyIds = Array.isArray(body?.company_ids) ? new Set(body.company_ids.map((x) => asString(x).trim())) : null;
  const startedAt = Date.now();

  const db = getDb();
  const jobs = db.container("backfill_jobs");
  const companies = db.container(process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies");

  const { resource: job } = await jobs.item(jobId, jobId).read().catch(() => ({ resource: null }));
  if (!job) return json({ ok: false, error: "job not found" }, 404);

  const proposals = job.proposals || {};
  job.applied = job.applied || {};

  const worklist = Object.entries(proposals).filter(([cid, p]) => {
    if (job.applied[cid]) return false;
    if (onlyIds && !onlyIds.has(cid)) return false;
    return p.status === "proposed" && Array.isArray(p.proposed_mfg) && p.proposed_mfg.length > 0;
  });

  let appliedNow = 0;
  const failures = [];
  for (const [cid, p] of worklist) {
    if (Date.now() - startedAt > timeBudgetMs) break;
    try {
      const { resource: doc } = await companies
        .item(cid, p.normalized_domain)
        .read()
        .catch(() => ({ resource: null }));
      if (!doc) throw new Error("company_not_found");

      const before = await applyOne(companies, doc, p);
      await writeCompanyEditHistoryEntry({
        company_id: cid,
        before,
        after: doc,
        action: "mfg_backfill_apply",
        source: "mfg-backfill",
        actor_email: "internal-job",
        batch_id: jobId,
      });
      job.applied[cid] = { at: new Date().toISOString(), mfg: p.proposed_mfg };
      appliedNow++;
    } catch (e) {
      failures.push({ company_id: cid, error: String(e?.message || e).slice(0, 200) });
      job.applied[cid] = { at: new Date().toISOString(), error: String(e?.message || e).slice(0, 200) };
    }
  }

  const remaining = worklist.length - appliedNow - failures.length;
  const done = remaining <= 0;
  if (done && job.phase !== "applied") {
    job.phase = "applied";
    await writeBatchSummaryEntry({
      action: "mfg_backfill_summary",
      source: "mfg-backfill",
      actor_email: "internal-job",
      batch_id: jobId,
      summary: { job_id: jobId, applied: Object.keys(job.applied).length, failures: failures.length },
    }).catch(() => null);
  }
  await jobs.items.upsert(job, { partitionKey: jobId });

  return json({ ok: true, job_id: jobId, applied_now: appliedNow, failures, remaining, done });
}

async function handler(req, context) {
  if (String(req?.method || "").toUpperCase() === "OPTIONS") return { status: 200, headers: cors() };
  let body = {};
  try {
    body = (await req.json()) || {};
  } catch {
    body = {};
  }
  const action = asString(body?.action).trim().toLowerCase();
  try {
    if (action === "start") return await handleStart(body);
    if (action === "status") return await handleStatus(body);
    if (action === "apply") return await handleApply(body);
    return json({ ok: false, error: "action must be start | status | apply" }, 400);
  } catch (e) {
    context?.error?.(`[xadmin-api-backfill-mfg] unhandled`, { message: e?.message || String(e) });
    // 200 with error body so operator loops see the message instead of a bare 500.
    return json({ ok: false, error: String(e?.message || e) }, 200);
  }
}

app.http("xadminApiBackfillMfg", {
  route: "xadmin-api-backfill-mfg",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: withAdminGuard(handler),
});

module.exports = {};
