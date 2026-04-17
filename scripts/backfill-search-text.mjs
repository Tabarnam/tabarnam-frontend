/**
 * Backfill search_text_norm / search_text_compact / search_text_stemmed /
 * search_text_stemmed_compact for every company using the current normalizer
 * (with diacritic folding). Needed because existing records were written with
 * the old broken normalizer that deleted accented chars (e.g. "Béis" → "bis").
 *
 * Usage:
 *   node scripts/backfill-search-text.mjs           # dry-run (no writes)
 *   node scripts/backfill-search-text.mjs --apply   # apply changes to Cosmos
 */

import { CosmosClient } from "@azure/cosmos";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Reuse the shipped backend helper so the script stays in sync with search-companies.
const { computeSearchText } = require("../api/_computeSearchText.js");

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

console.log(DRY_RUN ? "=== DRY RUN (pass --apply to write) ===" : "=== APPLYING CHANGES ===");
console.log(`Database: ${DATABASE_ID}, Container: ${CONTAINER_ID}`);

const queryIterator = container.items.query({
  query:
    "SELECT * FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted = false) " +
    "AND NOT STARTSWITH(c.id, 'refresh_job_') " +
    "AND NOT STARTSWITH(c.id, '_import_') " +
    "AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')",
});

let total = 0;
let updated = 0;
let unchanged = 0;
let errors = 0;
const diacriticExamples = [];

while (queryIterator.hasMoreResults()) {
  const { resources: companies } = await queryIterator.fetchNext();
  if (!companies || companies.length === 0) break;

  for (const company of companies) {
    total++;

    const next = computeSearchText(company);

    const changed =
      company.search_text_norm !== next.search_text_norm ||
      company.search_text_compact !== next.search_text_compact ||
      company.search_text_stemmed !== next.search_text_stemmed ||
      company.search_text_stemmed_compact !== next.search_text_stemmed_compact;

    if (!changed) {
      unchanged++;
      continue;
    }

    // Flag records whose change includes an accented letter — those are the
    // ones that were actively broken and are most interesting to eyeball.
    const nameForLog =
      company.company_name || company.display_name || company.name || company.normalized_domain || "(unknown)";
    const hadDiacritic = /[\u00C0-\u024F]/.test(
      [company.company_name, company.display_name, company.name].filter(Boolean).join(" ")
    );
    if (hadDiacritic && diacriticExamples.length < 20) {
      diacriticExamples.push({
        name: nameForLog,
        oldNorm: company.search_text_norm,
        newNorm: next.search_text_norm,
      });
    }

    updated++;

    if (!DRY_RUN) {
      try {
        company.search_text_norm = next.search_text_norm;
        company.search_text_compact = next.search_text_compact;
        company.search_text_stemmed = next.search_text_stemmed;
        company.search_text_stemmed_compact = next.search_text_stemmed_compact;
        company.updated_at = new Date().toISOString();

        const pk = String(company.normalized_domain || company.id || "unknown").trim();
        await container.items.upsert(company, { partitionKey: pk });
      } catch (e) {
        errors++;
        console.error(`  ERROR: ${nameForLog}: ${e.message}`);
      }
    }

    if (updated % 100 === 0) {
      console.log(`  progress: total=${total} updated=${updated} unchanged=${unchanged} errors=${errors}`);
    }
  }
}

console.log("");
console.log(`Done. Total: ${total}, Updated: ${updated}, Unchanged: ${unchanged}, Errors: ${errors}`);

if (diacriticExamples.length) {
  console.log("");
  console.log(`Accented-name examples (${diacriticExamples.length} shown):`);
  for (const ex of diacriticExamples) {
    console.log(`  ${ex.name}`);
    console.log(`    old: ${JSON.stringify(ex.oldNorm)}`);
    console.log(`    new: ${JSON.stringify(ex.newNorm)}`);
  }
}

if (DRY_RUN) console.log("\n(dry run — no changes written. Pass --apply to write.)");
