/**
 * Delete the remaining test/seed companies that still have Amazon URLs
 * after the bulk clear (clear-amazon-urls.mjs cleared 791 but 11 failed
 * due to partition key mismatches).
 *
 * Uses a multi-candidate partition key strategy (mirroring the pattern
 * in api/_cosmosPartitionKey.js) to find the correct PK for each doc.
 *
 * Usage:
 *   node scripts/cleanup-amazon-leftovers.mjs            # dry run
 *   node scripts/cleanup-amazon-leftovers.mjs --execute   # actually deletes
 *
 * Requires env vars: COSMOS_DB_ENDPOINT, COSMOS_DB_KEY
 * Optional:          COSMOS_DB_DATABASE (default "tabarnam-db"),
 *                    COSMOS_DB_COMPANIES_CONTAINER (default "companies")
 */

import { CosmosClient } from "@azure/cosmos";
import * as dotenv from "dotenv";

dotenv.config();

const endpoint = process.env.COSMOS_DB_ENDPOINT;
const key = process.env.COSMOS_DB_KEY;
const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const containerId = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";

if (!endpoint || !key) {
  console.error("Missing COSMOS_DB_ENDPOINT or COSMOS_DB_KEY. Set them in .env or as environment variables.");
  process.exit(1);
}

const execute = process.argv.includes("--execute");
const client = new CosmosClient({ endpoint, key });
const container = client.database(databaseId).container(containerId);

/**
 * Build an ordered list of partition key candidates to try,
 * mirroring the pattern in api/_cosmosPartitionKey.js.
 */
function buildPkCandidates(doc) {
  const seen = new Set();
  const candidates = [];

  function add(val) {
    const key = val === null ? "__null__" : val === undefined ? "__undef__" : String(val);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(val);
  }

  add(doc.normalized_domain);       // primary
  add(doc.partition_key);
  add(doc.partitionKey);
  add(doc.pk);
  add(doc.id);
  add("unknown");
  add(null);                        // final fallback

  return candidates;
}

async function run() {
  console.log(`Database: ${databaseId} / Container: ${containerId}`);
  console.log(`Mode: ${execute ? "EXECUTE — will DELETE documents" : "DRY RUN — no changes"}\n`);

  // Full document query (need all fields for PK candidates)
  const sql = `
    SELECT * FROM c
    WHERE c.amazon_store_url != null OR c.amazon_url != null
  `;

  const { resources } = await container.items
    .query(sql, { enableCrossPartitionQuery: true })
    .fetchAll();

  console.log(`Found ${resources.length} companies with remaining Amazon URLs.\n`);

  if (resources.length === 0) {
    console.log("Nothing to delete — all clean!");
    process.exit(0);
  }

  // List them
  for (const doc of resources) {
    const fields = [];
    if (doc.amazon_store_url) fields.push(`amazon_store_url="${doc.amazon_store_url}"`);
    if (doc.amazon_url) fields.push(`amazon_url="${doc.amazon_url}"`);
    console.log(`  ${doc.company_name || doc.id}  (id: ${doc.id}, domain: ${doc.normalized_domain || "null"})`);
    console.log(`    ${fields.join(", ")}`);
  }

  if (!execute) {
    console.log(`\nDry run complete. Run with --execute to delete these documents.`);
    process.exit(0);
  }

  // Execute: delete each document using multi-candidate PK strategy
  console.log(`\nDeleting documents...`);
  let deleted = 0;
  let errors = 0;

  for (const doc of resources) {
    const candidates = buildPkCandidates(doc);
    let success = false;

    for (const pkValue of candidates) {
      try {
        const item = pkValue !== undefined
          ? container.item(doc.id, pkValue)
          : container.item(doc.id);

        await item.delete();
        deleted++;
        success = true;
        console.log(`  ✓ ${doc.company_name || doc.id}  (pk=${JSON.stringify(pkValue)})`);
        break;
      } catch (err) {
        // 404 = wrong PK candidate, try next
        if (err.code === 404 || err.statusCode === 404) continue;
        // Other error = real failure
        errors++;
        console.error(`  ✗ ${doc.company_name || doc.id}: ${err.message}`);
        success = true; // stop trying candidates
        break;
      }
    }

    if (!success) {
      errors++;
      console.error(`  ✗ ${doc.company_name || doc.id}: could not delete with any partition key candidate`);
    }
  }

  console.log(`\nDone. Deleted: ${deleted}, Errors: ${errors}`);
  process.exit(errors > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
