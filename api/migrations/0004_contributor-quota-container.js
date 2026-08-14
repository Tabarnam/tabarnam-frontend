/**
 * Migration 0004: Create the contributor_quota container.
 *
 * WHY THIS IS NOT IN 0001: `contributor_quota` was originally added to the
 * container list in 0001_ensure-containers, which is the natural place for it.
 * But 0001 had already been applied in production, and the runner skips
 * applied migrations — so the container would never have been created there.
 *
 * That failure would have been quiet in the worst way: _importQuota.js fails
 * CLOSED, so every contributor import would have been refused with
 * "quota_store_unavailable" and nothing would have pointed at a missing
 * container. It stays listed in 0001 as well so a fresh environment still gets
 * it; both paths are createIfNotExists, so running either is harmless.
 *
 * defaultTtl: -1 enables per-item TTL. The counters _importQuota.js writes each
 * carry their own `ttl`, so they expire on their own instead of accumulating
 * one document per contributor per day forever.
 *
 * Partition key is /id: every contributor-day is its own partition, so a busy
 * contributor never turns into a hot partition for anyone else.
 */

const CONTAINER_SPEC = {
  id: "contributor_quota",
  partitionKey: "/id",
  defaultTtl: -1,
};

module.exports = {
  id: "0004_contributor-quota-container",
  description: "Create contributor_quota (per-contributor daily import counters)",

  async up(ctx) {
    const { database, log, dryRun } = ctx;

    if (dryRun) {
      log(
        `  [dry-run] Would createIfNotExists: ${CONTAINER_SPEC.id} ` +
          `(pk: ${CONTAINER_SPEC.partitionKey}, defaultTtl: ${CONTAINER_SPEC.defaultTtl})`
      );
      return;
    }

    const { resource } = await database.containers.createIfNotExists({
      id: CONTAINER_SPEC.id,
      partitionKey: { paths: [CONTAINER_SPEC.partitionKey] },
      defaultTtl: CONTAINER_SPEC.defaultTtl,
    });

    log(`  Container "${CONTAINER_SPEC.id}" ready (pk: ${CONTAINER_SPEC.partitionKey}).`);

    // createIfNotExists does NOT update an existing container's TTL setting, so
    // an earlier hand-created container could be missing it. Verify rather than
    // assume: without defaultTtl the per-item ttl is ignored and counters
    // accumulate silently.
    if (resource && resource.defaultTtl !== CONTAINER_SPEC.defaultTtl) {
      log(
        `  defaultTtl is ${resource.defaultTtl ?? "unset"}, expected ${CONTAINER_SPEC.defaultTtl} — patching.`
      );
      await database.container(CONTAINER_SPEC.id).replace({
        id: CONTAINER_SPEC.id,
        partitionKey: resource.partitionKey,
        defaultTtl: CONTAINER_SPEC.defaultTtl,
      });
      log("  defaultTtl set; quota counters will expire on their own.");
    }
  },
};
