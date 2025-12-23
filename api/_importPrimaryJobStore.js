const { CosmosClient } = require("@azure/cosmos");
const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
  getValueAtPath,
} = require("./_cosmosPartitionKey");

function normalizeSessionId(sessionId) {
  const sid = String(sessionId || "").trim();
  return sid || null;
}

function nowIso() {
  return new Date().toISOString();
}

function getMemoryState() {
  if (!globalThis.__tabarnamImportPrimaryJobStore) {
    globalThis.__tabarnamImportPrimaryJobStore = {
      map: new Map(),
      order: [],
      max: 200,
    };
  }
  return globalThis.__tabarnamImportPrimaryJobStore;
}

function pruneMemory(state) {
  while (state.order.length > state.max) {
    const oldest = state.order.shift();
    if (oldest) state.map.delete(oldest);
  }
}

function clonePlain(value) {
  if (!value || typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function upsertMemoryJob(jobDoc) {
  const session_id = normalizeSessionId(jobDoc?.session_id);
  if (!session_id) return null;

  const state = getMemoryState();
  const prev = state.map.get(session_id) || null;

  const next = {
    ...(prev && typeof prev === "object" ? prev : {}),
    ...(jobDoc && typeof jobDoc === "object" ? clonePlain(jobDoc) : {}),
    session_id,
    updated_at: nowIso(),
    created_at: prev?.created_at || jobDoc?.created_at || nowIso(),
    storage: "memory",
  };

  state.map.set(session_id, next);
  if (!prev) state.order.push(session_id);
  pruneMemory(state);
  return next;
}

function getMemoryJob(sessionId) {
  const sid = normalizeSessionId(sessionId);
  if (!sid) return null;
  const state = getMemoryState();
  return state.map.get(sid) || null;
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

function buildPrimaryJobId(sessionId) {
  return `_import_primary_job_${String(sessionId || "").trim()}`;
}

function buildImportControlBase(sessionId) {
  return {
    session_id: sessionId,
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
      console.warn(`[import-primary-job-store] read failed: ${lastErr.message}`);
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

async function replaceCosmosDocWithEtagCandidates(container, doc, etag) {
  if (!container) return { ok: false, error: "no_container" };

  const id = String(doc?.id || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  const containerPkPath = await getCompaniesPkPath(container);
  const pkValue = getValueAtPath(doc, containerPkPath);
  const candidates = buildPartitionKeyCandidates({ doc, containerPkPath, requestedId: id });

  let lastErr = null;
  for (const partitionKeyValue of candidates) {
    try {
      const item =
        partitionKeyValue !== undefined
          ? container.item(id, partitionKeyValue)
          : pkValue !== undefined
            ? container.item(id, pkValue)
            : container.item(id);

      const { resource } = await item.replace(doc, {
        accessCondition: {
          type: "IfMatch",
          condition: etag,
        },
      });

      return { ok: true, resource: resource || null };
    } catch (e) {
      lastErr = e;
      if (e?.code === 412) return { ok: false, error: "etag_mismatch" };
    }
  }

  return { ok: false, error: lastErr?.message || "replace_failed" };
}

async function getJob({ sessionId, cosmosEnabled }) {
  const sid = normalizeSessionId(sessionId);
  if (!sid) return null;

  if (cosmosEnabled && isCosmosConfigured()) {
    const container = await getCosmosContainer();
    const id = buildPrimaryJobId(sid);

    const resource = await readCosmosDocWithCandidates(container, {
      id,
      ...buildImportControlBase(sid),
      type: "import_primary_job",
    });

    if (resource) {
      return { ...resource, storage: "cosmos" };
    }
  }

  return getMemoryJob(sid);
}

async function upsertJob({ jobDoc, cosmosEnabled }) {
  const sid = normalizeSessionId(jobDoc?.session_id);
  if (!sid) return { ok: false, error: "missing_session_id" };

  const nextDoc = {
    id: String(jobDoc?.id || buildPrimaryJobId(sid)),
    ...buildImportControlBase(sid),
    type: "import_primary_job",
    ...clonePlain(jobDoc),
    session_id: sid,
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

async function patchJob({ sessionId, cosmosEnabled, patch }) {
  const sid = normalizeSessionId(sessionId);
  if (!sid) return { ok: false, error: "missing_session_id" };

  const prev = await getJob({ sessionId: sid, cosmosEnabled });
  if (!prev) return { ok: false, error: "not_found" };

  const next = {
    ...(prev && typeof prev === "object" ? clonePlain(prev) : {}),
    ...(patch && typeof patch === "object" ? clonePlain(patch) : {}),
    id: prev.id || buildPrimaryJobId(sid),
    session_id: sid,
    updated_at: nowIso(),
  };

  if (prev.storage === "cosmos" && isCosmosConfigured()) {
    const container = await getCosmosContainer();
    const etag = prev._etag || prev.etag || null;
    if (etag) {
      const res = await replaceCosmosDocWithEtagCandidates(container, next, etag);
      if (res.ok) return { ok: true, job: { ...(res.resource || next), storage: "cosmos" } };
      if (res.error === "etag_mismatch") return { ok: false, error: "conflict" };
    }

    const upsertRes = await upsertCosmosDocWithCandidates(container, next);
    if (upsertRes.ok) return { ok: true, job: { ...next, storage: "cosmos" } };
  }

  const mem = upsertMemoryJob(next);
  return { ok: Boolean(mem), job: mem, ...(mem ? {} : { error: "memory_patch_failed" }) };
}

async function tryClaimJob({ sessionId, cosmosEnabled, workerId, lockTtlMs }) {
  const sid = normalizeSessionId(sessionId);
  const wid = String(workerId || "").trim() || `worker_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const ttlMs = Number.isFinite(Number(lockTtlMs)) ? Math.max(1000, Number(lockTtlMs)) : 60_000;
  if (!sid) return { ok: false, error: "missing_session_id" };

  const prev = await getJob({ sessionId: sid, cosmosEnabled });
  if (!prev) return { ok: false, error: "not_found" };

  const state = String(prev.job_state || "").trim();
  if (state && state !== "queued") {
    return { ok: true, claimed: false, job: prev };
  }

  const now = Date.now();
  const lockExpiresAt = Date.parse(prev.lock_expires_at || "") || 0;
  if (lockExpiresAt && lockExpiresAt > now && prev.locked_by && String(prev.locked_by) !== wid) {
    return { ok: true, claimed: false, job: prev };
  }

  const next = {
    ...clonePlain(prev),
    job_state: "running",
    started_at: prev.started_at || nowIso(),
    updated_at: nowIso(),
    locked_by: wid,
    lock_expires_at: new Date(now + ttlMs).toISOString(),
  };

  if (prev.storage === "cosmos" && isCosmosConfigured()) {
    const container = await getCosmosContainer();
    const etag = prev._etag || prev.etag || null;
    if (etag) {
      const res = await replaceCosmosDocWithEtagCandidates(container, next, etag);
      if (res.ok) {
        return { ok: true, claimed: true, job: { ...(res.resource || next), storage: "cosmos" } };
      }
      if (res.error === "etag_mismatch") return { ok: true, claimed: false, job: prev };
    }
  }

  const mem = upsertMemoryJob(next);
  return { ok: true, claimed: true, job: mem };
}

module.exports = {
  buildPrimaryJobId,
  getJob,
  upsertJob,
  patchJob,
  tryClaimJob,
  _test: {
    getMemoryJob,
    upsertMemoryJob,
    isCosmosConfigured,
  },
};
