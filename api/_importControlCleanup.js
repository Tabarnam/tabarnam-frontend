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
// HOT PARTITION + SDK RETRY: every control doc lives in ONE logical partition
// (normalized_domain:"import"), so a bulk delete throttles hard (429s). The
// @azure/cosmos default retry policy would then RETRY each throttled delete
// internally for up to ~30s, hanging the invocation past the gateway timeout
// (opaque 500). We therefore use a DEDICATED fail-fast client (short
// requestTimeout + minimal throttle-retry) so a throttled delete returns 429 to
// us quickly; we pace it ourselves, delete against the single known partition
// key directly (no candidate cycling), and honour a hard per-call wall-clock
// budget so every HTTP call returns well before any gateway timeout. Callers
// loop until `done`.
//
// Both the manual endpoint (xadmin-api-cleanup-import-control) and the weekly
// timer (cleanup-import-control-timer) call runImportControlCleanup so scheduled
// and manual runs use identical logic.

const { getCosmosConfig } = require("./_cosmosConfig");

const CONCURRENCY = 3; // one hot partition throttles above this
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;
// Keep each HTTP invocation short so the SWA/gateway (~230s) never kills it
// mid-delete; the client loops until done.
const DEFAULT_TIME_BUDGET_MS = 60 * 1000;
const HARD_MAX_TIME_BUDGET_MS = 150 * 1000;
const DELETE_MAX_RETRIES = 3;
const MAX_THROTTLE_BATCHES = 6; // consecutive all-throttled batches before yielding the call

// Control-doc kinds that carry a `type` field. Ids all start `_import_`, but the
// primary-job/session/stop docs also identify by type, so we match on either.
const CONTROL_TYPES = ["import_control", "import_stop", "import_primary_job", "import_session"];

function statusCode(err) {
  return Number(err?.code ?? err?.statusCode ?? err?.status);
}
const isRateLimited = (e) => statusCode(e) === 429;
const isNotFound = (e) => statusCode(e) === 404;

function retryAfterMs(err, attempt) {
  const hinted = Number(err?.retryAfterInMs ?? err?.retryAfterInMilliseconds);
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted, 4000);
  return Math.min(150 * 2 ** attempt, 2500);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dedicated fail-fast Cosmos client for the delete storm (see header). Separate
// from the shared client so its aggressive throttle policy doesn't affect other
// endpoints.
let _cleanupContainer = null;
function getCleanupContainer() {
  if (_cleanupContainer) return _cleanupContainer;
  const { endpoint, key, databaseId, containerId } = getCosmosConfig();
  if (!endpoint || !key) return null;
  const { CosmosClient } = require("@azure/cosmos");
  const client = new CosmosClient({
    endpoint,
    key,
    connectionPolicy: {
      requestTimeout: 12000,
      retryOptions: {
        maxRetryAttemptsOnThrottledRequests: 1,
        fixedRetryIntervalInMilliseconds: 0, // honour server retry-after
        maxWaitTimeInSeconds: 6,
      },
    },
  });
  _cleanupContainer = client.database(databaseId).container(containerId);
  return _cleanupContainer;
}

/**
 * Select stale import-control docs older than `olderThanSeconds` (compared
 * against Cosmos `_ts`, epoch seconds). Never selects soft-deleted docs, real
 * companies, or refresh-job docs. Projects partition_key/normalized_domain so
 * we can delete against the doc's own partition key. Optional `topN` caps the
 * batch for the live loop.
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
 * Delete one control doc against its own partition key ("import" for all control
 * docs). Returns { ok } | { ok:false, throttled:true } | { ok:false, error }.
 * 404 counts as ok (already gone). Never throws.
 */
async function deleteOne(container, doc) {
  const primaryPk = doc?.normalized_domain ?? doc?.partition_key ?? "import";

  for (let attempt = 0; attempt < DELETE_MAX_RETRIES; attempt++) {
    try {
      await container.item(doc.id, primaryPk).delete();
      return { ok: true };
    } catch (e) {
      if (isNotFound(e)) return { ok: true, alreadyGone: true };
      if (isRateLimited(e)) {
        if (attempt < DELETE_MAX_RETRIES - 1) {
          await sleep(retryAfterMs(e, attempt));
          continue;
        }
        return { ok: false, throttled: true, error: "429" };
      }
      // Non-throttle, non-404 (likely wrong PK) — one fallback against "import".
      if (primaryPk !== "import") {
        try {
          await container.item(doc.id, "import").delete();
          return { ok: true };
        } catch (e2) {
          if (isNotFound(e2)) return { ok: true, alreadyGone: true };
          if (isRateLimited(e2)) return { ok: false, throttled: true, error: "429" };
          return { ok: false, error: (e2?.message || String(e2)).slice(0, 250) };
        }
      }
      return { ok: false, error: (e?.message || String(e)).slice(0, 250) };
    }
  }
  return { ok: false, throttled: true, error: "429" };
}

/**
 * Purge stale control docs. Never throws — returns a structured result.
 *
 * dryRun: counts matches via continuation paging (read-only).
 * live:   query-TOP-N-and-delete loop under a wall-clock budget; re-queries from
 *         the top each batch (deletes shrink the set). Backs off on all-throttled
 *         batches; stops on hard-failure batches.
 *
 * @returns {Promise<{ ok, processed, deleted, failures, throttled, sample_errors,
 *   matched_so_far, done, hard_error, dry_run, older_than_hours, cutoff_epoch,
 *   elapsed_ms }>}
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
  const cont = container || getCleanupContainer();
  if (!cont) return { ok: false, error: "Cosmos not configured" };

  const startedAt = Date.now();
  const hours = Math.max(0, Number(olderThanHours) || 0);
  const cutoffEpoch = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE));
  const budget = Math.min(HARD_MAX_TIME_BUDGET_MS, Math.max(5000, Number(timeBudgetMs) || DEFAULT_TIME_BUDGET_MS));
  const timeLeft = () => budget - (Date.now() - startedAt);

  // ── Dry run: count via continuation paging (read-only) ──
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
      ok: true, processed: matched, deleted: 0, failures: 0, throttled: 0, sample_errors: [],
      matched_so_far: matched, continuation: token || null, done: !token,
      dry_run: true, older_than_hours: hours, cutoff_epoch: cutoffEpoch, elapsed_ms: Date.now() - startedAt,
    };
  }

  // ── Live: query a small batch, delete it, repeat under the time budget ──
  const { query, parameters } = buildControlCleanupQuery({ olderThanSeconds: cutoffEpoch, topN: size });
  let processed = 0;
  let deleted = 0;
  let failuresCount = 0;
  let throttledCount = 0;
  const sampleErrors = [];
  let done = false;
  let hardError = false;
  let batches = 0;
  let throttleStreak = 0;

  while (timeLeft() > 2000 && batches < maxPages) {
    let docs;
    try {
      const res = await cont.items.query({ query, parameters }, { enableCrossPartitionQuery: true }).fetchAll();
      docs = Array.isArray(res?.resources) ? res.resources : [];
    } catch (e) {
      if (isRateLimited(e)) { await sleep(500); continue; }
      return { ok: false, error: `query failed: ${e?.message || e}`, processed, deleted, failures: failuresCount, throttled: throttledCount, sample_errors: sampleErrors, done: false, hard_error: true, dry_run: false, older_than_hours: hours, cutoff_epoch: cutoffEpoch, elapsed_ms: Date.now() - startedAt };
    }

    batches += 1;
    if (docs.length === 0) { done = true; break; }

    let deletedThisBatch = 0;
    let hardThisBatch = 0;
    let idx = 0;
    const worker = async () => {
      while (idx < docs.length) {
        if (timeLeft() <= 800) return; // bail before the gateway can time us out
        const doc = docs[idx++];
        const res = await deleteOne(cont, doc);
        processed += 1;
        if (res.ok) { deleted += 1; deletedThisBatch += 1; }
        else if (res.throttled) { throttledCount += 1; }
        else {
          failuresCount += 1; hardThisBatch += 1;
          if (sampleErrors.length < 5 && res.error) sampleErrors.push({ id: doc?.id, error: String(res.error).slice(0, 250) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, docs.length) }, worker));

    if (deletedThisBatch > 0) { throttleStreak = 0; continue; }
    // Zero progress this batch:
    if (hardThisBatch > 0) { hardError = true; break; } // real errors, not throttling
    // All throttled — back off, then retry within the budget.
    throttleStreak += 1;
    if (throttleStreak >= MAX_THROTTLE_BATCHES) break; // yield this call; client retries
    await sleep(Math.min(800 * throttleStreak, 4000));
  }

  return {
    ok: failuresCount === 0 && !hardError,
    processed,
    deleted,
    failures: failuresCount,
    throttled: throttledCount,
    sample_errors: sampleErrors,
    matched_so_far: processed,
    continuation: null,
    done,
    hard_error: hardError,
    dry_run: false,
    older_than_hours: hours,
    cutoff_epoch: cutoffEpoch,
    elapsed_ms: Date.now() - startedAt,
  };
}

module.exports = {
  runImportControlCleanup,
  getCleanupContainer,
  getCompaniesContainer: getCleanupContainer, // back-compat alias
  CONTROL_TYPES,
  _test: { buildControlCleanupQuery, deleteOne },
};
