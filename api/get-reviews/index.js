// api/get-reviews/index.js
// Fetch reviews for a company (user-submitted + curated reviews)

const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

const cors = (req) => {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
};

const json = (obj, status = 200, req) => ({
  status,
  headers: { ...cors(req), "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

let cosmosClient = null;

function getReviewsContainer() {
  const endpoint = E("COSMOS_DB_ENDPOINT");
  const key = E("COSMOS_DB_KEY");
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_REVIEWS_CONTAINER", "reviews");

  if (!endpoint || !key) return null;
  cosmosClient ||= new CosmosClient({ endpoint, key });
  return cosmosClient.database(databaseId).container(containerId);
}

function getCompaniesContainer() {
  const endpoint = E("COSMOS_DB_ENDPOINT");
  const key = E("COSMOS_DB_KEY");
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_COMPANIES_CONTAINER", "companies");

  if (!endpoint || !key) return null;
  cosmosClient ||= new CosmosClient({ endpoint, key });
  return cosmosClient.database(databaseId).container(containerId);
}

app.http("get-reviews", {
  route: "get-reviews",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return json({}, 204, req);
    }

    if (method !== "GET") {
      return json({ error: "Method not allowed" }, 405, req);
    }

    const url = new URL(req.url);
    const company = (url.searchParams.get("company") || "").trim();

    if (!company) {
      return json({ error: "company parameter required" }, 400, req);
    }

    try {
      const reviewsContainer = getReviewsContainer();
      const companiesContainer = getCompaniesContainer();

      let allReviews = [];

      // 1. Fetch user-submitted reviews
      if (reviewsContainer) {
        try {
          const sql = `SELECT * FROM c WHERE c.company_name = @company ORDER BY c.created_at DESC`;
          const { resources } = await reviewsContainer.items
            .query(
              { query: sql, parameters: [{ name: "@company", value: company }] },
              { enableCrossPartitionQuery: true }
            )
            .fetchAll();

          const userReviews = (resources || []).map((r) => ({
            id: r.id,
            source: r.user_name ? `${r.user_name}${r.user_location ? ` (${r.user_location})` : ""}` : "Anonymous User",
            abstract: r.text,
            url: null,
            rating: r.rating,
            type: "user",
            created_at: r.created_at,
            flagged_bot: r.flagged_bot,
          }));

          allReviews = allReviews.concat(userReviews);
        } catch (e) {
          context.log("Warning: Failed to fetch user reviews:", e?.message);
        }
      }

      // 2. Fetch curated reviews from company record
      if (companiesContainer) {
        try {
          const sql = `SELECT c.company_name, c.curated_reviews FROM c WHERE c.company_name = @company`;
          const { resources } = await companiesContainer.items
            .query(
              { query: sql, parameters: [{ name: "@company", value: company }] },
              { enableCrossPartitionQuery: true }
            )
            .fetchAll();

          if (resources && resources.length > 0) {
            const company_record = resources[0];
            if (Array.isArray(company_record.curated_reviews)) {
              const curatedReviews = company_record.curated_reviews.map((r, idx) => ({
                id: `curated-${company}-${idx}`,
                source: r.source || "Unknown Source",
                abstract: r.abstract || "",
                url: r.url || null,
                rating: r.rating || null,
                type: "curated",
                created_at: r.created_at || null,
                last_updated_at: r.last_updated_at || null,
              }));
              allReviews = allReviews.concat(curatedReviews);
            }
          }
        } catch (e) {
          context.log("Warning: Failed to fetch curated reviews:", e?.message);
        }
      }

      // Sort: curated first (most recent), then user reviews
      allReviews.sort((a, b) => {
        const aType = a.type === "curated" ? 0 : 1;
        const bType = b.type === "curated" ? 0 : 1;
        if (aType !== bType) return aType - bType;
        return new Date(b.created_at || 0) - new Date(a.created_at || 0);
      });

      return json(
        {
          company,
          reviews: allReviews,
          count: allReviews.length,
        },
        200,
        req
      );
    } catch (e) {
      context.log("Error fetching reviews:", e?.message || e);
      return json({ error: e?.message || "Failed to fetch reviews" }, 500, req);
    }
  },
});
