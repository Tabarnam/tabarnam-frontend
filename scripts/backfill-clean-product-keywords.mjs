/**
 * One-time bulk cleanup of JUNK product keywords stored on company docs.
 *
 * Re-runs every company's stored product list through the (now-fixed)
 * sanitizeKeywords — the SAME gate the import pipeline uses — and rewrites the
 * cleaned result. Kills nav labels ("Shop All", "Best Sellers"), stale
 * early-import junk ("Contact Us", "Press Releases"), SVG/CSS tokens, ALL-CAPS
 * labels, digit-noise ("Cart 0 00 0"), and too-short/symbol-only entries, while
 * preserving real products (including cookie/cartridge/contact-lens/filler/press
 * products the old substring bug used to strip).
 *
 * Only docs whose product list actually changes are written. After cleaning,
 * enrichment_health + sort keys (issues_count/qq_score) are refreshed so stored
 * state stays coherent — same as a normal save.
 *
 * Usage:
 *   node scripts/backfill-clean-product-keywords.mjs           # dry-run (no writes)
 *   node scripts/backfill-clean-product-keywords.mjs --apply   # write to Cosmos
 *
 * Required env: COSMOS_DB_ENDPOINT, COSMOS_DB_KEY
 */

import { CosmosClient } from "@azure/cosmos";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { sanitizeKeywords } = require("../api/_requiredFields.js");
const { applySortKeys } = require("../api/_sortKeys.js");
const { computeContractEnrichmentHealth } = require("../api/_contractHealth.js");

// sanitizeKeywords logs a line for every doc with rejections — mute that flood.
const _log = console.log;
console.log = (...a) => {
  if (typeof a[0] === "string" && a[0].startsWith("[sanitizeKeywords]")) return;
  _log(...a);
};

const ENDPOINT = process.env.COSMOS_DB_ENDPOINT || "";
const KEY = process.env.COSMOS_DB_KEY || "";
const DB = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const CONTAINER = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";
const DRY_RUN = !process.argv.includes("--apply");

if (!ENDPOINT || !KEY) {
  console.error("Missing COSMOS_DB_ENDPOINT or COSMOS_DB_KEY env vars");
  process.exit(1);
}

const container = new CosmosClient({ endpoint: ENDPOINT, key: KEY }).database(DB).container(CONTAINER);

console.log(DRY_RUN ? "=== DRY RUN (pass --apply to write) ===" : "=== APPLYING CHANGES ===");
console.log(`Cosmos: ${DB}/${CONTAINER}`);

const asStr = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
// The union of stored product entries a profile would show, trimmed + de-empty.
function storedProductList(doc) {
  const out = [];
  const pk = doc.product_keywords;
  if (typeof pk === "string") for (const s of pk.split(/\s*,\s*/g)) { const t = s.trim(); if (t) out.push(t); }
  else if (Array.isArray(pk)) for (const s of pk) { const t = asStr(s).trim(); if (t) out.push(t); }
  if (Array.isArray(doc.keywords)) for (const s of doc.keywords) { const t = asStr(s).trim(); if (t) out.push(t); }
  // Dedup case-insensitively, preserve first-seen order.
  const seen = new Set();
  const deduped = [];
  for (const t of out) { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); deduped.push(t); } }
  return deduped;
}

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
let changed = 0;
let emptied = 0;
let junkRemovedTotal = 0;
let failed = 0;
const sample = [];

while (queryIterator.hasMoreResults()) {
  const { resources } = await queryIterator.fetchNext();
  for (const doc of resources || []) {
    total++;

    const before = storedProductList(doc);
    if (before.length === 0) continue; // nothing stored to clean

    const sanitized = sanitizeKeywords({
      product_keywords: doc.product_keywords,
      keywords: doc.keywords,
    }).sanitized || [];

    // Change = the cleaned list differs from what's stored (junk removed / dedup).
    const sameAsBefore =
      sanitized.length === before.length &&
      sanitized.every((v, i) => v === before[i]);
    if (sameAsBefore) continue;

    const survivors = new Set(sanitized.map((s) => s.toLowerCase()));
    const removed = before.filter((s) => !survivors.has(s.toLowerCase()));
    if (removed.length === 0) continue; // only reordering/dedup, no junk — leave it

    changed++;
    junkRemovedTotal += removed.length;
    if (sanitized.length === 0) emptied++;

    if (sample.length < 25) {
      sample.push({
        name: doc.company_name || doc.name,
        removed: removed.slice(0, 8),
        kept: sanitized.length,
      });
    }

    if (!DRY_RUN) {
      doc.keywords = sanitized;
      doc.product_keywords = sanitized.join(", ");
      // Force the meaningful-keyword cache to recompute from the cleaned list.
      delete doc._kwCacheKey;
      delete doc._kwRelevantCount;
      try {
        const freshHealth = computeContractEnrichmentHealth(doc);
        if (freshHealth && typeof freshHealth === "object") doc.enrichment_health = freshHealth;
      } catch { /* keep existing health on failure */ }
      try {
        applySortKeys(doc);
        await container.item(doc.id, doc.normalized_domain || doc.id).replace(doc);
      } catch {
        try {
          applySortKeys(doc);
          await container.items.upsert(doc);
        } catch (e2) {
          failed++;
          if (failed <= 5) console.error(`Failed to write ${doc.id}:`, e2?.message || e2);
        }
      }
    }

    if (changed % 100 === 0) console.log(`  ${changed} cleaned so far (${total} scanned)…`);
  }
}

console.log("");
console.log("=== Summary ===");
console.log(`Total scanned:               ${total}`);
console.log(`Companies with junk removed: ${changed}`);
console.log(`  of those emptied entirely: ${emptied}  (every stored 'product' was junk)`);
console.log(`Total junk entries removed:  ${junkRemovedTotal}`);
console.log(`Failed writes:               ${failed}`);
console.log("");
console.log("Sample (removed → kept count):");
for (const s of sample) console.log(`  ${s.name}: kill [${s.removed.join(" | ")}] → ${s.kept} real products kept`);

if (DRY_RUN) console.log("\nDry run only. Re-run with --apply to write to Cosmos.");
