/**
 * clear-all-scores.mjs
 *
 * Clear star4/star5 scores and reasoning on every company that currently has
 * rating.star4.value > 0. This makes them "missing" again so the existing
 * backfill pipeline at /admin/backfill-scores picks them up for rescoring
 * under the current (cc905c76+) prompt rules.
 *
 * Only touches rating.star4 and rating.star5 — leaves star1 (mfg), star2 (hq),
 * star3 (reviews), rating_icon_type, and all other company fields untouched.
 * On star4/star5 objects themselves: clears .value and .reasoning, preserves
 * .notes, .icon_type, and any other fields.
 *
 * Usage:
 *   # Dry run (default) — just prints what would change
 *   node scripts/clear-all-scores.mjs
 *
 *   # Actually write
 *   node scripts/clear-all-scores.mjs --apply
 *
 * Env:
 *   COSMOS_DB_ENDPOINT  (required)
 *   COSMOS_DB_KEY       (required)
 *   COSMOS_DB_DATABASE           default: tabarnam-db
 *   COSMOS_DB_COMPANIES_CONTAINER default: companies
 */
import { CosmosClient } from "@azure/cosmos";

const endpoint = process.env.COSMOS_DB_ENDPOINT;
const key = process.env.COSMOS_DB_KEY;
if (!endpoint || !key) {
  console.error("Missing COSMOS_DB_ENDPOINT or COSMOS_DB_KEY env var");
  process.exit(1);
}

const apply = process.argv.includes("--apply");
const client = new CosmosClient({ endpoint, key });
const container = client
  .database(process.env.COSMOS_DB_DATABASE || "tabarnam-db")
  .container(process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies");

console.log(`Mode: ${apply ? "APPLY (will write)" : "DRY RUN (no writes)"}`);
console.log("");

// Match the backfill's own filter exactly: skip deleted, import controls, refresh jobs.
const query = `SELECT * FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND NOT STARTSWITH(c.id, 'refresh_job_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')`;

const { resources } = await container.items
  .query(query, { enableCrossPartitionQuery: true })
  .fetchAll();

const scored = (resources || []).filter((r) => {
  const v =
    r && r.rating && typeof r.rating === "object" && !Array.isArray(r.rating) && r.rating.star4 && typeof r.rating.star4 === "object"
      ? r.rating.star4.value
      : undefined;
  return typeof v === "number" && v > 0;
});

console.log(`Found ${scored.length} scored companies to clear.`);
console.log("");

let ok = 0;
let fail = 0;
const failures = [];

for (const c of scored) {
  const name = c.company_name || c.name || c.id;
  const oldS4 = c.rating?.star4?.value;
  const oldS5 = c.rating?.star5?.value;

  // Preserve all existing fields on star4/star5 (notes, icon_type, etc.);
  // only clear value → 0 and drop reasoning. This avoids wiping future-added
  // fields we don't explicitly know about.
  const existingStar4 = (c.rating?.star4 && typeof c.rating.star4 === "object") ? c.rating.star4 : {};
  const existingStar5 = (c.rating?.star5 && typeof c.rating.star5 === "object") ? c.rating.star5 : {};
  const { reasoning: _r4, ...star4Rest } = existingStar4;
  const { reasoning: _r5, ...star5Rest } = existingStar5;
  const newStar4 = { ...star4Rest, value: 0 };
  const newStar5 = { ...star5Rest, value: 0 };

  const updated = {
    ...c,
    rating: {
      ...c.rating,
      star4: newStar4,
      star5: newStar5,
    },
    updated_at: new Date().toISOString(),
  };

  if (!apply) {
    console.log(`[dry] ${name} (${c.normalized_domain || c.domain || "?"}): ${oldS4?.toFixed(2)}/${oldS5?.toFixed(2)} → 0.00/0.00`);
    ok++;
    continue;
  }

  const pk = String(c.normalized_domain || "unknown").trim();
  try {
    await container.items.upsert(updated, { partitionKey: pk });
    console.log(`[ok] ${name}: cleared`);
    ok++;
  } catch (e) {
    console.error(`[fail] ${name}: ${e?.message || e}`);
    failures.push({ id: c.id, name, error: String(e?.message || e) });
    fail++;
  }
}

console.log("");
console.log(`Done. ${apply ? "Wrote" : "Would write"} ${ok} companies. ${fail} failed.`);
if (failures.length > 0) {
  console.log("");
  console.log("Failures:");
  for (const f of failures) console.log(`  ${f.name} (${f.id}): ${f.error}`);
  process.exit(1);
}
