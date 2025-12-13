// api/get-reviews/index.js
// Fetch reviews for a company (user-submitted + curated reviews)

let app;
try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {} };
}

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
      const sql = `SELECT TOP 1 c.company_name FROM c WHERE c.id = @id ORDER BY c._ts DESC`;
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
      const sql = `SELECT TOP 1 c.company_name FROM c WHERE LOWER(c.normalized_domain) = @domain ORDER BY c._ts DESC`;
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
        const sql = `SELECT TOP 5 c.id, c.company_name, c.normalized_domain, c.curated_reviews, c.reviews, c._ts FROM c WHERE c.company_name = @company ORDER BY c._ts DESC`;
        const { resources } = await companiesContainer.items
          .query(
            { query: sql, parameters: [{ name: "@company", value: companyName }] },
            { enableCrossPartitionQuery: true }
          )
          .fetchAll();

        if (resources && resources.length > 0) {
          const companyRecord = resources[0];
          const dupes = resources.slice(1);
          const dupeTs = dupes.map((d) => d?._ts).filter(Boolean);

          const curatedArr = Array.isArray(companyRecord.curated_reviews)
            ? companyRecord.curated_reviews
            : Array.isArray(companyRecord.reviews)
              ? companyRecord.reviews
              : [];

          const curatedReviews = curatedArr.map((r, idx) => {
            const sourceName = (r?.author || r?.source_name || r?.source || "Unknown Source").toString();
            const sourceUrl = r?.source_url || r?.url || null;
            const text = r?.abstract || r?.excerpt || r?.text || "";
            const importedAt = r?.imported_at || r?.created_at || r?.last_updated_at || r?.date || null;

            return {
              // New canonical fields
              type: "curated",
              text,
              source_name: sourceName,
              source_url: sourceUrl,
              imported_at: importedAt,

              // Backwards-compatible fields used by existing UI
              id: r?.id || `curated-${companyName}-${idx}`,
              source: sourceName,
              abstract: text,
              url: sourceUrl,
              rating: r?.rating ?? null,
              created_at: importedAt,
              last_updated_at: r?.last_updated_at || null,
            };
          });

          if (dupes.length > 0) {
            context?.log?.("Warning: Multiple company records found for company_name; using newest", {
              company: companyName,
              primary_id: companyRecord?.id,
              dupe_count: dupes.length,
              dupe_ts: dupeTs,
            });
          }

          allReviews = allReviews.concat(curatedReviews);

          // Attach metadata so the UI can detect regressions.
          allReviews._meta = {
            company_record_id: companyRecord?.id || null,
            company_record_ts: companyRecord?._ts || null,
            company_curated_count: curatedReviews.length,
            dupe_company_records: dupes.length,
          };
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

    const meta = allReviews._meta || {};
    // remove accidental enumerable metadata if attached
    if (allReviews._meta) delete allReviews._meta;

    return json(
      {
        ok: true,
        company: companyName,
        company_name: companyName,
        items: allReviews,
        reviews: allReviews,
        count: allReviews.length,
        meta,
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
