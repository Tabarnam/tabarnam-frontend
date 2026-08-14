/**
 * Migration 0003: Composite indexes on company_edit_history for the audit log.
 *
 * The admin audit table lets you sort by who did something, by which company,
 * or by action type — and within each of those, by time. That is a MULTI-field
 * ORDER BY, which Cosmos cannot serve without a composite index: it fails the
 * request outright with 400 "The order by query does not have a corresponding
 * composite index".
 *
 * This container has hit that exact failure before. See the note in
 * api/admin-company-history/index.js, where "ORDER BY c.created_at DESC, c.id
 * DESC" broke every request and had to be reduced to a single field with the
 * tiebreak reapplied in memory.
 *
 * An in-memory tiebreak is fine for a per-company panel, but it is misleading
 * for a whole-catalog audit table: it only orders the rows already fetched, so
 * "sort by actor" would silently mean "sort this page by actor". Hence real
 * indexes.
 *
 * Each pair is registered in both directions because Cosmos matches a composite
 * index to a query only when every field's direction matches, or every field's
 * direction is exactly inverted.
 *
 * Cost note: composite indexes are written on every history row, and imports
 * write thousands of rows a day. Only the pairs the table actually offers are
 * added — do not add one per column speculatively.
 *
 * After this runs, Cosmos re-indexes in the background (Azure Portal →
 * Container → Index Transformation Progress). The audit endpoint degrades to
 * single-field ordering until it completes, and says so in its response.
 */

const CONTAINER_ID = "company_edit_history";

// Secondary sorts the audit table offers, each paired with time.
const COMPOSITE_PAIRS = [
  ["/actor_email", "/created_at"],
  ["/company_id", "/created_at"],
  ["/action", "/created_at"],
];

function buildPaths([first, second], direction) {
  const inverse = direction === "ascending" ? "descending" : "ascending";
  return [
    { path: first, order: direction },
    { path: second, order: inverse },
  ];
}

function sameIndex(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((entry, i) => entry?.path === b[i]?.path && entry?.order === b[i]?.order);
}

module.exports = {
  id: "0003_audit-log-composite-indexes",
  description: "Composite indexes on company_edit_history for audit-log sorting",

  async up(ctx) {
    const { containers, log, dryRun } = ctx;

    const container = containers.get(CONTAINER_ID);
    if (!container) {
      throw new Error(`Cannot resolve '${CONTAINER_ID}' container for composite-index migration`);
    }

    const { resource: containerDef } = await container.read();
    if (!containerDef) {
      throw new Error(`Failed to read ${CONTAINER_ID} container definition`);
    }

    const indexingPolicy = containerDef.indexingPolicy || {};
    const existing = Array.isArray(indexingPolicy.compositeIndexes)
      ? indexingPolicy.compositeIndexes
      : [];

    const wanted = [];
    for (const pair of COMPOSITE_PAIRS) {
      wanted.push(buildPaths(pair, "ascending"));
      wanted.push(buildPaths(pair, "descending"));
    }

    const missing = wanted.filter((candidate) => !existing.some((e) => sameIndex(e, candidate)));

    if (missing.length === 0) {
      log(`  All ${wanted.length} composite indexes already present on ${CONTAINER_ID} — skipping.`);
      return;
    }

    log(`  ${existing.length} composite index(es) present, adding ${missing.length}.`);
    for (const entry of missing) {
      log(`    + ${entry.map((e) => `${e.path} ${e.order}`).join(", ")}`);
    }

    if (dryRun) {
      log("  [dry-run] Would replace the indexing policy with the additions above.");
      return;
    }

    // Additive: never drop composite indexes this migration did not add.
    const nextPolicy = {
      ...indexingPolicy,
      compositeIndexes: [...existing, ...missing],
    };

    await container.replace({
      id: containerDef.id,
      partitionKey: containerDef.partitionKey,
      indexingPolicy: nextPolicy,
    });

    log(`  Indexing policy updated. Cosmos will re-index ${CONTAINER_ID} in the background.`);
    log("  Until that completes, the audit endpoint falls back to single-field ordering.");
  },
};
