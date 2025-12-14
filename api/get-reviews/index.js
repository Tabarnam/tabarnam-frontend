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

function getPublicNotesContainer() {
  const endpoint = E("COSMOS_DB_ENDPOINT");
  const key = E("COSMOS_DB_KEY");
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_NOTES_CONTAINER", "notes");

  if (!endpoint || !key) return null;
  cosmosClient ||= new CosmosClient({ endpoint, key });
  return cosmosClient.database(databaseId).container(containerId);
}

function getAdminNotesContainer() {
  const endpoint = E("COSMOS_DB_ENDPOINT");
  const key = E("COSMOS_DB_KEY");
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_NOTES_ADMIN_CONTAINER", "notes_admin");

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

async function resolveCompanyId(params, companiesContainer, context) {
  const companyId = String(params.company_id || params.id || "").trim();
  if (companyId) return companyId;
  if (!companiesContainer) return "";

  const normalizedDomain = String(params.normalized_domain || params.domain || "").trim().toLowerCase();
  if (normalizedDomain) {
    try {
      const sql = `SELECT TOP 1 c.id FROM c WHERE LOWER(c.normalized_domain) = @domain ORDER BY c._ts DESC`;
      const { resources } = await companiesContainer.items
        .query(
          { query: sql, parameters: [{ name: "@domain", value: normalizedDomain }] },
          { enableCrossPartitionQuery: true }
        )
        .fetchAll();

      const id = resources?.[0]?.id;
      if (typeof id === "string" && id.trim()) return id.trim();
    } catch (e) {
      context?.log?.("Warning: Failed to resolve company id from normalized_domain:", e?.message || e);
    }
  }

  const company = String(params.company || "").trim();
  if (company) {
    try {
      const sql = `SELECT TOP 1 c.id FROM c WHERE c.company_name = @company ORDER BY c._ts DESC`;
      const { resources } = await companiesContainer.items
        .query(
          { query: sql, parameters: [{ name: "@company", value: company }] },
          { enableCrossPartitionQuery: true }
        )
        .fetchAll();

      const id = resources?.[0]?.id;
      if (typeof id === "string" && id.trim()) return id.trim();
    } catch (e) {
      context?.log?.("Warning: Failed to resolve company id from company name:", e?.message || e);
    }
  }

  return "";
}

function normalizeIsPublicFlag(value, defaultValue = true) {
  if (value === undefined || value === null) return defaultValue;
  if (value === false) return false;
  if (value === true) return true;

  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (!v) return defaultValue;
    if (v === "false" || v === "0" || v === "no" || v === "off") return false;
    if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  }

  return Boolean(value);
}

async function resolveCompanyIdCandidates(
  { companyIdParam, resolvedCompanyId, companyName, domainParam },
  companiesContainer,
  context
) {
  const candidates = new Set();

  const add = (v) => {
    const s = String(v || "").trim();
    if (s) candidates.add(s);
  };

  add(companyIdParam);
  add(resolvedCompanyId);
  add(companyName);
  add(domainParam);

  if (!companiesContainer) return Array.from(candidates);

  try {
    const queries = [];

    if (companyIdParam) {
      queries.push({
        query: `SELECT TOP 25 c.id, c.company_id, c.company_name, c.normalized_domain FROM c WHERE c.id = @id OR c.company_id = @id ORDER BY c._ts DESC`,
        parameters: [{ name: "@id", value: companyIdParam }],
      });
    }

    if (domainParam) {
      queries.push({
        query: `SELECT TOP 25 c.id, c.company_id, c.company_name, c.normalized_domain FROM c WHERE LOWER(c.normalized_domain) = @domain ORDER BY c._ts DESC`,
        parameters: [{ name: "@domain", value: String(domainParam).toLowerCase() }],
      });
    }

    if (companyName) {
      queries.push({
        query: `SELECT TOP 25 c.id, c.company_id, c.company_name, c.normalized_domain FROM c WHERE c.company_name = @company ORDER BY c._ts DESC`,
        parameters: [{ name: "@company", value: companyName }],
      });
    }

    for (const q of queries) {
      const { resources } = await companiesContainer.items
        .query(q, { enableCrossPartitionQuery: true })
        .fetchAll();

      for (const r of resources || []) {
        add(r?.id);
        add(r?.company_id);
        add(r?.companyId);
        add(r?.company_name);
        add(r?.normalized_domain);
      }
    }
  } catch (e) {
    context?.log?.("Warning: Failed to resolve company id candidates:", e?.message || e);
  }

  return Array.from(candidates);
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
  const notesContainer = deps.notesContainer ?? getPublicNotesContainer();
  const notesAdminContainer = deps.notesAdminContainer ?? getAdminNotesContainer();

  const companyIdParam = String(url.searchParams.get("company_id") || url.searchParams.get("id") || "").trim();
  const domainParam = String(url.searchParams.get("normalized_domain") || url.searchParams.get("domain") || "").trim();

  const companyName = await resolveCompanyName(
    {
      company: url.searchParams.get("company"),
      company_id: companyIdParam,
      id: companyIdParam,
      normalized_domain: domainParam,
      domain: domainParam,
    },
    companiesContainer,
    context
  );

  const resolvedCompanyId = await resolveCompanyId(
    {
      company: url.searchParams.get("company"),
      company_id: companyIdParam,
      id: companyIdParam,
      normalized_domain: domainParam,
      domain: domainParam,
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

        const userReviews = (resources || []).map((r) => {
          const sourceName = r.user_name
            ? `${r.user_name}${r.user_location ? ` (${r.user_location})` : ""}`
            : "Anonymous User";

          return {
            // New canonical fields
            type: "user",
            text: r.text,
            source_name: sourceName,
            source_url: null,
            imported_at: r.created_at,

            // Backwards-compatible fields
            id: r.id,
            source: sourceName,
            abstract: r.text,
            url: null,
            rating: r.rating,
            created_at: r.created_at,
            flagged_bot: r.flagged_bot,
            bot_reason: r.bot_reason,
          };
        });

        allReviews = allReviews.concat(userReviews);
      } catch (e) {
        context?.log?.("Warning: Failed to fetch user reviews:", e?.message || e);
      }
    }

    // 2) curated reviews from company record
    if (companiesContainer) {
      try {
        let sql;
        let parameters;

        if (companyIdParam) {
          sql = `SELECT TOP 1 c.id, c.company_name, c.normalized_domain, c.curated_reviews, c.reviews, c._ts FROM c WHERE c.id = @id OR c.company_id = @id ORDER BY c._ts DESC`;
          parameters = [{ name: "@id", value: companyIdParam }];
        } else if (domainParam) {
          sql = `SELECT TOP 1 c.id, c.company_name, c.normalized_domain, c.curated_reviews, c.reviews, c._ts FROM c WHERE LOWER(c.normalized_domain) = @domain ORDER BY c._ts DESC`;
          parameters = [{ name: "@domain", value: domainParam.toLowerCase() }];
        } else {
          sql = `SELECT TOP 5 c.id, c.company_name, c.normalized_domain, c.curated_reviews, c.reviews, c._ts FROM c WHERE c.company_name = @company ORDER BY c._ts DESC`;
          parameters = [{ name: "@company", value: companyName }];
        }

        const { resources } = await companiesContainer.items
          .query({ query: sql, parameters }, { enableCrossPartitionQuery: true })
          .fetchAll();

        if (resources && resources.length > 0) {
          const companyRecord = resources[0];
          const dupes = resources.slice(1);
          const dupeTs = dupes.map((d) => d?._ts).filter(Boolean);

          const curatedArrRaw = Array.isArray(companyRecord.curated_reviews)
            ? companyRecord.curated_reviews
            : Array.isArray(companyRecord.reviews)
              ? companyRecord.reviews
              : [];

          const curatedArrVisible = curatedArrRaw.filter((r) => {
            const flag = r?.show_to_users ?? r?.showToUsers ?? r?.is_public ?? r?.visible_to_users ?? r?.visible;
            return normalizeIsPublicFlag(flag, true) !== false;
          });

          const curatedReviews = curatedArrVisible.map((r, idx) => {
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
            company_curated_count: curatedArrRaw.length,
            company_curated_visible_count: curatedReviews.length,
            dupe_company_records: dupes.length,
          };
        }
      } catch (e) {
        context?.log?.("Warning: Failed to fetch curated reviews:", e?.message || e);
      }
    }

    // 3) public admin notes (show to users)
    if (notesContainer || notesAdminContainer) {
      try {
        const companyIdCandidates = await resolveCompanyIdCandidates(
          {
            companyIdParam: companyIdParam || "",
            resolvedCompanyId,
            companyName,
            domainParam,
          },
          companiesContainer,
          context
        );

        const containers = [notesAdminContainer, notesContainer].filter(Boolean);
        const notesById = new Map();

        if (companyIdCandidates.length > 0) {
          const sql =
            "SELECT * FROM c WHERE ARRAY_CONTAINS(@companyIds, c.company_id) ORDER BY c.created_at DESC";

          for (const container of containers) {
            const { resources } = await container.items
              .query(
                { query: sql, parameters: [{ name: "@companyIds", value: companyIdCandidates }] },
                { enableCrossPartitionQuery: true }
              )
              .fetchAll();

            for (const n of resources || []) {
              const id = (n?.id || "").toString().trim();
              if (id) notesById.set(id, n);
            }
          }
        }

        const publicNotes = Array.from(notesById.values())
          .filter((n) => normalizeIsPublicFlag(n?.is_public, true) !== false)
          .map((n, idx) => {
            const actor = (n?.actor || "").toString().trim();
            const text = (n?.text || "").toString().trim();
            if (!text) return null;
            const createdAt = n?.created_at || n?.updated_at || null;
            const sourceName = actor ? `Admin (${actor})` : "Admin";
            return {
              type: "admin",
              text,
              source_name: sourceName,
              source_url: null,
              imported_at: createdAt,
              id: n?.id || `admin-note-${companyIdCandidates[0] || resolvedCompanyId || companyName}-${idx}`,
              source: sourceName,
              abstract: text,
              url: null,
              rating: null,
              created_at: createdAt,
              last_updated_at: n?.updated_at || null,
            };
          })
          .filter(Boolean);

        allReviews = allReviews.concat(publicNotes);

        allReviews._meta = {
          ...(allReviews._meta || {}),
          company_id_param: companyIdParam || null,
          company_id_resolved: resolvedCompanyId || null,
          company_id_candidates_count: companyIdCandidates.length,
        };
      } catch (e) {
        context?.log?.("Warning: Failed to fetch public notes:", e?.message || e);
      }
    }

    // curated/admin first, then user reviews; newest first within type
    allReviews.sort((a, b) => {
      const aType = a.type === "curated" || a.type === "admin" ? 0 : 1;
      const bType = b.type === "curated" || b.type === "admin" ? 0 : 1;
      if (aType !== bType) return aType - bType;
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });

    const meta = allReviews._meta || {};

    meta.backend = {
      website_hostname: process.env.WEBSITE_HOSTNAME || null,
      website_site_name: process.env.WEBSITE_SITE_NAME || null,
      region_name: process.env.REGION_NAME || null,
      cosmos_database: E("COSMOS_DB_DATABASE", "tabarnam-db"),
      cosmos_containers: {
        companies: E("COSMOS_DB_COMPANIES_CONTAINER", "companies"),
        reviews: E("COSMOS_DB_REVIEWS_CONTAINER", "reviews"),
        notes: E("COSMOS_DB_NOTES_CONTAINER", "notes"),
        notes_admin: E("COSMOS_DB_NOTES_ADMIN_CONTAINER", "notes_admin"),
      },
    };

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
    resolveCompanyId,
    getReviewsHandler,
  },
};
