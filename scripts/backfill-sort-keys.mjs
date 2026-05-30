/**
 * One-time backfill of admin-sort scalar fields on every company doc:
 *   - qq_score      (sum of rating.star1..star6 .value, clamped 0–5)
 *   - issues_count  (count of issue tags the admin Issues column would render)
 *
 * Cosmos `ORDER BY c.qq_score` and `ORDER BY c.issues_count` exclude docs
 * missing the field, so every existing company must have both populated or
 * it will vanish from those sorts. New writes go through admin-companies-v2
 * and the resume-worker, both of which now call applySortKeys() — this
 * script covers the historical docs created before those changes shipped.
 *
 * Usage:
 *   node scripts/backfill-sort-keys.mjs           # dry-run (no writes)
 *   node scripts/backfill-sort-keys.mjs --apply   # apply to Cosmos
 *
 * Required env: COSMOS_DB_ENDPOINT, COSMOS_DB_KEY
 */

import { CosmosClient } from "@azure/cosmos";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { applySortKeys, computeQqScore, computeIssuesCount } = require("../api/_sortKeys.js");

const ENDPOINT = process.env.COSMOS_DB_ENDPOINT || "";
const KEY = process.env.COSMOS_DB_KEY || "";
const DB = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const CONTAINER = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";
const DRY_RUN = !process.argv.includes("--apply");

if (!ENDPOINT || !KEY) {
  console.error("Missing COSMOS_DB_ENDPOINT or COSMOS_DB_KEY env vars");
  process.exit(1);
}

const client = new CosmosClient({ endpoint: ENDPOINT, key: KEY });
const container = client.database(DB).container(CONTAINER);

console.log(DRY_RUN ? "=== DRY RUN (pass --apply to write) ===" : "=== APPLYING CHANGES ===");
console.log(`Cosmos: ${DB}/${CONTAINER}`);

// Filter out soft-deleted and control docs so we only touch real companies.
const queryIterator = container.items.query({
  query: `
    SELECT * FROM c
    WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)
      AND NOT STARTSWITH(c.id, "_import_")
      AND NOT STARTSWITH(c.id, "refresh_job_")
      AND NOT STARTSWITH(c.id, "resume_")
      AND (NOT IS_DEFINED(c.type) OR c.type != "import_control")
  `,
}, { enableCrossPartitionQuery: true });

let total = 0;
let updated = 0;
let skipped = 0;
let failed = 0;
const sample = [];

while (queryIterator.hasMoreResults()) {
  const { resources } = await queryIterator.fetchNext();
  for (const doc of resources || []) {
    total++;
    const beforeQq = typeof doc.qq_score === "number" ? doc.qq_score : null;
    const beforeIc = typeof doc.issues_count === "number" ? doc.issues_count : null;
    const newQq = computeQqScore(doc);
    const newIc = computeIssuesCount(doc);

    const needsUpdate = beforeQq !== newQq || beforeIc !== newIc;
    if (!needsUpdate) { skipped++; continue; }

    if (sample.length < 5) {
      sample.push({
        id: doc.id,
        name: doc.company_name || doc.name,
        before: { qq_score: beforeQq, issues_count: beforeIc },
        after: { qq_score: newQq, issues_count: newIc },
      });
    }

    if (!DRY_RUN) {
      try {
        applySortKeys(doc);
        await container.item(doc.id, doc.normalized_domain || doc.id).replace(doc);
        updated++;
      } catch (e) {
        // Fallback: upsert without partition (older docs may have inconsistent PK).
        try {
          applySortKeys(doc);
          await container.items.upsert(doc);
          updated++;
        } catch (e2) {
          failed++;
          if (failed <= 5) {
            console.error(`Failed to write ${doc.id}:`, e2?.message || e2);
          }
        }
      }
    } else {
      updated++;
    }

    if (updated % 100 === 0 && updated > 0) {
      console.log(`  ${updated} updated so far (${total} scanned)…`);
    }
  }
}

console.log("");
console.log("=== Summary ===");
console.log(`Total scanned:        ${total}`);
console.log(`Would update / wrote: ${updated}`);
console.log(`Already up-to-date:   ${skipped}`);
console.log(`Failed:               ${failed}`);
console.log("");
console.log("Sample changes:");
for (const s of sample) console.log(" ", JSON.stringify(s));

if (DRY_RUN) {
  console.log("\nDry run only. Re-run with --apply to write to Cosmos.");
}
