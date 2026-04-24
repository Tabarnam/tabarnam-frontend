/**
 * Nightly timer trigger: rebuilds the industry-affinity inverted index.
 *
 * Schedule: 0 0 3 * * *   (daily at 03:00 UTC)
 *
 * Only registers on the dedicated worker Function App (same gate used by
 * bulk-import-worker) so the main API app doesn't accidentally run it and
 * we don't double-fire. The heavy lifting is delegated to the shared
 * rebuildIndustryAffinityIndex() in admin-rebuild-industry-index so manual
 * and scheduled runs use identical logic.
 */

const { app } = require("../_app");
const {
  rebuildIndustryAffinityIndex,
} = require("../admin-rebuild-industry-index/index");

const IS_DEDICATED_WORKER = String(process.env.WEBSITE_SITE_NAME || "")
  .toLowerCase()
  .includes("dedicated");

if (IS_DEDICATED_WORKER) {
  app.timer("rebuild-industry-index-timer", {
    schedule: "0 0 3 * * *",
    handler: async (_myTimer, context) => {
      const log = typeof context?.log === "function" ? context.log.bind(context) : console.log;
      const started = Date.now();
      log("[rebuild-industry-index-timer] timer fired, starting rebuild");
      try {
        const doc = await rebuildIndustryAffinityIndex(context);
        log(
          `[rebuild-industry-index-timer] rebuild complete in ${Date.now() - started}ms: ` +
          `${doc.total_companies} companies, ${doc.term_count} terms, ${doc.industry_count} industries`
        );
      } catch (e) {
        (context?.error || console.error)(
          `[rebuild-industry-index-timer] rebuild failed: ${e?.message || e}`
        );
      }
    },
  });
}

module.exports = {};
