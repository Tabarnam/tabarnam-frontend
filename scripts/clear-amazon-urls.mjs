/**
 * Clear Amazon URL fields (amazon_store_url, amazon_url) across all companies.
 *
 * Usage:
 *   node scripts/clear-amazon-urls.mjs            # dry run — lists affected companies
 *   node scripts/clear-amazon-urls.mjs --execute   # actually clears the fields
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

const FIELDS_TO_CLEAR = ["amazon_store_url", "amazon_url"];

async function run() {
  console.log(`Database: ${databaseId} / Container: ${containerId}`);
  console.log(`Mode: ${execute ? "EXECUTE — will clear fields" : "DRY RUN — no changes"}\n`);

  // Find all companies with non-null Amazon URL fields
  const sql = `
    SELECT c.id, c.normalized_domain, c.company_name, c.amazon_store_url, c.amazon_url
    FROM c
    WHERE c.amazon_store_url != null OR c.amazon_url != null
  `;

  const { resources } = await container.items
    .query(sql, { enableCrossPartitionQuery: true })
    .fetchAll();

  console.log(`Found ${resources.length} companies with Amazon URLs.\n`);

  if (resources.length === 0) {
    console.log("Nothing to clear.");
    process.exit(0);
  }

  // List affected companies
  for (const co of resources) {
    const fields = [];
    if (co.amazon_store_url) fields.push(`amazon_store_url="${co.amazon_store_url}"`);
    if (co.amazon_url) fields.push(`amazon_url="${co.amazon_url}"`);
    console.log(`  ${co.company_name || co.id}  →  ${fields.join(", ")}`);
  }

  if (!execute) {
    console.log(`\nDry run complete. Run with --execute to clear these fields.`);
    process.exit(0);
  }

  // Execute: clear the fields
  console.log(`\nClearing fields...`);
  let updated = 0;
  let errors = 0;

  for (const co of resources) {
    try {
      // Read the full document (the query only returned a projection)
      const partitionKey = String(co.normalized_domain || "unknown").trim();
      const { resource: full } = await container.item(co.id, partitionKey).read();

      if (!full) {
        console.error(`  SKIP ${co.id} — could not read full document`);
        errors++;
        continue;
      }

      // Clear fields
      for (const field of FIELDS_TO_CLEAR) {
        if (full[field] != null) {
          full[field] = null;
        }
      }
      full.updated_at = new Date().toISOString();

      // Upsert
      await container.items.upsert(full, { partitionKey });
      updated++;
      console.log(`  ✓ ${co.company_name || co.id}`);
    } catch (err) {
      errors++;
      console.error(`  ✗ ${co.company_name || co.id}: ${err.message}`);
    }
  }

  console.log(`\nDone. Updated: ${updated}, Errors: ${errors}`);
  process.exit(errors > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
