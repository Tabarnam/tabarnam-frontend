// api/admin-reviews/index.js
// Admin interface for managing curated reviews on companies
// Supports: add/edit/delete reviews, bulk exclude sources

const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");
const { randomUUID } = require("node:crypto");

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

const cors = (req) => {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
};

const json = (obj, status = 200, req) => ({
  status,
  headers: { ...cors(req), "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

let cosmosClient = null;

function getCompaniesContainer() {
  const endpoint = E("COSMOS_DB_ENDPOINT");
  const key = E("COSMOS_DB_KEY");
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_COMPANIES_CONTAINER", "companies");

  if (!endpoint || !key) return null;
  cosmosClient ||= new CosmosClient({ endpoint, key });
  return cosmosClient.database(databaseId).container(containerId);
}

// EXCLUDED_SOURCES: sources to always filter out
const EXCLUDED_SOURCES = new Set(["amazon", "google", "facebook"]);

function isExcludedSource(source) {
  if (!source) return false;
  const normalized = source.toLowerCase().trim();
  for (const excluded of EXCLUDED_SOURCES) {
    if (normalized.includes(excluded)) return true;
  }
  return false;
}

app.http("adminReviews", {
  route: "admin-reviews",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return json({}, 204, req);
    }

    const url = new URL(req.url);
    const company = url.searchParams.get("company") || "";

    const container = getCompaniesContainer();
    if (!container) {
      return json({ error: "Cosmos DB not configured" }, 500, req);
    }

    try {
      // GET: Fetch reviews for a company
      if (method === "GET") {
        if (!company) return json({ error: "company parameter required" }, 400, req);

        const sql = `SELECT c.company_name, c.curated_reviews FROM c WHERE c.company_name = @company`;
        const { resources } = await container.items
          .query(
            { query: sql, parameters: [{ name: "@company", value: company }] },
            { enableCrossPartitionQuery: true }
          )
          .fetchAll();

        if (!resources || !resources.length) {
          return json({ company, reviews: [] }, 200, req);
        }

        const companyRecord = resources[0];
        const reviews = Array.isArray(companyRecord.curated_reviews) ? companyRecord.curated_reviews : [];

        return json({ company, reviews }, 200, req);
      }

      // POST: Add a new review
      if (method === "POST") {
        let body = {};
        try {
          body = await req.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400, req);
        }

        const { company: companyName, source, abstract, url, rating } = body;

        if (!companyName) return json({ error: "company required" }, 400, req);
        if (!source) return json({ error: "source required" }, 400, req);
        if (!abstract) return json({ error: "abstract required" }, 400, req);

        if (isExcludedSource(source)) {
          return json({ error: `Source "${source}" is excluded (Amazon/Google/Facebook)` }, 400, req);
        }

        // Fetch company record
        const sql = `SELECT * FROM c WHERE c.company_name = @company`;
        const { resources } = await container.items
          .query(
            { query: sql, parameters: [{ name: "@company", value: companyName }] },
            { enableCrossPartitionQuery: true }
          )
          .fetchAll();

        if (!resources || !resources.length) {
          return json({ error: "Company not found" }, 404, req);
        }

        const companyRecord = resources[0];
        if (!Array.isArray(companyRecord.curated_reviews)) {
          companyRecord.curated_reviews = [];
        }

        // Create new review
        const newReview = {
          id: randomUUID(),
          source: source.trim(),
          abstract: abstract.trim(),
          url: url ? url.trim() : null,
          rating: rating ? Number(rating) : null,
          created_at: new Date().toISOString(),
          last_updated_at: new Date().toISOString(),
        };

        // Add to front (most recent first)
        companyRecord.curated_reviews.unshift(newReview);

        // Keep only 10 most recent
        companyRecord.curated_reviews = companyRecord.curated_reviews.slice(0, 10);

        // Update company
        await container.items.upsert(companyRecord);

        return json({ ok: true, review: newReview }, 200, req);
      }

      // PUT: Update an existing review
      if (method === "PUT") {
        let body = {};
        try {
          body = await req.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400, req);
        }

        const { company: companyName, review_id, source, abstract, url, rating } = body;

        if (!companyName || !review_id) {
          return json({ error: "company and review_id required" }, 400, req);
        }

        const sql = `SELECT * FROM c WHERE c.company_name = @company`;
        const { resources } = await container.items
          .query(
            { query: sql, parameters: [{ name: "@company", value: companyName }] },
            { enableCrossPartitionQuery: true }
          )
          .fetchAll();

        if (!resources || !resources.length) {
          return json({ error: "Company not found" }, 404, req);
        }

        const companyRecord = resources[0];
        const reviews = Array.isArray(companyRecord.curated_reviews) ? companyRecord.curated_reviews : [];

        const reviewIndex = reviews.findIndex((r) => r.id === review_id);
        if (reviewIndex === -1) {
          return json({ error: "Review not found" }, 404, req);
        }

        if (source && isExcludedSource(source)) {
          return json({ error: `Source "${source}" is excluded` }, 400, req);
        }

        // Update review
        const updated = {
          ...reviews[reviewIndex],
          ...(source && { source: source.trim() }),
          ...(abstract && { abstract: abstract.trim() }),
          ...(url && { url: url.trim() }),
          ...(rating !== undefined && { rating: Number(rating) }),
          last_updated_at: new Date().toISOString(),
        };

        reviews[reviewIndex] = updated;
        companyRecord.curated_reviews = reviews;

        await container.items.upsert(companyRecord);

        return json({ ok: true, review: updated }, 200, req);
      }

      // DELETE: Remove a review
      if (method === "DELETE") {
        let body = {};
        try {
          body = await req.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400, req);
        }

        const { company: companyName, review_id } = body;

        if (!companyName || !review_id) {
          return json({ error: "company and review_id required" }, 400, req);
        }

        const sql = `SELECT * FROM c WHERE c.company_name = @company`;
        const { resources } = await container.items
          .query(
            { query: sql, parameters: [{ name: "@company", value: companyName }] },
            { enableCrossPartitionQuery: true }
          )
          .fetchAll();

        if (!resources || !resources.length) {
          return json({ error: "Company not found" }, 404, req);
        }

        const companyRecord = resources[0];
        const reviews = Array.isArray(companyRecord.curated_reviews) ? companyRecord.curated_reviews : [];

        companyRecord.curated_reviews = reviews.filter((r) => r.id !== review_id);

        await container.items.upsert(companyRecord);

        return json({ ok: true, deleted: review_id }, 200, req);
      }

      return json({ error: "Method not supported" }, 405, req);
    } catch (e) {
      context.log("Error in admin-reviews:", e?.message || e);
      return json({ error: e?.message || "Internal error" }, 500, req);
    }
  },
});
