/**
 * Build and upsert the data-derived industry affinity index
 * (api/_industryAffinityIndex.js) against Cosmos DB directly.
 *
 * Mirrors what POST /api/admin-rebuild-industry-index does server-side, but
 * runs locally — avoids production route-exposure quirks and lets us dry-run
 * before writing.
 *
 * Usage:
 *   node scripts/rebuild-industry-index.mjs            # dry-run (no writes)
 *   node scripts/rebuild-industry-index.mjs --apply    # upsert to Cosmos
 */

import { CosmosClient } from "@azure/cosmos";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildIndustryAffinityIndex } = require("../api/_industryAffinityIndex.js");

const COSMOS_ENDPOINT = process.env.COSMOS_DB_ENDPOINT || "";
const COSMOS_KEY = process.env.COSMOS_DB_KEY || "";
const DATABASE_ID = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const CONTAINER_ID = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";
const DRY_RUN = !process.argv.includes("--apply");

if (!COSMOS_ENDPOINT || !COSMOS_KEY) {
  console.error("Missing COSMOS_DB_ENDPOINT or COSMOS_DB_KEY env vars");
  process.exit(1);
}

const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
const container = client.database(DATABASE_ID).container(CONTAINER_ID);

console.log(DRY_RUN ? "=== DRY RUN (pass --apply to upsert) ===" : "=== APPLYING ===");
console.log(`Database: ${DATABASE_ID}, Container: ${CONTAINER_ID}`);
console.log("");

const started = Date.now();
const doc = await buildIndustryAffinityIndex(container, { log: console.log });

console.log("");
console.log(`Scanned  ${doc.total_companies} companies`);
console.log(`Indexed  ${doc.term_count} terms across ${doc.industry_count} industries`);
console.log(`Build    ${doc.build_ms}ms (wall: ${Date.now() - started}ms)`);

const json = JSON.stringify(doc);
console.log(`Doc size ${Math.round(json.length / 1024)} KB`);

// Sample a handful of interesting terms so you can eyeball the output
// before committing it to Cosmos.
const samples = ["tooth", "scraper", "dental", "oral", "tongue", "hoodie", "candle", "coffee", "compressor", "tire"];
console.log("");
console.log("Sample lookups (top 5 industries per term):");
for (const t of samples) {
  const m = doc.terms[t];
  if (!m) {
    console.log(`  ${t.padEnd(12)} (not indexed — rare or non-discriminating)`);
    continue;
  }
  const top = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const rendered = top.map(([ind, s]) => `${ind}=${s.toFixed(2)}`).join(", ");
  console.log(`  ${t.padEnd(12)} ${rendered}`);
}

if (!DRY_RUN) {
  console.log("");
  console.log("Upserting index doc...");
  await container.items.upsert(doc);
  console.log("Done. The server-side cache will refresh within 15 minutes, or");
  console.log("immediately if you restart the Function App.");
} else {
  console.log("");
  console.log("(dry run — no writes. Re-run with --apply to upsert.)");
}
