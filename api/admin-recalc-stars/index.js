const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

const json = (obj, status = 200) => ({
  status,
  headers: getCorsHeaders(),
  body: JSON.stringify(obj),
});

let cosmosClient = null;

function getCosmosClient() {
  const endpoint = E("COSMOS_DB_ENDPOINT");
  const key = E("COSMOS_DB_KEY");
  if (!endpoint || !key) return null;
  cosmosClient ||= require("../_cosmosConfig").getCosmosClient();
  return cosmosClient;
}

function getCompaniesContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_COMPANIES_CONTAINER", "companies");
  return client.database(databaseId).container(containerId);
}

function calculateAutoStars(company) {
  let stars = 0;

  // HQ: 0.5 stars if any HQ location exists
  const hasHQ =
    (Array.isArray(company.manufacturing_locations) && company.manufacturing_locations.some(loc => loc.is_hq === true)) ||
    !!(company.headquarters_location && String(company.headquarters_location).trim());
  if (hasHQ) stars += 0.5;

  // Manufacturing: 0.5 stars if any manufacturing location exists
  const hasManufacturing =
    Array.isArray(company.manufacturing_locations) && company.manufacturing_locations.length > 0;
  if (hasManufacturing) stars += 0.5;

  // Reviews: 1 star if any reviews exist
  const hasReviews =
    (company.review_count || 0) >= 1 ||
    (company.editorial_review_count || 0) >= 1 ||
    (company.review_count_approved || 0) >= 1 ||
    (Array.isArray(company.curated_reviews) && company.curated_reviews.length > 0) ||
    (Array.isArray(company.reviews) && company.reviews.length > 0);
  if (hasReviews) stars += 1;

  return Math.min(2, Math.max(0, stars));
}

async function adminRecalcStarsHandler(req, context) {
  const method = String(req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return {
      status: 200,
      headers: getCorsHeaders(),
    };
  }

  const companiesContainer = getCompaniesContainer();
  if (!companiesContainer) {
    return json({ error: "Cosmos DB not configured" }, 500);
  }

  try {
    let updated = 0;
    let total = 0;
    const queryIterator = companiesContainer.items
      .query({ query: "SELECT * FROM c WHERE NOT IS_DEFINED(c.is_deleted) OR c.is_deleted = false" });

    // Process in pages to avoid memory/timeout issues
    while (queryIterator.hasMoreResults()) {
      const { resources: companies } = await queryIterator.fetchNext();
      if (!companies || companies.length === 0) break;
      total += companies.length;

    for (const company of companies) {
      const autoStars = calculateAutoStars(company);

      // Recalculate the rating object with new weights
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

      if (ratingChanged || starsChanged) {
        company.rating = newRating;
        company.auto_star_rating = autoStars;
        if (!company.star_rating || company.star_rating <= autoStars) {
          company.star_rating = autoStars;
        }
        company.updated_at = new Date().toISOString();

        const partitionKeyValue = String(company.normalized_domain || "unknown").trim();
        await companiesContainer.items.upsert(company, { partitionKey: partitionKeyValue });
        updated += 1;
      }
    }

    } // end while pages

    return json({ ok: true, updated, total }, 200);
  } catch (e) {
    context.log("Error in admin-recalc-stars:", e?.message || e, e?.stack || "");
    return json({ error: e?.message || "Internal error", stack: e?.stack || "" }, 500);
  }
}

app.http('adminRecalcStars', {
  route: 'xadmin-api-recalc-stars',
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: require("../_adminAuth").withAdminGuard(adminRecalcStarsHandler),
});

module.exports = { handler: adminRecalcStarsHandler };
