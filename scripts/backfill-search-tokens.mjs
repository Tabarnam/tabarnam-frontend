/**
 * Backfill the `search_tokens` array (and refresh the other search_text_* fields)
 * on every company document.
 *
 * Why: Phase 1 of replacing the hang-prone Cosmos full-text search with a single
 * indexed ARRAY_CONTAINS(c.search_tokens, ...) query. The query side won't ship
 * until every doc has search_tokens populated, so this script seeds the existing
 * catalog. Going forward, patchCompanyWithSearchText() (in api/_computeSearchText.js)
 * populates the field on every import/admin write automatically.
 *
 * It recomputes via the SAME function the write path uses, so tokens are identical
 * to what new writes produce.
 *
 * Usage:
 *   node scripts/backfill-search-tokens.mjs            # DRY RUN — previews tokens, no writes
 *   node scripts/backfill-search-tokens.mjs --execute  # writes recomputed fields back to Cosmos
 *
 * Requires env vars: COSMOS_DB_ENDPOINT, COSMOS_DB_KEY
 * Optional:          COSMOS_DB_DATABASE (default "tabarnam-db"),
 *                    COSMOS_DB_COMPANIES_CONTAINER (default "companies")
 *
 * Note: the admin-backfill-search-text HTTP endpoint is unreachable (its route
 * conflicts with a built-in route), so this script is the supported way to run it.
 */

import { CosmosClient } from "@azure/cosmos";
import * as dotenv from "dotenv";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// Reuse the exact compute the write path uses, so backfilled tokens match new writes.
const { computeSearchText, patchCompanyWithSearchText } = require(
  join(__dirname, "..", "api", "_computeSearchText.js")
);

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

// Same exclusion the backfill endpoint uses: skip control/import-scaffolding docs.
const SCAN_SQL = `
  SELECT c.id, c.normalized_domain, c.company_name, c.display_name, c.name,
         c.tagline, c.industries, c.categories, c.product_keywords, c.keywords
  FROM c
  WHERE NOT STARTSWITH(c.id, '_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')
  ORDER BY c._ts DESC
`;

function previewStats() {
  let scanned = 0;
  let withTokens = 0;
  let emptyTokens = 0;
  let minLen = Infinity;
  let maxLen = 0;
  let sumLen = 0;
  return {
    record(tokens) {
      scanned++;
      const n = tokens.length;
      if (n > 0) withTokens++;
      else emptyTokens++;
      minLen = Math.min(minLen, n);
      maxLen = Math.max(maxLen, n);
      sumLen += n;
    },
    print() {
      console.log("\n=== DRY RUN SUMMARY ===");
      console.log(`  Companies scanned         : ${scanned}`);
      console.log(`  With >=1 token            : ${withTokens}`);
      console.log(`  Empty token array         : ${emptyTokens}`);
      console.log(`  Tokens/company (min/avg/max): ${scanned ? minLen : 0} / ${scanned ? (sumLen / scanned).toFixed(1) : 0} / ${maxLen}`);
    },
  };
}

async function dryRun() {
  const stats = previewStats();
  const samples = [];
  const iterator = container.items.query(SCAN_SQL, { maxItemCount: 100 });

  for await (const { resources } of iterator.getAsyncIterator()) {
    for (const co of resources) {
      const { search_tokens } = computeSearchText(co);
      stats.record(search_tokens);
      if (samples.length < 12) {
        samples.push({ name: co.company_name || co.display_name || co.id, tokens: search_tokens });
      }
    }
  }

  console.log(`--- sample token output (first ${samples.length}) ---`);
  for (const s of samples) {
    const shown = s.tokens.slice(0, 20).join(", ");
    const more = s.tokens.length > 20 ? ` … (+${s.tokens.length - 20})` : "";
    console.log(`\n  ${s.name}  [${s.tokens.length} tokens]`);
    console.log(`    ${shown}${more}`);
  }
  stats.print();
  console.log(`\nDry run complete. Re-run with --execute to write search_tokens to all docs.`);
}

async function applyAll() {
  let processed = 0;
  let updated = 0;
  let failed = 0;
  const iterator = container.items.query(SCAN_SQL, { maxItemCount: 100 });

  for await (const { resources } of iterator.getAsyncIterator()) {
    for (const co of resources) {
      processed++;
      try {
        const partitionKey = co.normalized_domain || co.id;
        const { resource: doc } = await container.item(co.id, partitionKey).read();
        if (!doc) {
          failed++;
          continue;
        }
        patchCompanyWithSearchText(doc);
        await container.item(doc.id, doc.normalized_domain || doc.id).replace(doc);
        updated++;
        if (processed % 250 === 0) {
          console.error(`  ...processed ${processed}, updated ${updated}, failed ${failed}`);
        }
      } catch (e) {
        failed++;
        console.error(`  ✗ ${co.company_name || co.id}: ${e.message}`);
      }
    }
  }

  console.log("\n=== EXECUTE SUMMARY ===");
  console.log(`  Processed : ${processed}`);
  console.log(`  Updated   : ${updated}`);
  console.log(`  Failed    : ${failed}`);
  return failed;
}

async function run() {
  console.log(`Database: ${databaseId} / Container: ${containerId}`);
  console.log(`Mode: ${execute ? "EXECUTE" : "DRY RUN — no changes"}\n`);

  if (!execute) {
    await dryRun();
    process.exit(0);
  }

  const failed = await applyAll();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
