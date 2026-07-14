// api/_importControlCleanup.js
//
// Shared engine that purges stale IMPORT-CONTROL documents from the companies
// container. These are the import state-machine's scratch docs — ids
// `_import_<kind>_<sid>` and/or types import_control/import_stop/
// import_primary_job/import_session — which accumulate forever because nothing
// deletes them after an import finishes. No product/admin surface reads them
// (search-companies, admin-companies-v2 and the backfills all filter them out).
//
// SAFETY: control docs are still read/re-upserted by the import UI for up to
// ~10 min after completion (import-progress / import-status /
// _importStatusCosmos). So we NEVER delete inline at completion — we age-gate
// on Cosmos `_ts` (server last-write time). Because `_ts` resets on every
// re-upsert, a doc the UI is still touching is younger than the grace window
// and can't be selected. Default grace is 24h; an absolute floor is enforced
// by callers.
//
// HOT PARTITION: every control doc lives in ONE logical partition
// (normalized_domain:"import"), so a bulk delete throttles hard (429s). The live
// path therefore (a) queries a small TOP-N batch and deletes it, looping under a
// strict wall-clock budget so each HTTP call returns well before any gateway
// timeout, (b) re-queries from the top each batch (no continuation token over a
// mutating set), (c) stops if a batch makes zero progress. Callers loop until
// `done`.
//
// Both the manual endpoint (xadmin-api-cleanup-import-control) and the weekly
// timer (cleanup-import-control-timer) call runImportControlCleanup so scheduled
// and manual runs use identical logic.

const { getCompaniesContainer } = require("./_reviewCounts");
const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
} = require("./_cosmosPartitionKey");

const CONCURRENCY = 3; // modest: one hot partition throttles above this
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 1000;
// Keep each HTTP invocation short so the SWA/gateway (~230s) never kills it
// mid-delete; the client loops until done.
const DEFAULT_TIME_BUDGET_MS = 60 * 1000;
const HARD_MAX_TIME_BUDGET_MS = 150 * 1000;
const DELETE_MAX_RETRIES = 4;

// Control-doc kinds that carry a `type` field. Ids all start `_import_`, but the
// primary-job/session/stop docs also identify by type, so we match on either.
const CONTROL_TYPES = ["import_control", "import_stop", "import_primary_job", "import_session"];

function isRateLimited(err) {
  const code = err?.code ?? err?.statusCode ?? err?.status;
  return Number(code) === 429;
}

function isNotFound(err) {
  const code = err?.code ?? err?.statusCode ?? err?.status;
  return Number(code) === 404;
}

function retryAfterMs(err, attempt) {
  const hinted = Number(err?.retryAfterInMs ?? err?.retryAfterInMilliseconds);
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted, 5000);
  return Math.min(200 * 2 ** attempt, 3000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Select stale import-control docs older than `olderThanSeconds` (compared
 * against Cosmos `_ts`, epoch seconds). Never selects soft-deleted docs, real
 * companies, or refresh-job docs. Projects partition_key/normalized_domain so
 * the PK-candidate fallback resolves for every id kind. Optional `topN` caps the
 * result set for the live batch loop.
 */
function buildControlCleanupQuery({ olderThanSeconds, topN }) {
  const cutoff = Math.floor(Number(olderThanSeconds));
  const typeList = CONTROL_TYPES.map((_, i) => `@type${i}`).join(", ");
  const parameters = [
    { name: "@cutoff", value: cutoff },
    ...CONTROL_TYPES.map((t, i) => ({ name: `@type${i}`, value: t })),
  ];

  const top = Number.isFinite(Number(topN)) && Number(topN) > 0 ? `TOP ${Math.floor(Number(topN))} ` : "";

  const query = [
    `SELECT ${top}c.id, c.normalized_domain, c.partition_key, c.type, c._ts`,
    "FROM c",
    "WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)",
    `  AND (STARTSWITH(c.id, '_import_') OR (IS_DEFINED(c.type) AND c.type IN (${typeList})))`,
    "  AND c._ts <= @cutoff",
  ].join("\n");

  return { query, parameters };
}

/**
 * Delete a doc by trying each partition-key candidate; retry transient 429s.
 * Returns { ok, partitionKeyValue } or { ok:false, error }. A 404 counts as ok
 * (already gone). Never throws.
 */
async function deleteDocWithPkCandidates({ container, containerPkPath, doc, context }) {
  const candidates = buildPartitionKeyCandidates({ doc, containerPkPath, requestedId: doc?.id });
  let lastError = null;

  for (const partitionKeyValue of candidates) {
    for (let attempt = 0; attempt < DELETE_MAX_RETRIES; attempt++) {
      try {
        await container.item(doc.id, partitionKeyValue).delete();
        return { ok: true, partitionKeyValue };
      } catch (e) {
        if (isRateLimited(e)) {
          await sleep(retryAfterMs(e, attempt));
          continue; // retry same partition-key candidate
        }
        if (isNotFound(e)) {
          return { ok: true, partitionKeyValue, alreadyGone: true };
        }
        lastError = e?.message || String(e);
        break; // not a 429/404 — try the next candidate
      }
    }
  }

  return { ok: false, error: lastError || "all_partition_key_candidates_failed", candidateCount: candidates.length };
}

/**
 * Purge stale control docs. Never throws — returns a structured result.
 *
 * dryRun: counts matches via continuation paging (read-only).
 * live:   query-TOP-N-and-delete loop under a wall-clock budget; re-queries from
 *         the top each batch (deletes shrink the set), stops on zero progress.
 *
 * @returns {Promise<{ ok, processed, deleted, failures, sample_errors,
 *   matched_so_far, done, dry_run, older_than_hours, cutoff_epoch, elapsed_ms,
 *   throttled_batches }>}
 */
async function runImportControlCleanup({
  container,
  olderThanHours = 24,
  dryRun = true,
  pageSize = DEFAULT_PAGE_SIZE,
  maxPages = Infinity,
  timeBudgetMs = DEFAULT_TIME_BUDGET_MS,
  continuation,
  context,
} = {}) {
  const cont = container || getCompaniesContainer();
  if (!cont) return { ok: false, error: "Cosmos not configured" };

  const startedAt = Date.now();
  const hours = Math.max(0, Number(olderThanHours) || 0);
  const cutoffEpoch = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE));
  const budget = Math.min(HARD_MAX_TIME_BUDGET_MS, Math.max(5000, Number(timeBudgetMs) || DEFAULT_TIME_BUDGET_MS));
  const timeLeft = () => budget - (Date.now() - startedAt);

  const containerPkPath = await getContainerPartitionKeyPath(cont, "/normalized_domain").catch(
    () => "/normalized_domain",
  );

  // ── Dry run: count via continuation paging (read-only, no hot-partition risk) ──
  if (dryRun) {
    const { query, parameters } = buildControlCleanupQuery({ olderThanSeconds: cutoffEpoch });
    let token = continuation || undefined;
    let matched = 0;
    let pages = 0;
    do {
      let page;
      try {
        page = await cont.items
          .query({ query, parameters }, { maxItemCount: size, continuationToken: token, enableCrossPartitionQuery: true })
          .fetchNext();
      } catch (e) {
        return { ok: false, error: `query failed: ${e?.message || e}`, matched_so_far: matched, done: false, dry_run: true, older_than_hours: hours, cutoff_epoch: cutoffEpoch };
      }
      matched += (page?.resources || []).length;
      pages += 1;
      token = page?.continuationToken || null;
      if (!token || pages >= maxPages || timeLeft() <= 0) break;
    } while (token);

    return {
      ok: true, processed: matched, deleted: 0, failures: [], sample_errors: [],
      matched_so_far: matched, continuation: token || null, done: !token,
      dry_run: true, older_than_hours: hours, cutoff_epoch: cutoffEpoch, elapsed_ms: Date.now() - startedAt,
    };
  }

  // ── Live: query a small batch, delete it, repeat under the time budget ──
  const { query, parameters } = buildControlCleanupQuery({ olderThanSeconds: cutoffEpoch, topN: size });
  let processed = 0;
  let deleted = 0;
  let failuresCount = 0;
  let throttledBatches = 0;
  const sampleErrors = [];
  let done = false;
  let batches = 0;

  while (timeLeft() > 1500 && batches < maxPages) {
    let docs;
    try {
      const res = await cont.items.query({ query, parameters }, { enableCrossPartitionQuery: true }).fetchAll();
      docs = Array.isArray(res?.resources) ? res.resources : [];
    } catch (e) {
      if (isRateLimited(e)) { throttledBatches += 1; await sleep(500); continue; }
      return { ok: false, error: `query failed: ${e?.message || e}`, processed, deleted, failures: failuresCount, sample_errors: sampleErrors, done: false, dry_run: false, older_than_hours: hours, cutoff_epoch: cutoffEpoch, elapsed_ms: Date.now() - startedAt };
    }

    batches += 1;
    if (docs.length === 0) { done = true; break; }

    let deletedThisBatch = 0;
    let idx = 0;
    const worker = async () => {
      while (idx < docs.length) {
        if (timeLeft() <= 500) return; // bail out before the gateway can time us out
        const doc = docs[idx++];
        const res = await deleteDocWithPkCandidates({ container: cont, containerPkPath, doc, context });
        processed += 1;
        if (res.ok) { deleted += 1; deletedThisBatch += 1; }
        else {
          failuresCount += 1;
          if (sampleErrors.length < 5 && res.error) sampleErrors.push({ id: doc?.id, error: String(res.error).slice(0, 300) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, docs.length) }, worker));

    // Zero progress on a full batch → every delete is failing; stop rather than spin.
    if (deletedThisBatch === 0) break;
  }

  return {
    ok: failuresCount === 0,
    processed,
    deleted,
    failures: failuresCount,
    sample_errors: sampleErrors,
    matched_so_far: processed,
    continuation: null,
    done,
    dry_run: false,
    older_than_hours: hours,
    cutoff_epoch: cutoffEpoch,
    throttled_batches: throttledBatches,
    elapsed_ms: Date.now() - startedAt,
  };
}

module.exports = {
  runImportControlCleanup,
  getCompaniesContainer,
  CONTROL_TYPES,
  _test: { buildControlCleanupQuery, deleteDocWithPkCandidates },
};
