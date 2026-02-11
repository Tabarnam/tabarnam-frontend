#!/usr/bin/env node

/**
 * CLI runner for Cosmos DB migrations.
 *
 * Usage:
 *   node scripts/run-migrations.mjs              # dry-run (no writes)
 *   node scripts/run-migrations.mjs --apply      # apply pending migrations
 *   node scripts/run-migrations.mjs --status      # show migration state only
 *
 * Requires environment variables:
 *   COSMOS_DB_ENDPOINT, COSMOS_DB_KEY
 *   COSMOS_DB_DATABASE (default: "tabarnam-db")
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { CosmosClient } = require("@azure/cosmos");

const {
  runMigrations,
  discoverMigrations,
  readMigrationState,
  META_DOC_ID,
  META_PARTITION_KEY,
} = require("../api/_migrationRunner");

const {
  resolveCosmosEndpoint,
  resolveCosmosKey,
  resolveCosmosDatabaseId,
  resolveCosmosContainerId,
} = require("../api/_cosmosConfig");

function parseArgs(argv) {
  const flags = { apply: false, status: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--apply") flags.apply = true;
    else if (arg === "--status") flags.status = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv);

  const endpoint = resolveCosmosEndpoint();
  const key = resolveCosmosKey();
  const databaseId = resolveCosmosDatabaseId();
  const containerId = resolveCosmosContainerId();

  if (!endpoint || !key) {
    console.error("Missing COSMOS_DB_ENDPOINT / COSMOS_DB_KEY environment variables.");
    process.exitCode = 1;
    return;
  }

  console.log(`Cosmos DB: ${endpoint}`);
  console.log(`Database:  ${databaseId}`);
  console.log(`Container: ${containerId} (migration state)`);
  console.log();

  const client = new CosmosClient({ endpoint, key });
  const database = client.database(databaseId);

  // --status: show current state and exit
  if (flags.status) {
    const container = database.container(containerId);
    const state = await readMigrationState(container);
    const discovered = discoverMigrations();

    console.log("Discovered migrations:");
    for (const m of discovered) {
      const applied = state?.applied_migrations?.includes(m.id);
      console.log(`  ${applied ? "[x]" : "[ ]"} ${m.id} — ${m.description || ""}`);
    }
    console.log();
    console.log("State document:", JSON.stringify(state, null, 2));
    return;
  }

  const dryRun = !flags.apply;

  const result = await runMigrations({ database, dryRun });

  console.log();
  console.log(`Result: ${result.applied.length} applied, ${result.skipped.length} skipped, ${result.total} total`);

  if (dryRun && result.applied.length > 0) {
    console.log("\nThis was a DRY RUN. Use --apply to apply migrations.");
  }
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exitCode = 1;
});
