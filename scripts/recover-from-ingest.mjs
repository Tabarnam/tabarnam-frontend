/**
 * Recovery script: restore company data from companies_ingest container.
 *
 * The migration script (migrate-logo-dark-variants.mjs) accidentally used
 * a partial SELECT + upsert, wiping all fields except:
 *   id, company_id, company_name, logo_url, logo_url_dark,
 *   normalized_domain, website_url, url, domain, updated_at
 *
 * This script reads full documents from companies_ingest and merges the
 * missing fields back into companies, preserving logo_url and logo_url_dark.
 *
 * Usage:
 *   node scripts/recover-from-ingest.mjs            # dry-run
 *   node scripts/recover-from-ingest.mjs --apply    # write changes
 *
 * Optional:
 *   --max=<n>         stop after processing n documents
 *   --pageSize=<n>    query page size (default 50)
 */

import { CosmosClient } from "@azure/cosmos";

const COSMOS_ENDPOINT = process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_ENDPOINT || "";
const COSMOS_KEY = process.env.COSMOS_DB_KEY || process.env.COSMOS_KEY || "";
const DATABASE_ID = process.env.COSMOS_DB_DATABASE || process.env.COSMOS_DB || "tabarnam-db";
const COMPANIES_CONTAINER = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";
const INGEST_CONTAINER = "companies_ingest";

function parseArgs(argv) {
  const out = { apply: false, max: null, pageSize: 50 };
  for (const raw of argv.slice(2)) {
    if (raw === "--apply") { out.apply = true; continue; }
    const [k, v] = raw.split("=", 2);
    if (k === "--max") {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out.max = Math.floor(n);
      continue;
    }
    if (k === "--pageSize") {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out.pageSize = Math.max(1, Math.min(500, Math.floor(n)));
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

/**
 * Detect if a company document was damaged by the migration.
 * Damaged docs only have the fields from the SELECT query.
 */
function isDamaged(doc) {
  // If the doc is missing most of these core fields, it was likely damaged
  const coreFields = [
    "industries",
    "product_keywords",
    "headquarters_location",
    "manufacturing_locations",
    "headquarters",
    "manufacturing_geocodes",
    "manufacturing_sites",
    "tagline",
    "company_tagline",
  ];
  const presentCount = coreFields.filter(f => doc[f] !== undefined && doc[f] !== null).length;
  return presentCount < 2; // If fewer than 2 core fields present, likely damaged
}

async function main() {
  const { apply, max, pageSize } = parseArgs(process.argv);

  if (!COSMOS_ENDPOINT || !COSMOS_KEY) {
    throw new Error("Missing COSMOS_DB_ENDPOINT/COSMOS_DB_KEY environment variables.");
  }

  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  if (max) console.log(`Max: ${max}`);

  const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
  const db = client.database(DATABASE_ID);
  const companiesContainer = db.container(COMPANIES_CONTAINER);
  const ingestContainer = db.container(INGEST_CONTAINER);

  // Step 1: Build a lookup map from companies_ingest keyed by normalized_domain
  console.log("\n=== Phase 1: Loading companies_ingest data ===");
  const ingestByDomain = new Map();
  const ingestById = new Map();

  const ingestQuery = "SELECT * FROM c";
  const ingestIterator = ingestContainer.items.query(ingestQuery, {
    enableCrossPartitionQuery: true,
    maxItemCount: 100,
  }).getAsyncIterator();

  let ingestCount = 0;
  for await (const { resources } of ingestIterator) {
    for (const doc of resources) {
      ingestCount++;
      const domain = doc.normalized_domain || toNormalizedDomain(doc.url || doc.website_url || "");
      if (domain && domain !== "unknown") {
        // If multiple ingest docs for same domain, keep the newest
        const existing = ingestByDomain.get(domain);
        if (!existing || (doc._ts || 0) > (existing._ts || 0)) {
          ingestByDomain.set(domain, doc);
        }
      }
      // Also index by company_id and id
      if (doc.company_id) ingestById.set(doc.company_id, doc);
      if (doc.id) ingestById.set(doc.id, doc);
    }
  }
  console.log(`  Loaded ${ingestCount} documents from companies_ingest`);
  console.log(`  Unique domains: ${ingestByDomain.size}`);

  // Step 2: Scan damaged companies and merge from ingest
  console.log("\n=== Phase 2: Scanning companies for damaged documents ===");

  const counters = { scanned: 0, damaged: 0, recovered: 0, no_match: 0, skipped_ok: 0, failed: 0 };

  const companiesQuery = "SELECT * FROM c";
  const companiesIterator = companiesContainer.items.query(companiesQuery, {
    enableCrossPartitionQuery: true,
    maxItemCount: pageSize,
  }).getAsyncIterator();

  for await (const { resources } of companiesIterator) {
    for (const doc of resources) {
      if (max && counters.scanned >= max) break;
      counters.scanned++;

      if (!isDamaged(doc)) {
        counters.skipped_ok++;
        continue;
      }

      counters.damaged++;
      const companyId = doc.company_id || doc.id;
      const domain = doc.normalized_domain || toNormalizedDomain(doc.website_url || doc.url || "");

      // Try to find matching ingest document
      let ingestDoc = ingestByDomain.get(domain) || ingestById.get(companyId) || ingestById.get(doc.id);

      if (!ingestDoc) {
        console.log(`  [no-match] ${companyId} (${domain}): no ingest data found`);
        counters.no_match++;
        continue;
      }

      // Merge: start with the ingest doc's data, then overlay the surviving
      // fields from the damaged doc (which include logo_url, logo_url_dark, etc.)
      // Cosmos system fields (_rid, _self, _etag, _ts, _attachments) come from
      // the companies doc so the upsert targets the correct document.
      const merged = {
        ...ingestDoc,          // Full data from ingest
        ...doc,                // Overlay surviving fields (id, company_id, normalized_domain, logo_url, logo_url_dark, etc.)
        // Restore fields from ingest that were wiped (only if missing in companies)
        industries: doc.industries || ingestDoc.industries,
        product_keywords: doc.product_keywords || ingestDoc.product_keywords,
        company_tagline: doc.company_tagline || ingestDoc.company_tagline,
        tagline: doc.tagline || ingestDoc.tagline,
        notes: doc.notes !== undefined ? doc.notes : ingestDoc.notes,
        headquarters_location: doc.headquarters_location || ingestDoc.headquarters_location,
        manufacturing_locations: doc.manufacturing_locations || ingestDoc.manufacturing_locations,
        headquarters: doc.headquarters || ingestDoc.headquarters,
        manufacturing_geocodes: doc.manufacturing_geocodes || ingestDoc.manufacturing_geocodes,
        manufacturing_sites: doc.manufacturing_sites || ingestDoc.manufacturing_sites,
        hq_lat: doc.hq_lat ?? ingestDoc.hq_lat,
        hq_lng: doc.hq_lng ?? ingestDoc.hq_lng,
        manu_lats: doc.manu_lats || ingestDoc.manu_lats,
        manu_lngs: doc.manu_lngs || ingestDoc.manu_lngs,
        amazon_url: doc.amazon_url || ingestDoc.amazon_url,
        amazon_store_url: doc.amazon_store_url || ingestDoc.amazon_store_url,
        email_address: doc.email_address || ingestDoc.email_address,
        red_flag: doc.red_flag ?? ingestDoc.red_flag,
        reviews: doc.reviews || ingestDoc.reviews,
        star_rating: doc.star_rating ?? ingestDoc.star_rating,
        star_overrides: doc.star_overrides ?? ingestDoc.star_overrides,
        star_notes: doc.star_notes || ingestDoc.star_notes,
        admin_manual_extra: doc.admin_manual_extra ?? ingestDoc.admin_manual_extra,
        review_count_approved: doc.review_count_approved ?? ingestDoc.review_count_approved,
        editorial_review_count: doc.editorial_review_count ?? ingestDoc.editorial_review_count,
        company_contact_info: doc.company_contact_info || ingestDoc.company_contact_info,
        logo_status: doc.logo_status || ingestDoc.logo_status || "imported",
        logo_approved: doc.logo_approved ?? ingestDoc.logo_approved,
        logo_source_url: doc.logo_source_url || ingestDoc.logo_source_url,
        logo_source_type: doc.logo_source_type || ingestDoc.logo_source_type,
        logo_import_status: doc.logo_import_status || ingestDoc.logo_import_status,
        session_id: doc.session_id || ingestDoc.session_id,
        created_at: doc.created_at || ingestDoc.created_at,
        updated_at: new Date().toISOString(),
        // Preserve logo fields from the migration
        logo_url: doc.logo_url,
        logo_url_dark: doc.logo_url_dark,
        // Keep the companies doc's system fields for correct upsert
        id: doc.id,
        _rid: doc._rid,
        _self: doc._self,
        _etag: doc._etag,
        _ts: doc._ts,
        _attachments: doc._attachments,
      };

      // Clean up: remove ingest-only system fields that shouldn't be in companies
      delete merged._rid;
      delete merged._self;
      delete merged._etag;
      delete merged._ts;
      delete merged._attachments;

      const fieldsRestored = [];
      if (ingestDoc.industries) fieldsRestored.push("industries");
      if (ingestDoc.headquarters_location || ingestDoc.headquarters) fieldsRestored.push("hq");
      if (ingestDoc.manufacturing_locations || ingestDoc.manufacturing_geocodes) fieldsRestored.push("mfg");
      if (ingestDoc.product_keywords) fieldsRestored.push("keywords");

      console.log(`  [recover] ${companyId} (${domain}): restored [${fieldsRestored.join(", ")}]`);

      if (apply) {
        try {
          let pk = merged.normalized_domain;
          if (!pk || String(pk).trim() === "") {
            pk = toNormalizedDomain(merged.website_url || merged.url || merged.domain || "");
          }
          await companiesContainer.items.upsert(merged, { partitionKey: pk });
        } catch (e) {
          console.error(`  [error] ${companyId}: ${e?.message || e}`);
          counters.failed++;
          continue;
        }
      }

      counters.recovered++;
    }
    if (max && counters.scanned >= max) break;
  }

  console.log("\n=== Summary ===");
  console.log(`  Scanned:        ${counters.scanned}`);
  console.log(`  Undamaged:      ${counters.skipped_ok}`);
  console.log(`  Damaged:        ${counters.damaged}`);
  console.log(`  Recovered:      ${counters.recovered}`);
  console.log(`  No match found: ${counters.no_match}`);
  console.log(`  Failed:         ${counters.failed}`);
  if (!apply) console.log("\n  (dry-run — no changes written. Use --apply to persist.)");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
