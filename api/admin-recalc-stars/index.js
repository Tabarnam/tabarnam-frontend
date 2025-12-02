import { app } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';

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
  cosmosClient ||= new CosmosClient({ endpoint, key });
  return cosmosClient;
}

function getCompaniesContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_COMPANIES_CONTAINER", "companies");
  return client.database(databaseId).container(containerId);
}

function calculateBinaryStars(company, minReviews = 3, reviewThreshold = 4) {
  let stars = 0;

  if (company.manufacturing_locations && company.manufacturing_locations.length > 0) {
    const hasHQ = company.manufacturing_locations.some(loc => loc.is_hq === true);
    if (hasHQ) stars += 1;
  }

  if (company.manufacturing_locations && company.manufacturing_locations.length > 0) {
    const hasNonHQ = company.manufacturing_locations.some(loc => loc.is_hq !== true);
    if (hasNonHQ) stars += 1;
  }

  if (company.review_count >= minReviews && company.avg_rating >= reviewThreshold) {
    stars += 1;
  }

  return Math.min(3, Math.max(0, stars));
}

export default app.http('adminRecalcStars', {
  route: 'admin-recalc-stars',
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
}, async (req, context) => {
  const method = String(req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return {
      status: 204,
      headers: getCorsHeaders(),
    };
  }

  const companiesContainer = getCompaniesContainer();
  if (!companiesContainer) {
    return json({ error: "Cosmos DB not configured" }, 500);
  }

  try {
    const { resources: companies } = await companiesContainer.items
      .query({ query: "SELECT * FROM c WHERE NOT IS_DEFINED(c.is_deleted) OR c.is_deleted = false" })
      .fetchAll();

    let updated = 0;

    for (const company of companies) {
      const binaryStars = calculateBinaryStars(company, 3, 4);
      if (company.auto_star_rating !== binaryStars) {
        company.auto_star_rating = binaryStars;
        if (!company.star_rating || company.star_rating <= binaryStars) {
          company.star_rating = binaryStars;
        }
        company.updated_at = new Date().toISOString();

        const partitionKeyValue = String(company.normalized_domain || "unknown").trim();
        await companiesContainer.items.upsert(company, { partitionKey: partitionKeyValue });
        updated += 1;
      }
    }

    return json({ ok: true, updated }, 200);
  } catch (e) {
    context.log("Error in admin-recalc-stars:", e?.message || e);
    return json({ error: e?.message || "Internal error" }, 500);
  }
});
