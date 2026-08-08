// api/_secondLookWorker.js
//
// Queue worker for the second-look lane. One message = one company = one
// xAI call (single attempt, no cycles — see _secondLookEnrichment.js for
// the design rationale).
//
// Concurrency model: this lane holds its own single-shard Cosmos lock
// (`_second_look_lock`) so at most ONE second-look xAI call is in flight,
// fully independent of the canonical lane's `_xai_call_lock` shards. Net
// effect: company N's second look overlaps company N+1's canonical call —
// batch TRT ≈ max(Σ canonical, Σ second-look) instead of the sum.
//
// Canonical-lane priority: before running we check the Phase 3.10
// concurrency circuit breaker; if it's tripped (xAI under stress), the
// second look re-queues with a delay instead of adding load.

"use strict";

const { runSecondLookCall, unionKeywordStrings, unionLocationArrays } = require("./_secondLookEnrichment");
const { applyEnrichmentToCompany } = require("./_directEnrichment");
const { computeProfileCompleteness } = require("./_profileCompleteness");
const { computeMissingFields } = require("./_requiredFields");
const { enqueueSecondLook } = require("./_enrichmentQueue");
const { getCosmosClient } = require("./_cosmosConfig");

const HANDLER_ID = "second-look-worker";

const SECOND_LOOK_LOCK_ID = "_second_look_lock";
const SECOND_LOOK_LOCK_PK = "_xai_call_lock"; // same PK namespace as the canonical lock docs
const SECOND_LOOK_LOCK_TTL_MS = 30_000;
const SECOND_LOOK_LOCK_REFRESH_MS = 10_000;

// Matches the canonical circuit-breaker doc written by resume-worker/handler.js.
const XAI_CIRCUIT_BREAKER_DOC_ID = "_xai_concurrency_circuit_breaker";
const XAI_CIRCUIT_BREAKER_PK = "import";

// Re-queue delays.
const REQUEUE_LOCK_BUSY_MS = 30_000;
const REQUEUE_BREAKER_MS = 120_000;

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function nowIso() {
  return new Date().toISOString();
}

function getCompaniesContainer() {
  const database = asString(process.env.COSMOS_DB_DATABASE || process.env.COSMOS_DB || "tabarnam-db").trim();
  const containerName = asString(process.env.COSMOS_DB_COMPANIES_CONTAINER || process.env.COSMOS_CONTAINER || "companies").trim();
  try {
    const client = getCosmosClient();
    if (!client) return null;
    return client.database(database).container(containerName);
  } catch {
    return null;
  }
}

async function isCircuitBreakerTripped(container) {
  try {
    const { resource } = await container.item(XAI_CIRCUIT_BREAKER_DOC_ID, XAI_CIRCUIT_BREAKER_PK).read();
    if (!resource) return false;
    const expiresAtMs = Date.parse(String(resource.expires_at || "")) || 0;
    return expiresAtMs > 0 && Date.now() < expiresAtMs;
  } catch {
    return false;
  }
}

async function acquireSecondLookLock(container, companyId) {
  const leaseId = globalThis.crypto?.randomUUID?.() || `sl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lockDoc = {
    id: SECOND_LOOK_LOCK_ID,
    normalized_domain: SECOND_LOOK_LOCK_PK,
    leaseId,
    companyId,
    acquiredAt: nowIso(),
    expiresAt: new Date(Date.now() + SECOND_LOOK_LOCK_TTL_MS).toISOString(),
  };
  try {
    await container.items.create(lockDoc);
    return { acquired: true, leaseId };
  } catch (e) {
    if (e?.code !== 409) return { acquired: false, reason: "create_error", error: String(e?.message || e) };
    // Held — stale takeover if expired.
    try {
      const { resource: existing } = await container.item(SECOND_LOOK_LOCK_ID, SECOND_LOOK_LOCK_PK).read();
      if (existing && new Date(existing.expiresAt).getTime() < Date.now()) {
        try { await container.item(SECOND_LOOK_LOCK_ID, SECOND_LOOK_LOCK_PK).delete(); } catch {}
        try {
          await container.items.create(lockDoc);
          return { acquired: true, leaseId, stale_takeover: true };
        } catch {
          return { acquired: false, reason: "held" };
        }
      }
    } catch {}
    return { acquired: false, reason: "held" };
  }
}

async function refreshSecondLookLock(container, leaseId) {
  try {
    const { resource: existing } = await container.item(SECOND_LOOK_LOCK_ID, SECOND_LOOK_LOCK_PK).read();
    if (!existing || String(existing.leaseId) !== String(leaseId)) return false;
    existing.expiresAt = new Date(Date.now() + SECOND_LOOK_LOCK_TTL_MS).toISOString();
    await container.items.upsert(existing);
    return true;
  } catch {
    return false;
  }
}

async function releaseSecondLookLock(container, leaseId) {
  try {
    const { resource: existing } = await container.item(SECOND_LOOK_LOCK_ID, SECOND_LOOK_LOCK_PK).read();
    if (existing && String(existing.leaseId) === String(leaseId)) {
      await container.item(SECOND_LOOK_LOCK_ID, SECOND_LOOK_LOCK_PK).delete();
    }
  } catch {}
}

async function readCompanyDoc(container, companyId, normalizedDomain) {
  try {
    const { resource } = await container.item(companyId, normalizedDomain).read();
    return resource || null;
  } catch {
    return null;
  }
}

/**
 * Process one second-look queue message.
 * Message: { company_id, normalized_domain, session_id?, fields, merge_fields }
 */
async function processSecondLook(queueMessage, context) {
  const startedAt = Date.now();
  const companyId = asString(queueMessage?.company_id).trim();
  const normalizedDomain = asString(queueMessage?.normalized_domain).trim();
  const sessionId = asString(queueMessage?.session_id).trim() || null;
  const fields = Array.isArray(queueMessage?.fields) ? queueMessage.fields.filter(Boolean) : [];
  const mergeFields = Array.isArray(queueMessage?.merge_fields) ? queueMessage.merge_fields.filter(Boolean) : [];

  console.log(`[${HANDLER_ID}] processing_started`, {
    company_id: companyId,
    normalized_domain: normalizedDomain,
    session_id: sessionId,
    fields,
    merge_fields: mergeFields,
    invocation_id: context?.invocationId || null,
  });

  if (!companyId || !normalizedDomain) {
    return { ok: false, error: "missing_company_identity" };
  }

  const container = getCompaniesContainer();
  if (!container) return { ok: false, error: "cosmos_not_configured" };

  // Idempotency — the doc is the source of truth, not the message.
  let doc = await readCompanyDoc(container, companyId, normalizedDomain);
  if (!doc) return { ok: false, error: "company_not_found", company_id: companyId };
  if (doc.second_look_done) {
    console.log(`[${HANDLER_ID}] skip_already_done`, { company_id: companyId });
    return { ok: true, skipped: "already_done", company_id: companyId };
  }

  // Canonical-lane priority: back off while the breaker is tripped.
  if (await isCircuitBreakerTripped(container)) {
    console.warn(`[${HANDLER_ID}] circuit_breaker_tripped_requeueing`, { company_id: companyId });
    await enqueueSecondLook({
      company_id: companyId,
      normalized_domain: normalizedDomain,
      session_id: sessionId,
      fields,
      merge_fields: mergeFields,
      requested_by: "second_look_worker_requeue",
      run_after_ms: REQUEUE_BREAKER_MS,
    }).catch(() => null);
    return { ok: true, requeued: "circuit_breaker", company_id: companyId };
  }

  // Lane lock — at most one second-look xAI call in flight.
  const lock = await acquireSecondLookLock(container, companyId);
  if (!lock.acquired) {
    console.log(`[${HANDLER_ID}] lock_busy_requeueing`, { company_id: companyId, reason: lock.reason });
    await enqueueSecondLook({
      company_id: companyId,
      normalized_domain: normalizedDomain,
      session_id: sessionId,
      fields,
      merge_fields: mergeFields,
      requested_by: "second_look_worker_requeue",
      run_after_ms: REQUEUE_LOCK_BUSY_MS,
    }).catch(() => null);
    return { ok: true, requeued: "lock_busy", company_id: companyId };
  }

  const lockRefreshTimer = setInterval(() => {
    refreshSecondLookLock(container, lock.leaseId).catch(() => null);
  }, SECOND_LOOK_LOCK_REFRESH_MS);

  let result;
  try {
    result = await runSecondLookCall({
      company: doc,
      fields,
      mode: "import",
    });
  } catch (e) {
    result = {
      ok: false,
      fields_completed: [],
      fields_failed: fields,
      errors: {},
      enriched: {},
      flat: {},
      elapsed_ms: Date.now() - startedAt,
      diagnostics: { second_look: true, error_code: "worker_threw", error: String(e?.message || e) },
    };
  } finally {
    clearInterval(lockRefreshTimer);
    await releaseSecondLookLock(container, lock.leaseId);
  }

  // Re-read the doc fresh before writing — the Microlink backfill workers
  // (auto-triggered at session completion) patch homepage/logo fields on
  // the same doc while our xAI call runs; writing our stale copy would
  // clobber them.
  const freshDoc = await readCompanyDoc(container, companyId, normalizedDomain);
  doc = freshDoc || doc;

  if (doc.second_look_done) {
    // A concurrent worker (duplicate delivery) beat us — don't double-apply.
    console.log(`[${HANDLER_ID}] skip_race_already_done`, { company_id: companyId });
    return { ok: true, skipped: "race_already_done", company_id: companyId };
  }

  const fieldsRecovered = [];

  if (result.ok && result.enriched && Object.keys(result.enriched).length > 0) {
    const enriched = { ...result.enriched };

    // Fill-only vs union-merge semantics.
    // - Trigger fields were empty at enqueue time; if the canonical lane or
    //   an admin filled one meanwhile, drop our value (fill-only).
    // - Merge fields union with whatever the doc has now.
    for (const f of Object.keys(enriched)) {
      const isMerge = mergeFields.includes(f);
      if (f === "product_keywords") {
        const incoming = enriched[f]?.product_keywords || "";
        if (!incoming) { delete enriched[f]; continue; }
        const merged = unionKeywordStrings(asString(doc.product_keywords), incoming);
        enriched[f] = { ...enriched[f], product_keywords: merged };
      } else if (f === "manufacturing_locations") {
        const incoming = enriched[f]?.manufacturing_locations || [];
        if (!incoming.length) { delete enriched[f]; continue; }
        const existingStrings = unionLocationArrays(doc.manufacturing_locations, []);
        const hasExistingReal = existingStrings.length > 0;
        if (hasExistingReal && !isMerge) { delete enriched[f]; continue; }
        enriched[f] = {
          ...enriched[f],
          manufacturing_locations: unionLocationArrays(doc.manufacturing_locations, incoming),
        };
      } else if (f === "tagline") {
        if (!enriched[f]?.tagline) { delete enriched[f]; continue; }
        if (doc.tagline) { delete enriched[f]; continue; }
      } else if (f === "headquarters_location") {
        if (!enriched[f]?.headquarters_location) { delete enriched[f]; continue; }
        if (doc.headquarters_location) { delete enriched[f]; continue; }
      } else if (f === "industries") {
        const incoming = enriched[f]?.industries || [];
        if (!incoming.length) { delete enriched[f]; continue; }
        if (Array.isArray(doc.industries) && doc.industries.length > 0) { delete enriched[f]; continue; }
      } else if (f === "reviews") {
        const incoming = enriched[f]?.reviews || [];
        if (!incoming.length) { delete enriched[f]; continue; }
        if (Array.isArray(doc.curated_reviews) && doc.curated_reviews.length > 0) { delete enriched[f]; continue; }
      }
    }

    if (Object.keys(enriched).length > 0) {
      try {
        doc = await applyEnrichmentToCompany(doc, { ...result, enriched });
        fieldsRecovered.push(...Object.keys(enriched));
      } catch (applyErr) {
        console.error(`[${HANDLER_ID}] apply_error`, {
          company_id: companyId,
          error: String(applyErr?.message || applyErr),
        });
      }
    }
  }

  // Second-look bookkeeping — single attempt, done forever.
  doc.second_look_done = true;
  doc.second_look_pending = false;
  doc.second_look = {
    ran_at: nowIso(),
    session_id: sessionId,
    fields_requested: fields,
    merge_fields: mergeFields,
    fields_recovered: fieldsRecovered,
    fields_still_missing: (result.fields_failed || []).filter((f) => !fieldsRecovered.includes(f)),
    elapsed_ms: result.elapsed_ms,
    diagnostics: result.diagnostics || null,
  };

  // The second look is the designated last-resort pass (single attempt by
  // design). A field it conclusively failed gets a terminal missing-reason so
  // the import-status resume orchestration stops re-searching it in the same
  // session — otherwise canonical retries burn identical web searches on a
  // field two passes already failed (observed: Stryde mfg, 2026-08-08).
  // Admin refresh flows force re-enrichment regardless of missing-reasons,
  // so this does not block deliberate re-fetches later.
  const { isTerminalMissingReason } = require("./_requiredFields");
  for (const f of doc.second_look.fields_still_missing) {
    doc.import_missing_reason ||= {};
    const existing = String(doc.import_missing_reason[f] || "").trim();
    if (!isTerminalMissingReason(existing)) {
      doc.import_missing_reason[f] = "second_look_exhausted";
    }
  }

  doc.import_missing_fields = computeMissingFields(doc);
  const completeness = computeProfileCompleteness(doc);
  doc.profile_completeness = completeness.profile_completeness;
  doc.profile_completeness_version = completeness.profile_completeness_version;
  doc.profile_completeness_meta = completeness.profile_completeness_meta;
  doc.updated_at = nowIso();

  try {
    await container.items.upsert(doc, { partitionKey: normalizedDomain });
  } catch (e) {
    console.error(`[${HANDLER_ID}] doc_upsert_failed`, {
      company_id: companyId,
      error: String(e?.message || e),
    });
    return { ok: false, error: "doc_upsert_failed", company_id: companyId };
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`[${HANDLER_ID}] processing_complete`, {
    company_id: companyId,
    session_id: sessionId,
    fields_requested: fields,
    fields_recovered: fieldsRecovered,
    call_ok: result.ok,
    elapsed_ms: elapsedMs,
  });

  return {
    ok: true,
    company_id: companyId,
    fields_requested: fields,
    fields_recovered: fieldsRecovered,
    elapsed_ms: elapsedMs,
  };
}

module.exports = {
  processSecondLook,
  // Exported for tests.
  _test: {
    acquireSecondLookLock,
    releaseSecondLookLock,
    isCircuitBreakerTripped,
  },
};
