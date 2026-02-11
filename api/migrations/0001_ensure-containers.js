/**
 * Migration 0001: Ensure all known containers exist with correct partition keys.
 *
 * Uses database.containers.createIfNotExists() which is idempotent — safe to
 * run against a database that already has some or all containers.
 */

const CONTAINERS = [
  { id: "companies", partitionKey: "/normalized_domain" },
  { id: "reviews", partitionKey: "/normalized_domain" },
  { id: "notes", partitionKey: "/company_id" },
  { id: "notes_admin", partitionKey: "/company_id" },
  { id: "company_edit_history", partitionKey: "/company_id" },
  { id: "import_logs", partitionKey: "/session_id" },
  { id: "analytics", partitionKey: "/id" },
  { id: "keywords", partitionKey: "/id" },
];

module.exports = {
  id: "0001_ensure-containers",
  description: "Create all known containers with correct partition keys",

  async up(ctx) {
    const { database, log, dryRun } = ctx;

    for (const spec of CONTAINERS) {
      if (dryRun) {
        log(`  [dry-run] Would createIfNotExists: ${spec.id} (pk: ${spec.partitionKey})`);
        continue;
      }

      try {
        await database.containers.createIfNotExists({
          id: spec.id,
          partitionKey: { paths: [spec.partitionKey] },
        });
        log(`  Container "${spec.id}" ready (pk: ${spec.partitionKey})`);
      } catch (e) {
        log(`  WARNING: Failed to create container "${spec.id}": ${e?.message}`);
        throw e;
      }
    }
  },
};
