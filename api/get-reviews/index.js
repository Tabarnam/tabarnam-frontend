// api/get-reviews/index.js
// Fetch reviews for a company (user-submitted + curated reviews)

const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

const cors = (req) => {
  const origin = req?.headers?.get?.("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
};

const json = (obj, status = 200, req) => ({
  status,
  headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
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

async function resolveCompanyName(params, companiesContainer, context) {
  const company = String(params.company || "").trim();
  if (company) return company;

  const companyId = String(params.company_id || params.id || "").trim();
  if (companyId && companiesContainer) {
    try {
      const sql = `SELECT TOP 1 c.company_name FROM c WHERE c.id = @id`;
      const { resources } = await companiesContainer.items
        .query(
          { query: sql, parameters: [{ name: "@id", value: companyId }] },
          { enableCrossPartitionQuery: true }
        )
        .fetchAll();

      const name = resources?.[0]?.company_name;
      if (typeof name === "string" && name.trim()) return name.trim();
    } catch (e) {
      context?.log?.("Warning: Failed to resolve company_id:", e?.message || e);
    }
  }

  const normalizedDomain = String(params.normalized_domain || params.domain || "").trim().toLowerCase();
  if (normalizedDomain && companiesContainer) {
    try {
      const sql = `SELECT TOP 1 c.company_name FROM c WHERE LOWER(c.normalized_domain) = @domain`;
      const { resources } = await companiesContainer.items
        .query(
          { query: sql, parameters: [{ name: "@domain", value: normalizedDomain }] },
          { enableCrossPartitionQuery: true }
        )
        .fetchAll();

      const name = resources?.[0]?.company_name;
      if (typeof name === "string" && name.trim()) return name.trim();
    } catch (e) {
      context?.log?.("Warning: Failed to resolve normalized_domain:", e?.message || e);
    }
  }

  return "";
}

async function getReviewsHandler(req, context, deps = {}) {
  const method = String(req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return json({}, 204, req);
  }

  if (method !== "GET") {
    return json({ ok: false, error: "Method not allowed" }, 405, req);
  }

  const url = new URL(req.url);

  const reviewsContainer = deps.reviewsContainer ?? getReviewsContainer();
  const companiesContainer = deps.companiesContainer ?? getCompaniesContainer();

  const companyName = await resolveCompanyName(
    {
      company: url.searchParams.get("company"),
      company_id: url.searchParams.get("company_id"),
      id: url.searchParams.get("id"),
      normalized_domain: url.searchParams.get("normalized_domain"),
      domain: url.searchParams.get("domain"),
    },
    companiesContainer,
    context
  );

  if (!companyName) {
    return json({ ok: false, error: "company parameter required" }, 400, req);
  }

  try {
    let allReviews = [];

    // 1) user-submitted reviews
    if (reviewsContainer) {
      try {
        const sql = `SELECT * FROM c WHERE c.company_name = @company ORDER BY c.created_at DESC`;
        const { resources } = await reviewsContainer.items
          .query(
            { query: sql, parameters: [{ name: "@company", value: companyName }] },
            { enableCrossPartitionQuery: true }
          )
          .fetchAll();

        const userReviews = (resources || []).map((r) => ({
          id: r.id,
          source: r.user_name
            ? `${r.user_name}${r.user_location ? ` (${r.user_location})` : ""}`
            : "Anonymous User",
          abstract: r.text,
          url: null,
          rating: r.rating,
          type: "user",
          created_at: r.created_at,
          flagged_bot: r.flagged_bot,
          bot_reason: r.bot_reason,
        }));

        allReviews = allReviews.concat(userReviews);
      } catch (e) {
        context?.log?.("Warning: Failed to fetch user reviews:", e?.message || e);
      }
    }

    // 2) curated reviews from company record
    if (companiesContainer) {
      try {
        const sql = `SELECT c.company_name, c.curated_reviews FROM c WHERE c.company_name = @company`;
        const { resources } = await companiesContainer.items
          .query(
            { query: sql, parameters: [{ name: "@company", value: companyName }] },
            { enableCrossPartitionQuery: true }
          )
          .fetchAll();

        if (resources && resources.length > 0) {
          const companyRecord = resources[0];
          if (Array.isArray(companyRecord.curated_reviews)) {
            const curatedReviews = companyRecord.curated_reviews.map((r, idx) => ({
              id: `curated-${companyName}-${idx}`,
              source: r.source || "Unknown Source",
              abstract: r.abstract || r.excerpt || "",
              url: r.url || r.source_url || null,
              rating: r.rating || null,
              type: "curated",
              created_at: r.created_at || null,
              last_updated_at: r.last_updated_at || null,
            }));

            allReviews = allReviews.concat(curatedReviews);
          }
        }
      } catch (e) {
        context?.log?.("Warning: Failed to fetch curated reviews:", e?.message || e);
      }
    }

    // curated first, then user reviews; newest first within type
    allReviews.sort((a, b) => {
      const aType = a.type === "curated" ? 0 : 1;
      const bType = b.type === "curated" ? 0 : 1;
      if (aType !== bType) return aType - bType;
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });

    return json(
      {
        ok: true,
        company: companyName,
        company_name: companyName,
        items: allReviews,
        reviews: allReviews,
        count: allReviews.length,
      },
      200,
      req
    );
  } catch (e) {
    context?.log?.("Error fetching reviews:", e?.message || e);
    return json({ ok: false, error: e?.message || "Failed to fetch reviews" }, 500, req);
  }
}

app.http("get-reviews", {
  route: "get-reviews",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: getReviewsHandler,
});

module.exports = {
  _test: {
    resolveCompanyName,
    getReviewsHandler,
  },
};
