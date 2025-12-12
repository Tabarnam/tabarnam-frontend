let app;
try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {} };
}

const { CosmosClient } = require("@azure/cosmos");

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function json(obj, status = 200, req) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-functions-key",
    },
    body: JSON.stringify(obj),
  };
}

function getCompaniesContainer() {
  try {
    const endpoint = env("COSMOS_DB_ENDPOINT", "");
    const key = env("COSMOS_DB_KEY", "");
    const databaseId = env("COSMOS_DB_DATABASE", "tabarnam-db");
    const containerId = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");

    if (!endpoint || !key) return null;

    const client = new CosmosClient({ endpoint, key });
    return client.database(databaseId).container(containerId);
  } catch (err) {
    console.error("Failed to initialize Cosmos container:", err);
    return null;
  }
}

const SQL_TEXT_FILTER = `
  (IS_DEFINED(c.company_name) AND CONTAINS(LOWER(c.company_name), @q)) OR
  (IS_DEFINED(c.product_keywords) AND CONTAINS(LOWER(c.product_keywords), @q)) OR
  (
    IS_DEFINED(c.keywords) AND (
      (IS_STRING(c.keywords) AND CONTAINS(LOWER(c.keywords), @q)) OR
      (IS_ARRAY(c.keywords) AND ARRAY_LENGTH(
        ARRAY(SELECT VALUE k FROM k IN c.keywords WHERE CONTAINS(LOWER(k), @q))
      ) > 0)
    )
  ) OR
  (IS_DEFINED(c.industries) AND ARRAY_LENGTH(
      ARRAY(SELECT VALUE i FROM i IN c.industries WHERE CONTAINS(LOWER(i), @q))
    ) > 0) OR
  (IS_DEFINED(c.normalized_domain) AND CONTAINS(LOWER(c.normalized_domain), @q)) OR
  (IS_DEFINED(c.amazon_url) AND CONTAINS(LOWER(c.amazon_url), @q))
`;

const SELECT_FIELDS = [
  "c.id",
  "c.company_name",
  "c.name",
  "c.industries",
  "c.url",
  "c.website_url",
  "c.canonical_url",
  "c.website",
  "c.amazon_url",
  "c.normalized_domain",
  "c.created_at",
  "c.session_id",
  "c._ts",
  "c.manufacturing_locations",
  "c.manufacturing_geocodes",
  "c.headquarters",
  "c.headquarters_location",
  "c.hq_lat",
  "c.hq_lng",
  "c.product_keywords",
  "c.keywords",
  "c.star_rating",
  "c.star_score",
  "c.confidence_score",
  "c.tagline",
  "c.logo_url",
  "c.star_overrides",
  "c.admin_manual_extra",
  "c.star_notes",
  "c.star_explanation",
  "c.affiliate_links",
  "c.affiliate_link_urls",
  "c.affiliate_link_1",
  "c.affiliate_link_2",
  "c.affiliate_link_3",
  "c.affiliate_link_4",
  "c.affiliate_link_5",
  "c.affiliate_link_1_url",
  "c.affiliate_link_2_url",
  "c.affiliate_link_3_url",
  "c.affiliate_link_4_url",
  "c.affiliate_link_5_url",
  "c.affiliate1_url",
  "c.affiliate2_url",
  "c.affiliate3_url",
  "c.affiliate4_url",
  "c.affiliate5_url",
  "c.rating",
  "c.rating_icon_type",
  "c.review_count",
  "c.avg_rating",
  "c.review_count_approved",
  "c.editorial_review_count",
  "c.location_sources",
  "c.show_location_sources_to_users",
].join(", ");

function normalizeStringArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function mapCompanyToPublic(doc) {
  if (!doc) return null;

  const industries = normalizeStringArray(doc.industries);
  const manufacturing_locations = Array.isArray(doc.manufacturing_locations)
    ? doc.manufacturing_locations
    : normalizeStringArray(doc.manufacturing_locations);
  const product_keywords = normalizeStringArray(doc.product_keywords);
  const keywords = normalizeStringArray(doc.keywords);

  let stars = null;
  if (typeof doc.avg_rating === "number") stars = doc.avg_rating;
  else if (typeof doc.star_score === "number") stars = doc.star_score;
  else if (typeof doc.star_rating === "number") stars = doc.star_rating;

  let reviews_count = null;
  if (typeof doc.review_count === "number") reviews_count = doc.review_count;
  else if (typeof doc.review_count_approved === "number") reviews_count = doc.review_count_approved;

  const website_url =
    doc.website_url ||
    doc.url ||
    doc.canonical_url ||
    doc.website ||
    "";

  const amazon_url = doc.amazon_url || "";

  return {
    id: doc.id,
    company_name: doc.company_name || doc.name || "",
    website_url,
    normalized_domain: doc.normalized_domain || "",
    amazon_url,
    logo_url: doc.logo_url || "",
    industries,
    manufacturing_locations,
    headquarters_location: doc.headquarters_location || "",
    tagline: doc.tagline || "",
    product_keywords,
    keywords,
    stars,
    reviews_count,

    // Extra fields used by the public UI (non-redundant with canonical shape)
    headquarters: Array.isArray(doc.headquarters) ? doc.headquarters : [],
    manufacturing_geocodes: Array.isArray(doc.manufacturing_geocodes) ? doc.manufacturing_geocodes : [],
    hq_lat: doc.hq_lat,
    hq_lng: doc.hq_lng,
    _ts: doc._ts,

    // Rating schema fields (for CompanyStarsBlock and future use)
    star_rating: doc.star_rating,
    star_score: doc.star_score,
    confidence_score: doc.confidence_score,
    rating: doc.rating,
    rating_icon_type: doc.rating_icon_type,
    review_count_approved: doc.review_count_approved,
    editorial_review_count: doc.editorial_review_count,
    star_overrides: doc.star_overrides,
    admin_manual_extra: doc.admin_manual_extra,
    star_notes: doc.star_notes,
    star_explanation: doc.star_explanation,

    // Affiliate links used by ExpandableCompanyRow
    affiliate_links: doc.affiliate_links,
    affiliate_link_urls: doc.affiliate_link_urls,
    affiliate_link_1: doc.affiliate_link_1,
    affiliate_link_2: doc.affiliate_link_2,
    affiliate_link_3: doc.affiliate_link_3,
    affiliate_link_4: doc.affiliate_link_4,
    affiliate_link_5: doc.affiliate_link_5,
    affiliate_link_1_url: doc.affiliate_link_1_url,
    affiliate_link_2_url: doc.affiliate_link_2_url,
    affiliate_link_3_url: doc.affiliate_link_3_url,
    affiliate_link_4_url: doc.affiliate_link_4_url,
    affiliate_link_5_url: doc.affiliate_link_5_url,
    affiliate1_url: doc.affiliate1_url,
    affiliate2_url: doc.affiliate2_url,
    affiliate3_url: doc.affiliate3_url,
    affiliate4_url: doc.affiliate4_url,
    affiliate5_url: doc.affiliate5_url,

    location_sources: doc.location_sources,
    show_location_sources_to_users: doc.show_location_sources_to_users,
  };
}

async function searchCompaniesHandler(req, context, deps = {}) {
  const method = String(req.method || "").toUpperCase();
  if (method === "OPTIONS") {
    return {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "content-type,x-functions-key",
        "Access-Control-Max-Age": "86400",
      },
    };
  }
  if (method !== "GET") {
    return json({ ok: false, success: false, error: "Method Not Allowed" }, 405, req);
  }

  const url = new URL(req.url);
  const qRaw = (url.searchParams.get("q") || "").trim();
  const q = qRaw.toLowerCase();
  const sort = (url.searchParams.get("sort") || "recent").toLowerCase();
  const take = Math.min(200, Math.max(1, Number(url.searchParams.get("take") || 50)));
  const rawSkip = url.searchParams.get("skip");
  const skip = Math.max(0, Number(rawSkip || 0) || 0);
  const limit = Math.min(500, skip + take || take);

  const container = deps.companiesContainer ?? getCompaniesContainer();
  if (container) {
    try {
      let items = [];
      const params = [{ name: "@take", value: limit }];
      if (q) params.push({ name: "@q", value: q });

      const softDeleteFilter = "(NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)";

      if (sort === "manu") {
        const whereText = q ? `AND (${SQL_TEXT_FILTER})` : "";

        const sqlA = `
            SELECT TOP @take ${SELECT_FIELDS}
            FROM c
            WHERE IS_DEFINED(c.manufacturing_locations) AND ARRAY_LENGTH(c.manufacturing_locations) > 0
            AND ${softDeleteFilter}
            ${whereText}
            ORDER BY c._ts DESC
          `;
        const partA = await container.items
          .query({ query: sqlA, parameters: params }, { enableCrossPartitionQuery: true })
          .fetchAll();
        items = partA.resources || [];

        const remaining = Math.max(0, limit - items.length);
        if (remaining > 0) {
          const sqlB = `
              SELECT TOP @take2 ${SELECT_FIELDS}
              FROM c
              WHERE (NOT IS_DEFINED(c.manufacturing_locations) OR ARRAY_LENGTH(c.manufacturing_locations) = 0)
              AND ${softDeleteFilter}
              ${whereText}
              ORDER BY c._ts DESC
            `;
          const paramsB = [{ name: "@take2", value: remaining }];
          if (q) paramsB.push({ name: "@q", value: q });
          const partB = await container.items
            .query({ query: sqlB, parameters: paramsB }, { enableCrossPartitionQuery: true })
            .fetchAll();
          items = items.concat(partB.resources || []);
        }
      } else {
        const orderBy = sort === "name" ? "ORDER BY c.company_name ASC" : "ORDER BY c._ts DESC";
        const sql = q
          ? `
              SELECT TOP @take ${SELECT_FIELDS}
              FROM c
              WHERE ${SQL_TEXT_FILTER}
              AND ${softDeleteFilter}
              ${orderBy}
            `
          : `
              SELECT TOP @take ${SELECT_FIELDS}
              FROM c
              WHERE ${softDeleteFilter}
              ${orderBy}
            `;
        const res = await container.items
          .query({ query: sql, parameters: params }, { enableCrossPartitionQuery: true })
          .fetchAll();
        items = res.resources || [];
      }

      const normalized = items.map((r) => {
        if (!r?.created_at && typeof r?._ts === "number") {
          try {
            r.created_at = new Date(r._ts * 1000).toISOString();
          } catch {}
        }
        return r;
      });

      const mapped = normalized
        .map(mapCompanyToPublic)
        .filter((c) => c && c.id && c.company_name);

      const paged = mapped.slice(skip, skip + take);

      return json(
        { ok: true, success: true, items: paged, count: mapped.length, meta: { q: qRaw, sort, skip, take } },
        200,
        req
      );
    } catch (e) {
      context.log("search-companies cosmos error:", e?.message || e, e?.stack);
      console.error("search-companies error details:", {
        message: e?.message,
        stack: e?.stack,
        sort,
        q,
        limit,
      });
      return json({ ok: false, success: false, error: e?.message || "query failed" }, 500, req);
    }
  }

  return json({ ok: false, success: false, error: "Cosmos DB not configured" }, 503, req);
}

app.http("search-companies", {
  route: "search-companies",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    return searchCompaniesHandler(req, context);
  },
});

module.exports._test = {
  SQL_TEXT_FILTER,
  SELECT_FIELDS,
  normalizeStringArray,
  mapCompanyToPublic,
  searchCompaniesHandler,
};
