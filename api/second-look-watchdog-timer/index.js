/**
 * Watchdog timer: clears STALE `second_look_pending` flags.
 *
 * The second-look lane sets `second_look_pending = true` on a company doc when
 * it enqueues a gap-fill message, and the worker clears it on completion
 * (_secondLookWorker.js). But if that message is ever consumed without the
 * worker reaching completion — an early-return path (missing identity, a
 * point-read miss after a domain change), a lost/dead-lettered message — the
 * flag is never cleared and the admin Companies row shows "Enriching…" forever
 * (the pill keys on `second_look_pending && !second_look_done`).
 *
 * This sweep clears the pending flag once it's demonstrably stale: enqueued long
 * enough ago that any real run — including the worker's own circuit-breaker /
 * lock-busy requeues (≤2 min) — would have finished. We clear ONLY the pending
 * flag (not `second_look_done`), so a company that still has genuinely-missing
 * fields remains eligible for a real second-look on a future import/refresh; we
 * just stop showing a permanent, false "Enriching…".
 *
 * Runs on the dedicated worker Function App only (same gate as the other
 * timers), every 5 minutes.
 */

const { app } = require("../_app");
const { getCosmosClient } = require("../_cosmosConfig");

const IS_DEDICATED_WORKER = String(process.env.WEBSITE_SITE_NAME || "")
  .toLowerCase()
  .includes("dedicated");

// Wide margin over any legitimate run. Real second-looks finish in seconds to a
// couple of minutes; the worker's longest self-requeue (circuit breaker) is
// 120s. 30 min guarantees we never clear a flag that's still legitimately busy.
const DEFAULT_STALE_MS = 30 * 60 * 1000;

/**
 * Pure predicate: is this doc's second-look flag stranded?
 * True when pending is set, it never completed, and either it carries no
 * enqueue timestamp at all or that timestamp is older than `staleMs`.
 */
function isSecondLookStale(doc, nowMs, staleMs = DEFAULT_STALE_MS) {
  if (!doc || doc.second_look_pending !== true) return false;
  if (doc.second_look_done === true) return false;
  const enqMs = Date.parse(String(doc.second_look_enqueued_at || "")) || 0;
  if (!enqMs) return true; // pending with no enqueue stamp → stranded
  return nowMs - enqMs >= staleMs;
}

function getCompaniesContainer() {
  const database = String(process.env.COSMOS_DB_DATABASE || process.env.COSMOS_DB || "tabarnam-db").trim();
  const containerName = String(process.env.COSMOS_DB_COMPANIES_CONTAINER || process.env.COSMOS_CONTAINER || "companies").trim();
  const client = getCosmosClient();
  if (!client) return null;
  return client.database(database).container(containerName);
}

/**
 * Find and clear stranded second-look flags. Returns { scanned, cleared, names }.
 * `container` is injectable for tests.
 */
async function sweepStaleSecondLook(container, { nowMs = Date.now(), staleMs = DEFAULT_STALE_MS, log = console.log } = {}) {
  if (!container) return { scanned: 0, cleared: 0, names: [] };

  const { resources } = await container.items
    .query(
      "SELECT * FROM c WHERE c.second_look_pending = true AND (NOT IS_DEFINED(c.second_look_done) OR c.second_look_done != true) AND NOT STARTSWITH(c.id, '_import_')"
    )
    .fetchAll();

  const nowIso = new Date(nowMs).toISOString();
  const names = [];
  for (const doc of resources) {
    if (!isSecondLookStale(doc, nowMs, staleMs)) continue;
    doc.second_look_pending = false;
    doc.second_look = {
      ...(doc.second_look || {}),
      watchdog_cleared_at: nowIso,
      cleared_reason: "watchdog_stale_timeout",
    };
    doc.updated_at = nowIso;
    try {
      await container.item(doc.id, doc.normalized_domain).replace(doc);
      names.push(doc.company_name || doc.id);
      log(`[second-look-watchdog] cleared stale second_look_pending: ${doc.company_name || doc.id}`);
    } catch (e) {
      log(`[second-look-watchdog] clear failed for ${doc.id}: ${e?.message || e}`);
    }
  }
  return { scanned: resources.length, cleared: names.length, names };
}

if (IS_DEDICATED_WORKER) {
  app.timer("second-look-watchdog-timer", {
    schedule: "0 */5 * * * *",
    handler: async (_myTimer, context) => {
      const log = typeof context?.log === "function" ? context.log.bind(context) : console.log;
      try {
        const container = getCompaniesContainer();
        const res = await sweepStaleSecondLook(container, { log });
        if (res.cleared > 0) {
          log(`[second-look-watchdog] swept: scanned=${res.scanned} cleared=${res.cleared} (${res.names.join(", ")})`);
        }
      } catch (e) {
        (context?.error || console.error)(`[second-look-watchdog] sweep failed: ${e?.message || e}`);
      }
    },
  });
}

module.exports = { isSecondLookStale, sweepStaleSecondLook, DEFAULT_STALE_MS };
