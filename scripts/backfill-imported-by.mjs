/**
 * One-time backfill of importer/owner attribution on existing company docs:
 *   - imported_by     → jon@tabarnam.com  (historically all imports were Jon's)
 *   - owner           → jon@tabarnam.com
 *   - imported_by_at  → the doc's created_at (historically accurate), else null
 *
 * Only fills fields that are missing/empty — never overwrites a value a newer
 * import already stamped — so the script is idempotent: a second run reports
 * zero rows left to change. New imports are attributed at write time by
 * import-start/_importStartSaveCompanies.js and save-companies.
 *
 * Usage:
 *   node scripts/backfill-imported-by.mjs           # dry-run (no writes)
 *   node scripts/backfill-imported-by.mjs --apply   # apply to Cosmos
 *
 * Required env: COSMOS_DB_ENDPOINT, COSMOS_DB_KEY
 */

import { CosmosClient } from "@azure/cosmos";

const BACKFILL_EMAIL = "jon@tabarnam.com";

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
console.log(`Backfill target: ${BACKFILL_EMAIL}`);

const hasValue = (v) => typeof v === "string" && v.trim() !== "";

// Real companies only: skip soft-deleted rows and control docs. Pull only the
// fields the script needs — no reason to drag full docs across the wire just
// to discover most are already attributed.
const queryIterator = container.items.query({
  query: `
    SELECT c.id, c.normalized_domain, c.company_name, c.name,
           c.imported_by, c.imported_by_at, c.owner, c.created_at
    FROM c
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
  for (const row of resources || []) {
    total++;

    const needsImportedBy = !hasValue(row.imported_by);
    const needsOwner = !hasValue(row.owner);
    if (!needsImportedBy && !needsOwner) { skipped++; continue; }

    if (sample.length < 5) {
      sample.push({
        id: row.id,
        name: row.company_name || row.name,
        fills: {
          ...(needsImportedBy ? { imported_by: BACKFILL_EMAIL } : {}),
          ...(needsOwner ? { owner: BACKFILL_EMAIL } : {}),
        },
      });
    }

    if (!DRY_RUN) {
      try {
        // Read the full doc fresh at write time so we replace current state,
        // not the projection this scan started from.
        const pk = row.normalized_domain || row.id;
        const { resource: doc } = await container.item(row.id, pk).read();
        if (!doc) { failed++; continue; }

        if (!hasValue(doc.imported_by)) {
          doc.imported_by = BACKFILL_EMAIL;
          if (!hasValue(doc.imported_by_at)) {
            doc.imported_by_at = hasValue(doc.created_at) ? doc.created_at : null;
          }
        }
        if (!hasValue(doc.owner)) doc.owner = BACKFILL_EMAIL;

        await container.item(doc.id, pk).replace(doc);
        updated++;
      } catch (e) {
        failed++;
        if (failed <= 5) console.error(`Failed to write ${row.id}:`, e?.message || e);
      }
    } else {
      updated++;
    }

    if (updated % 200 === 0 && updated > 0) {
      console.log(`  ${updated} ${DRY_RUN ? "would update" : "updated"} so far (${total} scanned)…`);
    }
  }
}

console.log("");
console.log("=== Summary ===");
console.log(`Total scanned:        ${total}`);
console.log(`Would update / wrote: ${updated}`);
console.log(`Already attributed:   ${skipped}`);
console.log(`Failed:               ${failed}`);
console.log("");
console.log("Sample changes:");
for (const s of sample) console.log(" ", JSON.stringify(s));

if (DRY_RUN) {
  console.log("\nDry run only. Re-run with --apply to write to Cosmos.");
}
