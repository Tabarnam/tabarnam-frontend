/**
 * Migration 0002: Add full-text search index on the companies container.
 *
 * Adds a full-text policy and full-text index for the `search_text_norm` field,
 * enabling Cosmos DB native full-text search with BM25 ranking, built-in
 * stemming, and tokenization.
 *
 * This replaces the hand-rolled CONTAINS() substring matching with an inverted
 * index — significantly faster and cheaper in RUs.
 *
 * After this migration runs, Cosmos DB re-indexes in the background. FTS
 * queries should only be deployed after re-indexing completes (check via
 * Azure Portal → Container → Index Transformation Progress).
 */

module.exports = {
  id: "0002_add-fulltext-index",
  description: "Add full-text search index on search_text_norm for BM25 search",

  async up(ctx) {
    const { containers, log, dryRun } = ctx;

    const container = containers.get("companies");
    if (!container) {
      throw new Error("Cannot resolve 'companies' container for full-text index migration");
    }

    // Read the current container definition
    const { resource: containerDef } = await container.read();
    if (!containerDef) {
      throw new Error("Failed to read companies container definition");
    }

    log(`  Current container id: ${containerDef.id}`);
    log(`  Current indexing policy mode: ${containerDef.indexingPolicy?.indexingMode || "unknown"}`);

    // Check if full-text policy already exists
    const existingFtPaths = containerDef.fullTextPolicy?.fullTextPaths || [];
    const alreadyIndexed = existingFtPaths.some(
      (p) => p.path === "/search_text_norm"
    );

    if (alreadyIndexed) {
      log("  Full-text index on /search_text_norm already exists — skipping.");
      return;
    }

    // Build updated definition
    const updatedDef = { ...containerDef };

    // Add full-text policy
    updatedDef.fullTextPolicy = {
      defaultLanguage: "en-US",
      fullTextPaths: [
        ...(containerDef.fullTextPolicy?.fullTextPaths || []),
        { path: "/search_text_norm", language: "en-US" },
      ],
    };

    // Add full-text index to indexing policy
    const indexingPolicy = { ...(containerDef.indexingPolicy || {}) };
    indexingPolicy.fullTextIndexes = [
      ...(indexingPolicy.fullTextIndexes || []),
      { path: "/search_text_norm" },
    ];
    updatedDef.indexingPolicy = indexingPolicy;

    if (dryRun) {
      log("  [dry-run] Would add full-text policy:");
      log(`    fullTextPaths: ${JSON.stringify(updatedDef.fullTextPolicy.fullTextPaths)}`);
      log("  [dry-run] Would add full-text index:");
      log(`    fullTextIndexes: ${JSON.stringify(indexingPolicy.fullTextIndexes)}`);
      return;
    }

    // Apply the updated container definition
    log("  Replacing container definition with full-text index...");
    await container.replace(updatedDef);
    log("  Full-text index added successfully on /search_text_norm");
    log("  NOTE: Background re-indexing has started. Check Azure Portal for progress.");
  },
};
