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
// Both the manual endpoint (xadmin-api-cleanup-import-control) and the weekly
// timer (cleanup-import-control-timer) call runImportControlCleanup so scheduled
// and manual runs use identical logic.

const { getCompaniesContainer } = require("./_reviewCounts");
const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
} = require("./_cosmosPartitionKey");

const CONCURRENCY = 4;
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 1000;
const DEFAULT_TIME_BUDGET_MS = Math.floor(8.5 * 60 * 1000); // < host.json 10-min cap
const DELETE_MAX_RETRIES = 3;

// Control-doc kinds that carry a `type` field. Ids all start `_import_`, but the
// primary-job/session/stop docs also identify by type, so we match on either.
const CONTROL_TYPES = ["import_control", "import_stop", "import_primary_job", "import_session"];

function isRateLimited(err) {
  const code = err?.code ?? err?.statusCode ?? err?.status;
  return Number(code) === 429;
}

function retryAfterMs(err, attempt) {
  const hinted = Number(err?.retryAfterInMs ?? err?.retryAfterInMilliseconds);
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted, 5000);
  return Math.min(200 * 2 ** attempt, 2000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Select stale import-control docs older than `olderThanSeconds` (compared
 * against Cosmos `_ts`, epoch seconds). Never selects soft-deleted docs, real
 * companies, or refresh-job docs. Projects partition_key/normalized_domain so
 * the PK-candidate fallback resolves for every id kind.
 */
function buildControlCleanupQuery({ olderThanSeconds }) {
  const cutoff = Math.floor(Number(olderThanSeconds));
  const typeList = CONTROL_TYPES.map((_, i) => `@type${i}`).join(", ");
  const parameters = [
    { name: "@cutoff", value: cutoff },
    ...CONTROL_TYPES.map((t, i) => ({ name: `@type${i}`, value: t })),
  ];

  const query = [
    "SELECT c.id, c.normalized_domain, c.partition_key, c.type, c._ts",
    "FROM c",
    "WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)",
    `  AND (STARTSWITH(c.id, '_import_') OR (IS_DEFINED(c.type) AND c.type IN (${typeList})))`,
    "  AND c._ts <= @cutoff",
  ].join("\n");

  return { query, parameters };
}

/**
 * Delete a doc by trying each partition-key candidate; retry transient 429s.
 * Ported from admin-cleanup-import-placeholders with retry-on-429 added so
 * throttling isn't miscounted as a hard failure.
 */
async function deleteDocWithPkCandidates({ container, containerPkPath, doc, context }) {
  const candidates = buildPartitionKeyCandidates({
    doc,
    containerPkPath,
    requestedId: doc?.id,
  });

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
        break; // not a 429 — try the next candidate
      }
    }
  }

  context?.log?.("[import-control-cleanup] delete failed", {
    id: doc?.id,
    candidateCount: candidates.length,
  });
  return { ok: false, candidateCount: candidates.length };
}

/**
 * Page through and delete stale control docs.
 *
 * @returns {Promise<{ ok, processed, deleted, failures, matched_so_far,
 *   continuation, done, dry_run, older_than_hours, cutoff_epoch }>}
 * Loops pages until the continuation is exhausted (done), `maxPages` is hit, or
 * `timeBudgetMs` elapses — returning the last continuation so a caller (timer
 * next tick, or operator loop) can resume.
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

  const containerPkPath = await getContainerPartitionKeyPath(cont, "/normalized_domain").catch(
    () => "/normalized_domain",
  );

  const { query, parameters } = buildControlCleanupQuery({ olderThanSeconds: cutoffEpoch });

  let token = continuation || undefined;
  let processed = 0;
  let deleted = 0;
  let matched = 0;
  const failures = [];
  let pages = 0;

  do {
    let page;
    try {
      page = await cont.items
        .query({ query, parameters }, { maxItemCount: size, continuationToken: token, enableCrossPartitionQuery: true })
        .fetchNext();
    } catch (e) {
      return {
        ok: false,
        error: `query failed: ${e?.message || e}`,
        processed,
        deleted,
        matched_so_far: matched,
        continuation: token || null,
        done: false,
        dry_run: dryRun,
        older_than_hours: hours,
        cutoff_epoch: cutoffEpoch,
      };
    }

    const docs = Array.isArray(page?.resources) ? page.resources : [];
    matched += docs.length;
    pages += 1;

    if (!dryRun && docs.length) {
      let i = 0;
      const worker = async () => {
        while (i < docs.length) {
          const doc = docs[i++];
          const res = await deleteDocWithPkCandidates({ container: cont, containerPkPath, doc, context });
          processed += 1;
          if (res.ok) deleted += 1;
          else failures.push({ id: doc?.id, candidateCount: res.candidateCount || 0 });
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, docs.length) }, worker));
    } else if (dryRun) {
      processed += docs.length; // dry run: "processed" == inspected
    }

    token = page?.continuationToken || null;

    if (!token) break;
    if (pages >= maxPages) break;
    if (Date.now() - startedAt >= timeBudgetMs) break;
  } while (token);

  return {
    ok: failures.length === 0,
    processed,
    deleted,
    failures,
    matched_so_far: matched,
    continuation: token || null,
    done: !token,
    dry_run: dryRun,
    older_than_hours: hours,
    cutoff_epoch: cutoffEpoch,
    elapsed_ms: Date.now() - startedAt,
  };
}

module.exports = {
  runImportControlCleanup,
  getCompaniesContainer,
  CONTROL_TYPES,
  _test: { buildControlCleanupQuery, deleteDocWithPkCandidates },
};
