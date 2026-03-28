/**
 * Restore company data from backup account (tabarnamcosmos2356-r1).
 *
 * Reads full documents from the restored backup account and merges them
 * into the live account, preserving logo_url and logo_url_dark from the
 * live account (which were set by the migration).
 *
 * Usage:
 *   node scripts/restore-from-backup.mjs            # dry-run
 *   node scripts/restore-from-backup.mjs --apply    # write changes
 *
 * Optional:
 *   --max=<n>         stop after processing n documents
 */

import { CosmosClient } from "@azure/cosmos";

// Live account
const LIVE_ENDPOINT = process.env.COSMOS_DB_ENDPOINT || "";
const LIVE_KEY = process.env.COSMOS_DB_KEY || "";

// Restored backup account
const BACKUP_ENDPOINT = process.env.BACKUP_COSMOS_ENDPOINT || "";
const BACKUP_KEY = process.env.BACKUP_COSMOS_KEY || "";

const DATABASE_ID = "tabarnam-db";
const CONTAINER_ID = "companies";

function parseArgs(argv) {
  const out = { apply: false, max: null };
  for (const raw of argv.slice(2)) {
    if (raw === "--apply") { out.apply = true; continue; }
    const [k, v] = raw.split("=", 2);
    if (k === "--max") {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out.max = Math.floor(n);
      continue;
    }
    throw new Error(`Unknown argument: ${raw}`);
  }
  return out;
}

function toNormalizedDomain(input = "") {
  try {
    const u = String(input || "").trim();
    if (!u) return "unknown";
    const parsed = u.startsWith("http") ? new URL(u) : new URL(`https://${u}`);
    let h = parsed.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h || "unknown";
  } catch { return "unknown"; }
}

async function main() {
  const { apply, max } = parseArgs(process.argv);

  if (!LIVE_ENDPOINT || !LIVE_KEY) {
    throw new Error("Missing COSMOS_DB_ENDPOINT / COSMOS_DB_KEY for live account.");
  }
  if (!BACKUP_ENDPOINT || !BACKUP_KEY) {
    throw new Error("Missing BACKUP_COSMOS_ENDPOINT / BACKUP_COSMOS_KEY for restored backup account.");
  }

  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  if (max) console.log(`Max: ${max}`);

  const liveClient = new CosmosClient({ endpoint: LIVE_ENDPOINT, key: LIVE_KEY });
  const liveContainer = liveClient.database(DATABASE_ID).container(CONTAINER_ID);

  const backupClient = new CosmosClient({ endpoint: BACKUP_ENDPOINT, key: BACKUP_KEY });
  const backupContainer = backupClient.database(DATABASE_ID).container(CONTAINER_ID);

  // Step 1: Build a map of live docs to get logo_url and logo_url_dark
  console.log("\n=== Phase 1: Loading logo URLs from live account ===");
  const liveLogoMap = new Map(); // keyed by doc id

  const liveQuery = `
    SELECT c.id, c.company_id, c.logo_url, c.logo_url_dark, c.normalized_domain
    FROM c
    WHERE IS_DEFINED(c.logo_url) AND c.logo_url != null AND c.logo_url != ""
  `;
  const liveIterator = liveContainer.items.query(liveQuery, {
    enableCrossPartitionQuery: true,
    maxItemCount: 200,
  }).getAsyncIterator();

  let liveCount = 0;
  for await (const { resources } of liveIterator) {
    for (const doc of resources) {
      liveCount++;
      liveLogoMap.set(doc.id, {
        logo_url: doc.logo_url || "",
        logo_url_dark: doc.logo_url_dark || "",
      });
    }
  }
  console.log(`  Loaded ${liveCount} logo URLs from live account`);

  // Step 2: Read all docs from backup and restore to live
  console.log("\n=== Phase 2: Restoring from backup ===");
  const counters = { scanned: 0, restored: 0, skipped: 0, failed: 0 };

  const backupQuery = "SELECT * FROM c";
  const backupIterator = backupContainer.items.query(backupQuery, {
    enableCrossPartitionQuery: true,
    maxItemCount: 50,
  }).getAsyncIterator();

  for await (const { resources } of backupIterator) {
    for (const backupDoc of resources) {
      if (max && counters.scanned >= max) break;
      counters.scanned++;

      const docId = backupDoc.id;

      // Skip non-company documents (import tracking docs, etc.)
      if (docId && docId.startsWith("_import_")) {
        counters.skipped++;
        continue;
      }

      // Get logo URLs from live account (these were set by the migration)
      const liveLogos = liveLogoMap.get(docId);

      // Build merged document: backup data + live logo URLs
      const merged = { ...backupDoc };

      // Remove Cosmos system fields (they'll be regenerated on upsert)
      delete merged._rid;
      delete merged._self;
      delete merged._etag;
      delete merged._ts;
      delete merged._attachments;

      // Overlay logo URLs from live account if they exist
      if (liveLogos) {
        if (liveLogos.logo_url) merged.logo_url = liveLogos.logo_url;
        if (liveLogos.logo_url_dark) merged.logo_url_dark = liveLogos.logo_url_dark;
      }

      merged.updated_at = new Date().toISOString();

      if (apply) {
        try {
          let pk = merged.normalized_domain;
          if (!pk || String(pk).trim() === "") {
            pk = toNormalizedDomain(merged.website_url || merged.url || merged.domain || "");
          }
          await liveContainer.items.upsert(merged, { partitionKey: pk });
        } catch (e) {
          console.error(`  [error] ${docId}: ${e?.message || e}`);
          counters.failed++;
          continue;
        }
      }

      counters.restored++;
      const companyName = merged.company_name || merged.name || docId;
      const domain = merged.normalized_domain || "";
      const hasLogo = liveLogos ? "logo preserved" : "no logo";
      console.log(`  [restored] ${companyName} (${domain}) — ${hasLogo}`);

      if (counters.restored % 500 === 0) {
        console.log(`  ... processed ${counters.restored} documents`);
      }
    }
    if (max && counters.scanned >= max) break;
  }

  console.log("\n=== Summary ===");
  console.log(`  Scanned:  ${counters.scanned}`);
  console.log(`  Restored: ${counters.restored}`);
  console.log(`  Skipped:  ${counters.skipped}`);
  console.log(`  Failed:   ${counters.failed}`);
  if (!apply) console.log("\n  (dry-run — no changes written. Use --apply to persist.)");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
