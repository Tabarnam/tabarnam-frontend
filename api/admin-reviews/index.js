const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");
const { randomUUID } = require("node:crypto");

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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
      return {
        status: 204,
        headers: getCorsHeaders(),
      };
    }

    const url = new URL(req.url);
    const company = url.searchParams.get("company") || "";

    const container = getCompaniesContainer();
    if (!container) {
      return json({ error: "Cosmos DB not configured" }, 500);
    }

    try {
      // GET: Fetch reviews for a company
      if (method === "GET") {
        if (!company) return json({ error: "company parameter required" }, 400);

        const sql = `SELECT c.company_name, c.curated_reviews FROM c WHERE c.company_name = @company`;
        const { resources } = await container.items
          .query(
            { query: sql, parameters: [{ name: "@company", value: company }] },
            { enableCrossPartitionQuery: true }
          )
          .fetchAll();

        if (!resources || !resources.length) {
          return json({ company, reviews: [] }, 200);
        }

        const companyRecord = resources[0];
        const reviews = Array.isArray(companyRecord.curated_reviews) ? companyRecord.curated_reviews : [];

        return json({ company, reviews }, 200);
      }

      // POST: Add a new review
      if (method === "POST") {
        let body = {};
        try {
          body = await req.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        const { company: companyName, source, abstract, url, rating } = body;

        if (!companyName) return json({ error: "company required" }, 400);
        if (!source) return json({ error: "source required" }, 400);
        if (!abstract) return json({ error: "abstract required" }, 400);

        if (isExcludedSource(source)) {
          return json({ error: `Source "${source}" is excluded (Amazon/Google/Facebook)` }, 400);
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
          return json({ error: "Company not found" }, 404);
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
        const partitionKeyValue = String(companyRecord.normalized_domain || "unknown").trim();
        await container.items.upsert(companyRecord, { partitionKey: partitionKeyValue });

        return json({ ok: true, review: newReview }, 200);
      }

      // PUT: Update an existing review
      if (method === "PUT") {
        let body = {};
        try {
          body = await req.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        const { company: companyName, review_id, source, abstract, url, rating } = body;

        if (!companyName || !review_id) {
          return json({ error: "company and review_id required" }, 400);
        }

        const sql = `SELECT * FROM c WHERE c.company_name = @company`;
        const { resources } = await container.items
          .query(
            { query: sql, parameters: [{ name: "@company", value: companyName }] },
            { enableCrossPartitionQuery: true }
          )
          .fetchAll();

        if (!resources || !resources.length) {
          return json({ error: "Company not found" }, 404);
        }

        const companyRecord = resources[0];
        const reviews = Array.isArray(companyRecord.curated_reviews) ? companyRecord.curated_reviews : [];

        const reviewIndex = reviews.findIndex((r) => r.id === review_id);
        if (reviewIndex === -1) {
          return json({ error: "Review not found" }, 404);
        }

        if (source && isExcludedSource(source)) {
          return json({ error: `Source "${source}" is excluded` }, 400);
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

        const partitionKeyValue2 = String(companyRecord.normalized_domain || "unknown").trim();
        await container.items.upsert(companyRecord, { partitionKey: partitionKeyValue2 });

        return json({ ok: true, review: updated }, 200);
      }

      // DELETE: Remove a review
      if (method === "DELETE") {
        let body = {};
        try {
          body = await req.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        const { company: companyName, review_id } = body;

        if (!companyName || !review_id) {
          return json({ error: "company and review_id required" }, 400);
        }

        const sql = `SELECT * FROM c WHERE c.company_name = @company`;
        const { resources } = await container.items
          .query(
            { query: sql, parameters: [{ name: "@company", value: companyName }] },
            { enableCrossPartitionQuery: true }
          )
          .fetchAll();

        if (!resources || !resources.length) {
          return json({ error: "Company not found" }, 404);
        }

        const companyRecord = resources[0];
        const reviews = Array.isArray(companyRecord.curated_reviews) ? companyRecord.curated_reviews : [];

        companyRecord.curated_reviews = reviews.filter((r) => r.id !== review_id);

        const partitionKeyValue3 = String(companyRecord.normalized_domain || "unknown").trim();
        await container.items.upsert(companyRecord, { partitionKey: partitionKeyValue3 });

        return json({ ok: true, deleted: review_id }, 200);
      }

      return json({ error: "Method not supported" }, 405);
    } catch (e) {
      context.log("Error in admin-reviews:", e?.message || e);
      return json({ error: e?.message || "Internal error" }, 500);
    }
  },
});
