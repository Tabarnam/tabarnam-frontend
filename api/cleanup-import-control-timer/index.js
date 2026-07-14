/**
 * Weekly timer trigger: purges stale import-control docs from the companies
 * container so they never accumulate again.
 *
 * Schedule: 0 0 9 * * 0   (Sundays 09:00 UTC ≈ 1–2am US)
 *
 * Only registers on the dedicated worker Function App (same gate as
 * rebuild-industry-index-timer / bulk-import-worker) so the main API app
 * doesn't double-fire. The heavy lifting is delegated to the shared
 * runImportControlCleanup() so manual (xadmin-api-cleanup-import-control) and
 * scheduled runs use identical logic.
 *
 * Age-gated at 24h by default (env IMPORT_CONTROL_CLEANUP_HOURS) so an
 * in-flight or just-finished import — whose control docs the UI still reads for
 * ~10 min after completion — is never touched. Pages until done within the
 * invocation's time budget; any leftover continuation is drained on the next
 * tick (only relevant for a first-run backlog).
 */

const { app } = require("../_app");
const { runImportControlCleanup, getCompaniesContainer } = require("../_importControlCleanup");

const IS_DEDICATED_WORKER = String(process.env.WEBSITE_SITE_NAME || "")
  .toLowerCase()
  .includes("dedicated");

const TIME_BUDGET_MS = Math.floor(8.5 * 60 * 1000); // under host.json 10-min cap

if (IS_DEDICATED_WORKER) {
  app.timer("cleanup-import-control-timer", {
    schedule: "0 0 9 * * 0",
    handler: async (_myTimer, context) => {
      const log = typeof context?.log === "function" ? context.log.bind(context) : console.log;
      const olderThanHours = Number(process.env.IMPORT_CONTROL_CLEANUP_HOURS) || 24;
      const started = Date.now();
      log(`[cleanup-import-control-timer] timer fired, older_than_hours=${olderThanHours}`);

      const container = getCompaniesContainer();
      if (!container) {
        (context?.error || console.error)("[cleanup-import-control-timer] Cosmos not configured");
        return;
      }

      let totalProcessed = 0;
      let totalDeleted = 0;
      try {
        // Drain within one invocation's budget. Each call deletes a throttle-
        // safe batch and returns done=true once nothing older than the grace
        // window remains. (At steady state that's one quick pass.)
        for (;;) {
          const res = await runImportControlCleanup({
            container,
            olderThanHours,
            dryRun: false,
            pageSize: 200,
            timeBudgetMs: 120000,
            context,
          });
          totalProcessed += res.processed || 0;
          totalDeleted += res.deleted || 0;
          // Continue only while draining is making progress; stop on done, a
          // stalled batch (0 deletes), or the invocation budget.
          if (res.done || (res.deleted || 0) === 0 || Date.now() - started >= TIME_BUDGET_MS) break;
        }
        log(
          `[cleanup-import-control-timer] done in ${Date.now() - started}ms: ` +
            `processed=${totalProcessed} deleted=${totalDeleted} ` +
            `${continuation ? "(continuation carried to next tick)" : "(fully drained)"}`,
        );
      } catch (e) {
        (context?.error || console.error)(
          `[cleanup-import-control-timer] failed after ${Date.now() - started}ms: ${e?.message || e}`,
        );
      }
    },
  });
}

module.exports = {};
