/**
 * Bulk Import Job Store
 *
 * Tracks bulk import job status in Cosmos DB.
 * Pattern based on _importPrimaryJobStore.js
 */

const { CosmosClient } = require("@azure/cosmos");
const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
  getValueAtPath,
} = require("./_cosmosPartitionKey");

function normalizeId(id) {
  const str = String(id || "").trim();
  return str || null;
}

function nowIso() {
  return new Date().toISOString();
}

function clonePlain(value) {
  if (!value || typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

// In-memory fallback for when Cosmos is unavailable
function getMemoryState() {
  if (!globalThis.__tabarnamBulkImportJobStore) {
    globalThis.__tabarnamBulkImportJobStore = {
      map: new Map(),
      order: [],
      max: 500,
    };
  }
  return globalThis.__tabarnamBulkImportJobStore;
}

function pruneMemory(state) {
  while (state.order.length > state.max) {
    const oldest = state.order.shift();
    if (oldest) state.map.delete(oldest);
  }
}

function upsertMemoryJob(jobDoc) {
  const job_id = normalizeId(jobDoc?.job_id);
  if (!job_id) return null;

  const state = getMemoryState();
  const prev = state.map.get(job_id) || null;

  const next = {
    ...(prev && typeof prev === "object" ? prev : {}),
    ...(jobDoc && typeof jobDoc === "object" ? clonePlain(jobDoc) : {}),
    job_id,
    updated_at: nowIso(),
    created_at: prev?.created_at || jobDoc?.created_at || nowIso(),
    storage: "memory",
  };

  state.map.set(job_id, next);
  if (!prev) state.order.push(job_id);
  pruneMemory(state);
  return next;
}

function getMemoryJob(jobId) {
  const jid = normalizeId(jobId);
  if (!jid) return null;
  const state = getMemoryState();
  return state.map.get(jid) || null;
}

function getMemoryJobsByBatch(batchId) {
  const bid = normalizeId(batchId);
  if (!bid) return [];
  const state = getMemoryState();
  const jobs = [];
  for (const job of state.map.values()) {
    if (job.batch_id === bid) {
      jobs.push(job);
    }
  }
  return jobs.sort((a, b) => (a.position || 0) - (b.position || 0));
}

function isCosmosConfigured() {
  const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
  const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
  return Boolean(endpoint && key);
}

let _cosmosContainerPromise;
function getCosmosContainer() {
  if (_cosmosContainerPromise) return _cosmosContainerPromise;

  _cosmosContainerPromise = (async () => {
    const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
    const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

    if (!endpoint || !key) return null;

    const client = new CosmosClient({ endpoint, key });
    return client.database(databaseId).container(containerId);
  })();

  return _cosmosContainerPromise;
}

let _companiesPkPathPromise;
async function getCompaniesPkPath(container) {
  if (!container) return "/normalized_domain";
  _companiesPkPathPromise ||= getContainerPartitionKeyPath(container, "/normalized_domain");
  try {
    return await _companiesPkPathPromise;
  } catch {
    return "/normalized_domain";
  }
}

function buildBulkJobId(jobId) {
  return `_bulk_import_job_${String(jobId || "").trim()}`;
}

function buildImportControlBase() {
  return {
    normalized_domain: "import",
    partition_key: "import",
  };
}

async function readCosmosDocWithCandidates(container, docForCandidates) {
  if (!container) return null;
  const id = String(docForCandidates?.id || "").trim();
  if (!id) return null;

  const containerPkPath = await getCompaniesPkPath(container);
  const candidates = buildPartitionKeyCandidates({
    doc: docForCandidates,
    containerPkPath,
    requestedId: id,
  });

  let lastErr = null;
  for (const partitionKeyValue of candidates) {
    try {
      const item =
        partitionKeyValue !== undefined ? container.item(id, partitionKeyValue) : container.item(id);
      const { resource } = await item.read();
      return resource || null;
    } catch (e) {
      lastErr = e;
      if (e?.code === 404) return null;
    }
  }

  if (lastErr && lastErr.code !== 404) {
    try {
      console.warn(`[bulk-import-job-store] read failed: ${lastErr.message}`);
    } catch {}
  }

  return null;
}

async function upsertCosmosDocWithCandidates(container, doc) {
  if (!container) return { ok: false, error: "no_container" };

  const id = String(doc?.id || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  const containerPkPath = await getCompaniesPkPath(container);
  const pkValue = getValueAtPath(doc, containerPkPath);
  const candidates = buildPartitionKeyCandidates({ doc, containerPkPath, requestedId: id });

  let lastErr = null;
  for (const partitionKeyValue of candidates) {
    try {
      if (partitionKeyValue !== undefined) {
        await container.items.upsert(doc, { partitionKey: partitionKeyValue });
      } else if (pkValue !== undefined) {
        await container.items.upsert(doc, { partitionKey: pkValue });
      } else {
        await container.items.upsert(doc);
      }
      return { ok: true };
    } catch (e) {
      lastErr = e;
    }
  }

  return { ok: false, error: lastErr?.message || "upsert_failed" };
}

async function queryCosmosJobsByBatch(container, batchId) {
  if (!container) return [];
  const bid = normalizeId(batchId);
  if (!bid) return [];

  try {
    const querySpec = {
      query: "SELECT * FROM c WHERE c.type = @type AND c.batch_id = @batch_id ORDER BY c.position ASC",
      parameters: [
        { name: "@type", value: "bulk_import_job" },
        { name: "@batch_id", value: bid },
      ],
    };

    const { resources } = await container.items.query(querySpec).fetchAll();
    return resources || [];
  } catch (e) {
    console.warn(`[bulk-import-job-store] query by batch failed: ${e?.message}`);
    return [];
  }
}

/**
 * Get a single job by ID
 */
async function getJob({ jobId, cosmosEnabled = true }) {
  const jid = normalizeId(jobId);
  if (!jid) return null;

  if (cosmosEnabled && isCosmosConfigured()) {
    const container = await getCosmosContainer();
    const id = buildBulkJobId(jid);

    const resource = await readCosmosDocWithCandidates(container, {
      id,
      ...buildImportControlBase(),
      type: "bulk_import_job",
    });

    if (resource) {
      return { ...resource, storage: "cosmos" };
    }
  }

  return getMemoryJob(jid);
}

/**
 * Get all jobs for a batch
 */
async function getJobsByBatch({ batchId, cosmosEnabled = true }) {
  const bid = normalizeId(batchId);
  if (!bid) return [];

  if (cosmosEnabled && isCosmosConfigured()) {
    const container = await getCosmosContainer();
    const cosmosJobs = await queryCosmosJobsByBatch(container, bid);
    if (cosmosJobs.length > 0) {
      return cosmosJobs.map((j) => ({ ...j, storage: "cosmos" }));
    }
  }

  return getMemoryJobsByBatch(bid);
}

/**
 * Create or update a job
 */
async function upsertJob({ jobDoc, cosmosEnabled = true }) {
  const jid = normalizeId(jobDoc?.job_id);
  if (!jid) return { ok: false, error: "missing_job_id" };

  const nextDoc = {
    id: String(jobDoc?.id || buildBulkJobId(jid)),
    ...buildImportControlBase(),
    type: "bulk_import_job",
    ...clonePlain(jobDoc),
    job_id: jid,
    updated_at: nowIso(),
    created_at: jobDoc?.created_at || nowIso(),
  };

  if (cosmosEnabled && isCosmosConfigured()) {
    const container = await getCosmosContainer();
    const res = await upsertCosmosDocWithCandidates(container, nextDoc);
    if (res.ok) return { ok: true, job: { ...nextDoc, storage: "cosmos" } };
  }

  const mem = upsertMemoryJob(nextDoc);
  return { ok: Boolean(mem), job: mem, ...(mem ? {} : { error: "memory_upsert_failed" }) };
}

/**
 * Update job status
 */
async function updateJobStatus({ jobId, status, session_id, error, result_summary, cosmosEnabled = true }) {
  const jid = normalizeId(jobId);
  if (!jid) return { ok: false, error: "missing_job_id" };

  const prev = await getJob({ jobId: jid, cosmosEnabled });
  if (!prev) return { ok: false, error: "not_found" };

  const patch = {
    status: String(status || prev.status || "queued"),
    updated_at: nowIso(),
  };

  if (status === "running" && !prev.started_at) {
    patch.started_at = nowIso();
  }

  if (status === "completed" || status === "failed") {
    patch.completed_at = nowIso();
  }

  if (session_id !== undefined) {
    patch.session_id = session_id;
  }

  if (error !== undefined) {
    patch.error = error;
  }

  if (result_summary !== undefined) {
    patch.result_summary = result_summary;
  }

  const nextDoc = {
    ...clonePlain(prev),
    ...patch,
  };

  return upsertJob({ jobDoc: nextDoc, cosmosEnabled });
}

/**
 * Create multiple jobs for a batch
 */
async function createBatchJobs({ batchId, jobs, cosmosEnabled = true }) {
  const bid = normalizeId(batchId);
  if (!bid) return { ok: false, error: "missing_batch_id" };
  if (!Array.isArray(jobs) || jobs.length === 0) return { ok: false, error: "no_jobs" };

  const results = [];
  for (const job of jobs) {
    const jobDoc = {
      job_id: job.job_id,
      batch_id: bid,
      url: job.url,
      position: job.position,
      status: "queued",
      session_id: null,
      error: null,
      result_summary: null,
      queued_at: nowIso(),
      started_at: null,
      completed_at: null,
    };

    const res = await upsertJob({ jobDoc, cosmosEnabled });
    results.push(res);
  }

  const allOk = results.every((r) => r.ok);
  return {
    ok: allOk,
    results,
    created_count: results.filter((r) => r.ok).length,
    failed_count: results.filter((r) => !r.ok).length,
  };
}

module.exports = {
  getJob,
  getJobsByBatch,
  upsertJob,
  updateJobStatus,
  createBatchJobs,
  buildBulkJobId,
  _test: {
    getMemoryJob,
    upsertMemoryJob,
    getMemoryJobsByBatch,
    isCosmosConfigured,
  },
};
