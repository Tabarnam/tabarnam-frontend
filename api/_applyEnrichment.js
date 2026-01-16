const { getContainerPartitionKeyPath, getValueAtPath } = require("./_cosmosPartitionKey");

function nowIso() {
  return new Date().toISOString();
}

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function uniqStrings(values) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(values) ? values : []) {
    const s = asString(v).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
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

function chooseMostRecentDoc(docs) {
  const list = Array.isArray(docs) ? docs.filter((d) => d && typeof d === "object") : [];
  if (list.length <= 1) return list[0] || null;

  const score = (d) => {
    const updated = Date.parse(asString(d.updated_at)) || 0;
    const created = Date.parse(asString(d.created_at)) || 0;
    return Math.max(updated, created);
  };

  let best = list[0];
  let bestScore = score(best);
  for (const doc of list.slice(1)) {
    const s = score(doc);
    if (s > bestScore) {
      best = doc;
      bestScore = s;
    }
  }

  return best;
}

async function readCompanyByIdCrossPartition(container, companyId) {
  const id = asString(companyId).trim();
  if (!container || !id) return { ok: false, root_cause: "missing_company_id", docs: [] };

  const q = {
    query: "SELECT * FROM c WHERE c.id = @id",
    parameters: [{ name: "@id", value: id }],
  };

  try {
    const { resources } = await container.items.query(q, { enableCrossPartitionQuery: true }).fetchAll();
    const docs = Array.isArray(resources) ? resources : [];
    return { ok: true, docs };
  } catch (e) {
    return { ok: false, root_cause: "cosmos_query_failed", error: e?.message || String(e), docs: [] };
  }
}

function buildEnrichmentEvent({ stage, startedAt, endedAt, patchKeys, ok, rootCause, retryable, upstream }) {
  const event = {
    stage: asString(stage).trim() || "unknown",
    started_at: startedAt || nowIso(),
    ended_at: endedAt || nowIso(),
    ok: Boolean(ok),
    root_cause: rootCause ? asString(rootCause).trim() : null,
    retryable: typeof retryable === "boolean" ? retryable : null,
    fields_written: uniqStrings(patchKeys),
  };

  if (upstream && typeof upstream === "object") {
    // Keep this compact: store IDs/statuses, not full payloads.
    const u = {};
    if (typeof upstream.provider === "string") u.provider = upstream.provider;
    if (typeof upstream.request_id === "string") u.request_id = upstream.request_id;
    if (typeof upstream.status === "number") u.status = upstream.status;
    if (typeof upstream.summary === "string") u.summary = upstream.summary;
    if (Object.keys(u).length) event.upstream = u;
  }

  return event;
}

function sanitizePatchAgainstPartitionKey({ patch, pkPath, existingDoc }) {
  const incoming = patch && typeof patch === "object" ? { ...patch } : {};

  // Disallow PK mutations (causes write failures or, worse, duplicate ids across partitions).
  const existingPk = getValueAtPath(existingDoc, pkPath);

  const patchPk = getValueAtPath(incoming, pkPath);
  if (patchPk !== undefined && existingPk !== undefined && patchPk !== existingPk) {
    // Remove PK attempt.
    const parts = String(pkPath || "").split("/").filter(Boolean);
    if (parts.length === 1) {
      delete incoming[parts[0]];
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(incoming, "partition_key") &&
    existingDoc?.partition_key &&
    incoming.partition_key !== existingDoc.partition_key
  ) {
    delete incoming.partition_key;
  }

  return incoming;
}

/**
 * Canonical enrichment writer.
 *
 * Guarantees:
 * - reads the existing company doc by id (cross-partition)
 * - writes back into the same partition key
 * - increments enrichment_version
 * - appends enrichment_events[]
 */
async function applyEnrichment({
  container,
  company_id,
  patch,
  meta,
  expected_partition_key,
}) {
  const startedAt = nowIso();
  const companyId = asString(company_id).trim();

  const stage = asString(meta?.stage).trim() || "unknown";

  if (!container) {
    return {
      ok: false,
      company_id: companyId,
      stage,
      root_cause: "no_container",
      retryable: false,
    };
  }

  if (!companyId) {
    return {
      ok: false,
      company_id: null,
      stage,
      root_cause: "missing_company_id",
      retryable: false,
    };
  }

  const pkPath = await getCompaniesPkPath(container);

  const readRes = await readCompanyByIdCrossPartition(container, companyId);
  if (!readRes.ok) {
    return {
      ok: false,
      company_id: companyId,
      stage,
      root_cause: readRes.root_cause || "read_failed",
      retryable: true,
      error: readRes.error,
    };
  }

  const docs = readRes.docs;
  if (docs.length === 0) {
    return {
      ok: false,
      company_id: companyId,
      stage,
      root_cause: "company_not_found",
      retryable: false,
    };
  }

  const chosen = chooseMostRecentDoc(docs);
  if (!chosen) {
    return {
      ok: false,
      company_id: companyId,
      stage,
      root_cause: "company_not_found",
      retryable: false,
    };
  }

  const existingPk = getValueAtPath(chosen, pkPath) ?? chosen.partition_key;

  if (expected_partition_key && existingPk && asString(expected_partition_key).trim() !== asString(existingPk).trim()) {
    return {
      ok: false,
      company_id: companyId,
      stage,
      root_cause: "partition_key_mismatch",
      retryable: false,
      expected_partition_key: asString(expected_partition_key).trim(),
      actual_partition_key: asString(existingPk).trim(),
    };
  }

  if (existingPk === undefined || existingPk === null || asString(existingPk).trim() === "") {
    return {
      ok: false,
      company_id: companyId,
      stage,
      root_cause: "missing_partition_key",
      retryable: false,
    };
  }

  const sanitizedPatch = sanitizePatchAgainstPartitionKey({ patch, pkPath, existingDoc: chosen });
  const patchKeys = Object.keys(sanitizedPatch || {}).filter((k) => k !== "id");

  const next = {
    ...chosen,
    ...(sanitizedPatch && typeof sanitizedPatch === "object" ? sanitizedPatch : {}),
    id: companyId,
  };

  const prevVersion = Number.isFinite(Number(next.enrichment_version)) ? Number(next.enrichment_version) : 0;
  next.enrichment_version = prevVersion + 1;
  next.enrichment_updated_at = nowIso();

  const endedAt = nowIso();

  const prevEvents = Array.isArray(next.enrichment_events) ? next.enrichment_events.filter((e) => e && typeof e === "object") : [];
  const event = buildEnrichmentEvent({
    stage,
    startedAt,
    endedAt,
    patchKeys,
    ok: true,
    rootCause: null,
    retryable: false,
    upstream: meta?.upstream,
  });

  next.enrichment_events = [...prevEvents, event].slice(-200);

  try {
    await container.item(companyId, existingPk).replace(next);
    return {
      ok: true,
      company_id: companyId,
      stage,
      partition_key: existingPk,
      enrichment_version: next.enrichment_version,
      fields_written: uniqStrings(patchKeys),
      duplicate_company_id_partitions: docs.length > 1 ? docs.map((d) => getValueAtPath(d, pkPath) ?? d.partition_key).filter((v) => v != null) : [],
    };
  } catch (e) {
    const endedAtFail = nowIso();
    const failEvent = buildEnrichmentEvent({
      stage,
      startedAt,
      endedAt: endedAtFail,
      patchKeys,
      ok: false,
      rootCause: "cosmos_write_failed",
      retryable: true,
      upstream: meta?.upstream,
    });

    try {
      const prev = Array.isArray(chosen.enrichment_events) ? chosen.enrichment_events.filter((it) => it && typeof it === "object") : [];
      const failDoc = {
        ...chosen,
        id: companyId,
        enrichment_version: (Number.isFinite(Number(chosen.enrichment_version)) ? Number(chosen.enrichment_version) : 0) + 1,
        enrichment_updated_at: endedAtFail,
        enrichment_events: [...prev, failEvent].slice(-200),
      };
      await container.item(companyId, existingPk).replace(failDoc);
    } catch {
      // swallow secondary failure
    }

    return {
      ok: false,
      company_id: companyId,
      stage,
      partition_key: existingPk,
      root_cause: "cosmos_write_failed",
      retryable: true,
      error: e?.message || String(e),
    };
  }
}

module.exports = {
  applyEnrichment,
};
