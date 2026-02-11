let CosmosClient;
try {
  ({ CosmosClient } = require("@azure/cosmos"));
} catch {
  CosmosClient = null;
}
const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
  getValueAtPath,
} = require("../_cosmosPartitionKey");
const { patchCompanyWithSearchText } = require("../_computeSearchText");
const { getCosmosConfig } = require("../_cosmosConfig");

let cosmosCompaniesClient = null;
let companiesPkPathPromise;
let companiesCosmosTargetPromise;

function getCompaniesCosmosContainer() {
  try {
    const { endpoint, key, databaseId, containerId } = getCosmosConfig();

    if (!endpoint || !key) return null;
    if (!CosmosClient) return null;

    cosmosCompaniesClient ||= new CosmosClient({ endpoint, key });
    return cosmosCompaniesClient.database(databaseId).container(containerId);
  } catch {
    return null;
  }
}

async function getCompaniesPartitionKeyPath(companiesContainer) {
  if (!companiesContainer) return "/normalized_domain";
  companiesPkPathPromise ||= getContainerPartitionKeyPath(companiesContainer, "/normalized_domain");
  try {
    return await companiesPkPathPromise;
  } catch {
    return "/normalized_domain";
  }
}

function redactHostForDiagnostics(value) {
  const host = typeof value === "string" ? value.trim() : "";
  if (!host) return "";
  if (host.length <= 12) return host;
  return `${host.slice(0, 8)}\u2026${host.slice(-8)}`;
}

async function getCompaniesCosmosTargetDiagnostics() {
  companiesCosmosTargetPromise ||= (async () => {
    const { endpoint, databaseId, containerId } = getCosmosConfig();

    let host = "";
    try {
      host = endpoint ? new URL(endpoint).host : "";
    } catch {
      host = "";
    }

    const container = getCompaniesCosmosContainer();
    const pkPath = await getCompaniesPartitionKeyPath(container);

    return {
      cosmos_account_host_redacted: redactHostForDiagnostics(host),
      cosmos_db_name: databaseId,
      cosmos_container_name: containerId,
      cosmos_container_partition_key_path: pkPath,
    };
  })();

  try {
    return await companiesCosmosTargetPromise;
  } catch {
    return {
      cosmos_account_host_redacted: "",
      cosmos_db_name: getCosmosConfig().databaseId,
      cosmos_container_name: getCosmosConfig().containerId,
      cosmos_container_partition_key_path: "/normalized_domain",
    };
  }
}

async function verifySavedCompaniesReadAfterWrite(saveResult) {
  const result = saveResult && typeof saveResult === "object" ? saveResult : {};

  const savedIds = Array.isArray(result.saved_ids)
    ? result.saved_ids.map((id) => String(id || "").trim()).filter(Boolean)
    : [];

  const persisted = Array.isArray(result.persisted_items) ? result.persisted_items : [];
  const domainById = new Map();
  for (const item of persisted) {
    const id = String(item?.id || "").trim();
    if (!id) continue;
    const normalizedDomain = String(item?.normalized_domain || "").trim();
    if (normalizedDomain) domainById.set(id, normalizedDomain);
  }

  const container = getCompaniesCosmosContainer();
  if (!container) {
    return {
      verified_ids: [],
      unverified_ids: savedIds,
      verified_persisted_items: [],
    };
  }

  const BATCH_SIZE = 4;
  const verified = [];
  const unverified = [];

  for (let i = 0; i < savedIds.length; i += BATCH_SIZE) {
    const batch = savedIds.slice(i, i + BATCH_SIZE);
    const reads = await Promise.all(
      batch.map(async (companyId) => {
        const normalizedDomain = domainById.get(companyId) || "unknown";
        const doc = await readItemWithPkCandidates(container, companyId, {
          id: companyId,
          normalized_domain: normalizedDomain,
          partition_key: normalizedDomain,
        }).catch(() => null);

        const companyName = String(doc?.company_name || doc?.name || "").trim();
        const websiteUrlRaw = String(doc?.website_url || doc?.url || doc?.canonical_url || "").trim();

        const hasWorkingWebsite = (() => {
          if (!websiteUrlRaw) return false;
          const lowered = websiteUrlRaw.toLowerCase();
          if (lowered === "unknown" || lowered === "n/a" || lowered === "na") return false;
          try {
            const u = websiteUrlRaw.includes("://") ? new URL(websiteUrlRaw) : new URL(`https://${websiteUrlRaw}`);
            const host = String(u.hostname || "").toLowerCase();
            return Boolean(host && host.includes("."));
          } catch {
            return false;
          }
        })();

        const complete = Boolean(doc) && Boolean(companyName) && hasWorkingWebsite;

        return { companyId, ok: Boolean(doc), complete };
      })
    );

    for (const r of reads) {
      if (r.complete) verified.push(r.companyId);
      else unverified.push(r.companyId);
    }
  }

  const verifiedSet = new Set(verified);
  const verifiedPersistedItems = persisted.filter((it) => verifiedSet.has(String(it?.id || "").trim()));

  return {
    verified_ids: verified,
    unverified_ids: unverified,
    verified_persisted_items: verifiedPersistedItems,
  };
}

function applyReadAfterWriteVerification(saveResult, verification) {
  const result = saveResult && typeof saveResult === "object" ? { ...saveResult } : {};

  const writeCount = Number(result.saved || 0) || 0;
  const writeIds = Array.isArray(result.saved_ids) ? result.saved_ids : [];

  const verifiedIds = Array.isArray(verification?.verified_ids)
    ? verification.verified_ids.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const unverifiedIds = Array.isArray(verification?.unverified_ids)
    ? verification.unverified_ids.map((id) => String(id || "").trim()).filter(Boolean)
    : [];

  const verifiedCount = verifiedIds.length;

  return {
    ...result,
    saved_write_count: writeCount,
    saved_ids_write: writeIds,
    saved_company_ids_verified: verifiedIds,
    saved_company_ids_unverified: unverifiedIds,
    saved_verified_count: verifiedCount,
    saved: verifiedCount,
    saved_ids: verifiedIds,
    persisted_items: Array.isArray(verification?.verified_persisted_items) ? verification.verified_persisted_items : result.persisted_items,
  };
}

async function readItemWithPkCandidates(container, id, docForCandidates) {
  if (!container || !id) return null;
  const containerPkPath = await getCompaniesPartitionKeyPath(container);

  const candidates = buildPartitionKeyCandidates({
    doc: docForCandidates,
    containerPkPath,
    requestedId: id,
  });

  let lastErr = null;
  for (const partitionKeyValue of candidates) {
    try {
      const item =
        partitionKeyValue !== undefined
          ? container.item(id, partitionKeyValue)
          : container.item(id);
      const { resource } = await item.read();
      return resource || null;
    } catch (e) {
      lastErr = e;
      if (e?.code === 404) return null;
    }
  }

  if (lastErr && lastErr.code !== 404) {
    console.warn(`[import-start] readItem failed id=${id} pkPath=${containerPkPath}: ${lastErr.message}`);
  }
  return null;
}

async function upsertItemWithPkCandidates(container, doc) {
  if (!container || !doc) return { ok: false, error: "no_container" };
  const id = String(doc.id || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  // Patch company documents with computed search text fields
  if (doc && doc.company_name) {
    patchCompanyWithSearchText(doc);
  }

  const containerPkPath = await getCompaniesPartitionKeyPath(container);
  const pkValue = getValueAtPath(doc, containerPkPath);
  const candidates = buildPartitionKeyCandidates({ doc, containerPkPath, requestedId: id });

  let lastErr = null;
  for (const partitionKeyValue of candidates) {
    // Retry transient Cosmos failures (429 throttle, 503 service unavailable, ETIMEDOUT)
    for (let attempt = 0; attempt < 3; attempt++) {
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
        const code = Number(e?.code || e?.statusCode || 0);
        const isTransient = code === 429 || code === 503 || code === 408 ||
          /ETIMEDOUT|ECONNRESET|socket hang up/i.test(String(e?.message || ""));
        if (isTransient && attempt < 2) {
          const delayMs = code === 429 ? Math.min(2000 * (attempt + 1), 5000) : 1000 * (attempt + 1);
          console.warn(`[import-start] upsert transient error (attempt ${attempt + 1}/3, code=${code}), retrying in ${delayMs}ms: ${e?.message || String(e)}`);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        console.warn(`[import-start] upsert failed id=${id} pk=${partitionKeyValue} code=${code}: ${e?.message || String(e)}`);
        break; // Non-transient error, try next PK candidate
      }
    }
  }

  return { ok: false, error: lastErr?.message || "upsert_failed", cosmos_error_code: Number(lastErr?.code || lastErr?.statusCode || 0) || null };
}

function buildImportControlDocBase(sessionId) {
  return {
    session_id: sessionId,
    normalized_domain: "import",
    partition_key: "import",
    type: "import_control",
    updated_at: new Date().toISOString(),
  };
}

async function upsertResumeDoc({
  session_id,
  status,
  cycle_count,
  missing_by_company,
  created_at,
  updated_at,
  resume_error,
  blocked_at,
  lock_expires_at,
  enrichment_queued_at,
  next_allowed_run_at,
  last_backoff_reason,
  last_backoff_ms,
}) {
  const sid = String(session_id || "").trim();
  if (!sid) return { ok: false, error: "missing_session_id" };

  const container = getCompaniesCosmosContainer();
  if (!container) return { ok: false, error: "no_container" };

  const id = `_import_resume_${sid}`;
  const nowIso = new Date().toISOString();

  // Preserve previously-written state (progress, errors, etc.).
  const existing = await readItemWithPkCandidates(container, id, {
    id,
    ...buildImportControlDocBase(sid),
    created_at: "",
  }).catch(() => null);

  const resumeDoc = {
    ...(existing && typeof existing === "object" ? existing : {}),
    id,
    ...buildImportControlDocBase(sid),
    status: typeof status === "string" && status.trim() ? status.trim() : "queued",
    cycle_count: Number.isFinite(Number(cycle_count)) ? Number(cycle_count) : Number(existing?.cycle_count || 0) || 0,
    missing_by_company: Array.isArray(missing_by_company) ? missing_by_company : Array.isArray(existing?.missing_by_company) ? existing.missing_by_company : [],
    created_at: typeof created_at === "string" && created_at.trim() ? created_at : String(existing?.created_at || nowIso),
    updated_at: typeof updated_at === "string" && updated_at.trim() ? updated_at : nowIso,
    resume_error: resume_error === undefined ? (existing?.resume_error ?? null) : resume_error,
    blocked_at: blocked_at === undefined ? (existing?.blocked_at ?? null) : blocked_at,
    lock_expires_at: lock_expires_at === undefined ? (existing?.lock_expires_at ?? null) : lock_expires_at,
    enrichment_queued_at:
      enrichment_queued_at === undefined
        ? (existing?.enrichment_queued_at ?? null)
        : enrichment_queued_at,
    next_allowed_run_at:
      next_allowed_run_at === undefined
        ? (existing?.next_allowed_run_at ?? null)
        : next_allowed_run_at,
    last_backoff_reason:
      last_backoff_reason === undefined
        ? (existing?.last_backoff_reason ?? null)
        : last_backoff_reason,
    last_backoff_ms:
      last_backoff_ms === undefined
        ? (existing?.last_backoff_ms ?? null)
        : last_backoff_ms,
  };

  const upserted = await upsertItemWithPkCandidates(container, resumeDoc).catch((e) => ({ ok: false, error: e?.message || String(e) }));
  return upserted;
}

function logInfo(context, payload) {
  try {
    const logger = context?.log;
    const fn = logger?.info || logger;
    if (typeof fn === "function") return fn(payload);
  } catch {}
  try {
    console.log(payload);
  } catch {}
}

async function upsertCosmosImportSessionDoc({ sessionId, requestId, patch }) {
  const fnTag = `[import-start][session-doc]`;
  const sid = String(sessionId || "").trim();
  if (!sid) {
    console.warn(`${fnTag} SKIP: missing sessionId`);
    return { ok: false, error: "missing_session_id" };
  }

  const container = getCompaniesCosmosContainer();
  if (!container) {
    console.warn(`${fnTag} session=${sid} SKIP: no Cosmos container`);
    return { ok: false, error: "no_container" };
  }

  const id = `_import_session_${sid}`;
  const patchKeys = patch && typeof patch === "object" ? Object.keys(patch).join(",") : "none";

  try {
    const existing = await readItemWithPkCandidates(container, id, {
      id,
      ...buildImportControlDocBase(sid),
      created_at: "",
    });

    console.log(`${fnTag} session=${sid} existing=${existing ? "found" : "null"} existing_pk=${existing?.normalized_domain || "?"} existing_beacon=${existing?.stage_beacon || "?"} patch_keys=${patchKeys}`);

    const createdAt = existing?.created_at || new Date().toISOString();
    const existingRequest = existing?.request && typeof existing.request === "object" ? existing.request : null;

    // IMPORTANT: This doc is upserted many times during a session (progress, resume errors, etc).
    // Never drop previously-written fields (e.g. saved ids), otherwise /import/status loses its
    // source of truth and the UI appears "stalled" even though we wrote earlier.
    const sessionDoc = {
      ...(existing && typeof existing === "object" ? existing : {}),
      id,
      ...buildImportControlDocBase(sid),
      created_at: createdAt,
      request_id: requestId,
      ...(existingRequest ? { request: existingRequest } : {}),
      ...(patch && typeof patch === "object" ? patch : {}),
    };

    // Primary: use PK-candidates upsert
    const result = await upsertItemWithPkCandidates(container, sessionDoc);
    if (result.ok) {
      console.log(`${fnTag} session=${sid} upsert OK (pk=${sessionDoc.normalized_domain || "?"} beacon=${sessionDoc.stage_beacon || "?"})`);
      return result;
    }

    // Fallback: direct upsert with explicit PK="import"
    console.warn(`${fnTag} session=${sid} pk-candidates upsert FAILED (${result.error}), trying direct upsert`);
    try {
      await container.items.upsert(sessionDoc, { partitionKey: "import" });
      console.log(`${fnTag} session=${sid} direct upsert OK`);
      return { ok: true, fallback: true };
    } catch (directErr) {
      console.error(`${fnTag} session=${sid} direct upsert ALSO FAILED: ${directErr?.message || directErr}`);
      return { ok: false, error: directErr?.message || "direct_upsert_failed" };
    }
  } catch (e) {
    console.error(`${fnTag} session=${sid} EXCEPTION: ${e?.message || String(e)}`);
    return { ok: false, error: e?.message || String(e || "session_upsert_failed") };
  }
}

// Check if a session has been stopped
async function checkIfSessionStopped(sessionId) {
  try {
    const container = getCompaniesCosmosContainer();
    if (!container) return false;

    const stopDocId = `_import_stop_${sessionId}`;
    const resource = await readItemWithPkCandidates(container, stopDocId, {
      id: stopDocId,
      ...buildImportControlDocBase(sessionId),
      stopped_at: "",
    });
    return !!resource;
  } catch (e) {
    console.warn(`[import-start] Error checking stop status: ${e?.message || String(e)}`);
    return false;
  }
}

module.exports = {
  getCompaniesCosmosContainer,
  getCompaniesPartitionKeyPath,
  redactHostForDiagnostics,
  getCompaniesCosmosTargetDiagnostics,
  verifySavedCompaniesReadAfterWrite,
  applyReadAfterWriteVerification,
  readItemWithPkCandidates,
  upsertItemWithPkCandidates,
  buildImportControlDocBase,
  upsertResumeDoc,
  logInfo,
  upsertCosmosImportSessionDoc,
  checkIfSessionStopped,
};
