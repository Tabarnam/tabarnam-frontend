const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');
const { randomUUID } = require('node:crypto');
const { validateCuratedReviewCandidate, normalizeUrl } = require("../_reviewQuality");

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

const EXCLUDED_SOURCES = new Set(["amazon", "google", "facebook"]);

function isExcludedSource(source) {
  if (!source) return false;
  const normalized = source.toLowerCase().trim();
  for (const excluded of EXCLUDED_SOURCES) {
    if (normalized.includes(excluded)) return true;
  }
  return false;
}

app.http('adminReviews', {
  route: 'xadmin-api-reviews',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return {
        status: 200,
        headers: getCorsHeaders(),
      };
    }

    const url = new URL(req.url);
    const company = url.searchParams.get("company") || "";
    const company_id = url.searchParams.get("company_id") || url.searchParams.get("companyId") || "";

    const container = getCompaniesContainer();
    if (!container) {
      return json({ error: "Cosmos DB not configured" }, 500);
    }

    try {
      if (method === "GET") {
        const requested = String(company_id || company || "").trim();
        if (!requested) return json({ error: "company or company_id parameter required" }, 400);

        const sql = `SELECT TOP 1 c.company_name, c.curated_reviews FROM c WHERE c.id = @id OR c.company_id = @id OR c.companyId = @id OR c.company_name = @company ORDER BY c._ts DESC`;
        const { resources } = await container.items
          .query(
            {
              query: sql,
              parameters: [
                { name: "@id", value: requested },
                { name: "@company", value: String(company || requested) },
              ],
            },
            { enableCrossPartitionQuery: true }
          )
          .fetchAll();

        if (!resources || !resources.length) {
          return json({ company: requested, reviews: [] }, 200);
        }

        const companyRecord = resources[0];
        const reviews = Array.isArray(companyRecord.curated_reviews) ? companyRecord.curated_reviews : [];

        return json({ company: companyRecord.company_name || requested, reviews }, 200);
      }

      if (method === "POST") {
        let body = {};
        try {
          body = await req.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        const {
          company: companyName,
          source,
          abstract,
          url,
          rating,
          show_to_users,
          is_public,
          visible_to_users,
          title,
        } = body;

        if (!companyName) return json({ error: "company required" }, 400);
        if (!source) return json({ error: "source required" }, 400);
        if (!abstract) return json({ error: "abstract required" }, 400);

        const showToUsers =
          show_to_users !== undefined
            ? !!show_to_users
            : is_public !== undefined
              ? !!is_public
              : visible_to_users !== undefined
                ? !!visible_to_users
                : true;

        const normalizedUrl = url ? normalizeUrl(url) : null;
        if (showToUsers && !normalizedUrl) {
          return json({ error: "url required for public reviews" }, 400);
        }

        if (isExcludedSource(source) || (normalizedUrl && isExcludedSource(normalizedUrl))) {
          return json({ error: `Source "${source}" is excluded (Amazon/Google/Facebook)` }, 400);
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
        if (!Array.isArray(companyRecord.curated_reviews)) {
          companyRecord.curated_reviews = [];
        }

        let validation = null;
        if (normalizedUrl) {
          validation = await validateCuratedReviewCandidate(
            {
              companyName: companyRecord.company_name,
              websiteUrl: companyRecord.website_url || companyRecord.url || "",
              normalizedDomain: companyRecord.normalized_domain || "",
              url: normalizedUrl,
              title: String(title || "").trim(),
            },
            { timeoutMs: 8000, maxBytes: 60000, maxSnippets: 2, minWords: 10, maxWords: 25 }
          ).catch(() => null);

          if (!validation || validation.is_valid !== true) {
            return json({ error: "Review URL failed validation", detail: validation?.reason_if_rejected || null }, 400);
          }

          if (validation.link_status !== "ok") {
            return json({ error: `Review URL is not publishable (status: ${validation.link_status})` }, 400);
          }

          if (typeof validation.match_confidence === "number" && validation.match_confidence < 0.7) {
            return json({ error: `Review match confidence too low (${validation.match_confidence})` }, 400);
          }
        }

        const newReview = {
          id: randomUUID(),
          source: source.trim(),
          title: String(title || "").trim(),
          abstract: abstract.trim(),
          url: validation?.final_url || normalizedUrl,
          source_url: validation?.final_url || normalizedUrl,
          rating: rating ? Number(rating) : null,
          created_at: new Date().toISOString(),
          last_updated_at: new Date().toISOString(),
          show_to_users: showToUsers,
          is_public: showToUsers,
          link_status: validation?.link_status || (normalizedUrl ? "ok" : null),
          last_checked_at: validation?.last_checked_at || (normalizedUrl ? new Date().toISOString() : null),
          matched_brand_terms: validation?.matched_brand_terms || [],
          evidence_snippets: validation?.evidence_snippets || [],
          match_confidence: typeof validation?.match_confidence === "number" ? validation.match_confidence : null,
        };

        companyRecord.curated_reviews.unshift(newReview);

        const partitionKeyValue = String(companyRecord.normalized_domain || "unknown").trim();
        await container.items.upsert(companyRecord, { partitionKey: partitionKeyValue });

        return json({ ok: true, review: newReview }, 200);
      }

      if (method === "PUT") {
        let body = {};
        try {
          body = await req.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        const {
          company: companyName,
          review_id,
          source,
          abstract,
          url,
          rating,
          show_to_users,
          is_public,
          visible_to_users,
          title,
        } = body;

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

        const current = reviews[reviewIndex] || {};

        const showToUsers =
          show_to_users !== undefined
            ? !!show_to_users
            : is_public !== undefined
              ? !!is_public
              : visible_to_users !== undefined
                ? !!visible_to_users
                : current.show_to_users !== undefined
                  ? !!current.show_to_users
                  : current.is_public !== undefined
                    ? !!current.is_public
                    : true;

        const nextUrlRaw = url !== undefined ? url : current.url || current.source_url || null;
        const normalizedUrl = nextUrlRaw ? normalizeUrl(nextUrlRaw) : null;

        if (showToUsers && !normalizedUrl) {
          return json({ error: "url required for public reviews" }, 400);
        }

        const nextSource = source ? source.trim() : String(current.source || "").trim();
        if (isExcludedSource(nextSource) || (normalizedUrl && isExcludedSource(normalizedUrl))) {
          return json({ error: `Source "${nextSource}" is excluded` }, 400);
        }

        let validation = null;
        if (normalizedUrl && showToUsers) {
          validation = await validateCuratedReviewCandidate(
            {
              companyName: companyRecord.company_name,
              websiteUrl: companyRecord.website_url || companyRecord.url || "",
              normalizedDomain: companyRecord.normalized_domain || "",
              url: normalizedUrl,
              title: String(title || current.title || "").trim(),
            },
            { timeoutMs: 8000, maxBytes: 60000, maxSnippets: 2, minWords: 10, maxWords: 25 }
          ).catch(() => null);

          if (!validation || validation.is_valid !== true) {
            return json({ error: "Review URL failed validation", detail: validation?.reason_if_rejected || null }, 400);
          }

          if (validation.link_status !== "ok") {
            return json({ error: `Review URL is not publishable (status: ${validation.link_status})` }, 400);
          }

          if (typeof validation.match_confidence === "number" && validation.match_confidence < 0.7) {
            return json({ error: `Review match confidence too low (${validation.match_confidence})` }, 400);
          }
        }

        const updated = {
          ...current,
          source: nextSource,
          ...(title !== undefined && { title: String(title || "").trim() }),
          ...(abstract && { abstract: abstract.trim() }),
          url: validation?.final_url || normalizedUrl || null,
          source_url: validation?.final_url || normalizedUrl || current.source_url || null,
          ...(rating !== undefined && { rating: rating === null ? null : Number(rating) }),
          last_updated_at: new Date().toISOString(),
          show_to_users: showToUsers,
          is_public: showToUsers,
          link_status: validation?.link_status || (normalizedUrl ? "ok" : null),
          last_checked_at: validation?.last_checked_at || (normalizedUrl ? new Date().toISOString() : null),
          matched_brand_terms: validation?.matched_brand_terms || current.matched_brand_terms || [],
          evidence_snippets: validation?.evidence_snippets || current.evidence_snippets || [],
          match_confidence:
            typeof validation?.match_confidence === "number"
              ? validation.match_confidence
              : typeof current.match_confidence === "number"
                ? current.match_confidence
                : null,
        };

        reviews[reviewIndex] = updated;
        companyRecord.curated_reviews = reviews;

        const partitionKeyValue2 = String(companyRecord.normalized_domain || "unknown").trim();
        await container.items.upsert(companyRecord, { partitionKey: partitionKeyValue2 });

        return json({ ok: true, review: updated }, 200);
      }

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
  }
});
