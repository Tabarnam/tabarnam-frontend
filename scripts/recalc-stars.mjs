/**
 * Retroactive star recalculation: HQ=0.5, Manufacturing=0.5, Review=1.0
 *
 * Usage:
 *   node scripts/recalc-stars.mjs           # dry-run (no writes)
 *   node scripts/recalc-stars.mjs --apply   # apply changes to Cosmos
 */

import { CosmosClient } from "@azure/cosmos";

const COSMOS_ENDPOINT = process.env.COSMOS_DB_ENDPOINT || "";
const COSMOS_KEY = process.env.COSMOS_DB_KEY || "";
const DRY_RUN = !process.argv.includes("--apply");

if (!COSMOS_ENDPOINT || !COSMOS_KEY) {
  console.error("Missing COSMOS_DB_ENDPOINT or COSMOS_DB_KEY env vars");
  process.exit(1);
}

const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
const container = client.database("tabarnam-db").container("companies");

console.log(DRY_RUN ? "=== DRY RUN (pass --apply to write) ===" : "=== APPLYING CHANGES ===");

const queryIterator = container.items.query({
  query: "SELECT * FROM c WHERE NOT IS_DEFINED(c.is_deleted) OR c.is_deleted = false",
});

let total = 0;
let updated = 0;
let errors = 0;

while (queryIterator.hasMoreResults()) {
  const { resources: companies } = await queryIterator.fetchNext();
  if (!companies || companies.length === 0) break;

  for (const company of companies) {
    total++;

    const hasManufacturing =
      Array.isArray(company.manufacturing_locations) && company.manufacturing_locations.length > 0;
    const hasHQ =
      (Array.isArray(company.manufacturing_locations) && company.manufacturing_locations.some(loc => loc.is_hq === true)) ||
      !!(company.headquarters_location && String(company.headquarters_location).trim());
    const hasReviews =
      (company.review_count || 0) >= 1 ||
      (company.editorial_review_count || 0) >= 1 ||
      (company.review_count_approved || 0) >= 1 ||
      (Array.isArray(company.curated_reviews) && company.curated_reviews.length > 0) ||
      (Array.isArray(company.reviews) && company.reviews.length > 0);

    const autoStars = Math.min(2, (hasHQ ? 0.5 : 0) + (hasManufacturing ? 0.5 : 0) + (hasReviews ? 1 : 0));

    const existingRating = company.rating && typeof company.rating === "object" ? company.rating : {};
    const star1 = existingRating.star1 && typeof existingRating.star1 === "object" ? existingRating.star1 : { value: 0, notes: [] };
    const star2 = existingRating.star2 && typeof existingRating.star2 === "object" ? existingRating.star2 : { value: 0, notes: [] };
    const star3 = existingRating.star3 && typeof existingRating.star3 === "object" ? existingRating.star3 : { value: 0, notes: [] };

    const newRating = {
      ...existingRating,
      star1: { ...star1, value: hasManufacturing ? 0.5 : 0.0 },
      star2: { ...star2, value: hasHQ ? 0.5 : 0.0 },
      star3: { ...star3, value: hasReviews ? 1.0 : star3.value },
    };

    const ratingChanged = JSON.stringify(company.rating) !== JSON.stringify(newRating);
    const starsChanged = company.auto_star_rating !== autoStars;

    if (!ratingChanged && !starsChanged) continue;

    updated++;
    const name = company.company_name || company.name || company.normalized_domain || "(unknown)";
    console.log(`  [${updated}] ${name}: auto_star ${company.auto_star_rating ?? "?"} → ${autoStars}, star1=${star1.value}→${hasManufacturing ? 0.5 : 0}, star2=${star2.value}→${hasHQ ? 0.5 : 0}`);

    if (!DRY_RUN) {
      try {
        company.rating = newRating;
        company.auto_star_rating = autoStars;
        if (!company.star_rating || company.star_rating <= autoStars) {
          company.star_rating = autoStars;
        }
        company.updated_at = new Date().toISOString();

        const pk = String(company.normalized_domain || "unknown").trim();
        await container.items.upsert(company, { partitionKey: pk });
      } catch (e) {
        errors++;
        console.error(`    ERROR: ${name}: ${e.message}`);
      }
    }
  }
}

console.log(`\nDone. Total: ${total}, Updated: ${updated}, Errors: ${errors}`);
if (DRY_RUN) console.log("(dry run — no changes written. Pass --apply to write.)");
