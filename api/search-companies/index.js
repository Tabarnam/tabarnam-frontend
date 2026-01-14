let app;
try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {} };
}

const { CosmosClient } = require("@azure/cosmos");
const { getContainerPartitionKeyPath } = require("../_cosmosPartitionKey");

let cosmosTargetPromise;

function redactHostForDiagnostics(value) {
  const host = typeof value === "string" ? value.trim() : "";
  if (!host) return "";
  if (host.length <= 12) return host;
  return `${host.slice(0, 8)}…${host.slice(-8)}`;
}

async function getCompaniesCosmosTargetDiagnostics(container) {
  cosmosTargetPromise ||= (async () => {
    const endpoint = env("COSMOS_DB_ENDPOINT", "");
    const databaseId = env("COSMOS_DB_DATABASE", "tabarnam-db");
    const containerId = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");

    let host = "";
    try {
      host = endpoint ? new URL(endpoint).host : "";
    } catch {
      host = "";
    }

    const pkPath = await getContainerPartitionKeyPath(container, "/normalized_domain");

    return {
      cosmos_account_host_redacted: redactHostForDiagnostics(host),
      cosmos_db_name: databaseId,
      cosmos_container_name: containerId,
      cosmos_container_partition_key_path: pkPath,
    };
  })();

  try {
    return await cosmosTargetPromise;
  } catch {
    return {
      cosmos_account_host_redacted: "",
      cosmos_db_name: env("COSMOS_DB_DATABASE", "tabarnam-db"),
      cosmos_container_name: env("COSMOS_DB_COMPANIES_CONTAINER", "companies"),
      cosmos_container_partition_key_path: "/normalized_domain",
    };
  }
}

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

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function toFiniteNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isCompanyRating(value) {
  if (!value || typeof value !== "object") return false;
  return (
    "star1" in value ||
    "star2" in value ||
    "star3" in value ||
    "star4" in value ||
    "star5" in value
  );
}

function calculateTotalScore(rating) {
  if (!rating || typeof rating !== "object") return 0;
  const starKeys = ["star1", "star2", "star3", "star4", "star5"];
  let total = 0;
  for (const k of starKeys) {
    const v = rating[k];
    const n = typeof v === "object" ? toFiniteNumber(v?.value) : toFiniteNumber(v);
    total += n || 0;
  }
  return clamp(total, 0, 5);
}

function getQQScoreLike(company) {
  if (!company) return 0;

  const rating = company.rating;
  if (isCompanyRating(rating)) {
    return calculateTotalScore(rating);
  }

  const ratingAsNumber = toFiniteNumber(rating);
  if (ratingAsNumber != null) return clamp(ratingAsNumber, 0, 5);

  const starRating = toFiniteNumber(company.star_rating);
  if (starRating != null) return clamp(starRating, 0, 5);

  const starScore = toFiniteNumber(company.star_score);
  if (starScore != null) return clamp(starScore, 0, 5);

  const stars = toFiniteNumber(company.stars);
  if (stars != null) return clamp(stars, 0, 5);

  const confidence = toFiniteNumber(company.confidence_score);
  if (confidence != null) return clamp(confidence * 5, 0, 5);

  const manufacturingEligible =
    Array.isArray(company.manufacturing_locations) && company.manufacturing_locations.length > 0;

  const hqEligible =
    (Array.isArray(company.headquarters) && company.headquarters.length > 0) ||
    (Array.isArray(company.headquarters_locations) && company.headquarters_locations.length > 0) ||
    (typeof company.headquarters_location === "string" && company.headquarters_location.trim());

  const reviewEligible = getTotalReviews(company) > 0;

  const derived = (manufacturingEligible ? 1 : 0) + (hqEligible ? 1 : 0) + (reviewEligible ? 1 : 0);
  return clamp(derived, 0, 5);
}

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function joinedLower(arr) {
  if (!Array.isArray(arr)) return "";
  return arr.map((s) => asString(s).trim()).filter(Boolean).join(", ").toLowerCase();
}

function getReviewCount(company) {
  if (!company) return 0;

  if (typeof company.review_count === "number") return company.review_count;
  if (typeof company.reviews_count === "number") return company.reviews_count;
  if (typeof company.review_count_approved === "number") return company.review_count_approved;

  return 0;
}

function getTotalReviews(company) {
  const base = getReviewCount(company);
  const editorial = typeof company?.editorial_review_count === "number" ? company.editorial_review_count : 0;
  return base + editorial;
}

function getComparableValue(sortField, c) {
  switch (sortField) {
    case "name":
      return asString(c.display_name || c.company_name || c.name).toLowerCase();
    case "industries":
      return joinedLower(c.industries);
    case "reviews":
      return getReviewCount(c);
    case "stars":
      return getQQScoreLike(c);
    case "created":
      return asString(c.created_at);
    case "updated":
      return asString(c.updated_at);
    default:
      return null;
  }
}

function compareCompanies(sortField, dir, a, b) {
  const av = getComparableValue(sortField, a);
  const bv = getComparableValue(sortField, b);

  const isNumber = typeof av === "number" || typeof bv === "number";
  let cmp = 0;
  if (isNumber) {
    const an = typeof av === "number" ? av : 0;
    const bn = typeof bv === "number" ? bv : 0;
    cmp = an === bn ? 0 : an < bn ? -1 : 1;
  } else {
    const as = asString(av);
    const bs = asString(bv);
    cmp = as.localeCompare(bs);
  }

  if (cmp === 0) {
    const an = asString(a.display_name || a.company_name || a.name).toLowerCase();
    const bn = asString(b.display_name || b.company_name || b.name).toLowerCase();
    cmp = an.localeCompare(bn);
  }

  return dir === "desc" ? -cmp : cmp;
}

// Cosmos SQL: keep queries type-safe by guarding LOWER()/CONTAINS()/ARRAY ops
// with IS_STRING / IS_ARRAY checks. (Cosmos SQL does not support [] array literals,
// and will throw "One of the input values is invalid" for invalid expressions.)
const SQL_TEXT_FILTER = `
  (IS_DEFINED(c.company_name) AND IS_STRING(c.company_name) AND CONTAINS(LOWER(c.company_name), @q)) OR
  (IS_DEFINED(c.display_name) AND IS_STRING(c.display_name) AND CONTAINS(LOWER(c.display_name), @q)) OR
  (IS_DEFINED(c.name) AND IS_STRING(c.name) AND CONTAINS(LOWER(c.name), @q)) OR
  (IS_DEFINED(c.product_keywords) AND IS_STRING(c.product_keywords) AND CONTAINS(LOWER(c.product_keywords), @q)) OR
  (
    IS_ARRAY(c.product_keywords) AND
    ARRAY_LENGTH(
      ARRAY(
        SELECT VALUE kw
        FROM kw IN c.product_keywords
        WHERE IS_STRING(kw) AND CONTAINS(LOWER(kw), @q)
      )
    ) > 0
  ) OR
  (IS_DEFINED(c.keywords) AND IS_STRING(c.keywords) AND CONTAINS(LOWER(c.keywords), @q)) OR
  (
    IS_ARRAY(c.keywords) AND
    ARRAY_LENGTH(
      ARRAY(
        SELECT VALUE k
        FROM k IN c.keywords
        WHERE IS_STRING(k) AND CONTAINS(LOWER(k), @q)
      )
    ) > 0
  ) OR
  (IS_DEFINED(c.industries) AND IS_STRING(c.industries) AND CONTAINS(LOWER(c.industries), @q)) OR
  (
    IS_ARRAY(c.industries) AND
    ARRAY_LENGTH(
      ARRAY(
        SELECT VALUE i
        FROM i IN c.industries
        WHERE IS_STRING(i) AND CONTAINS(LOWER(i), @q)
      )
    ) > 0
  ) OR
  (IS_DEFINED(c.normalized_domain) AND IS_STRING(c.normalized_domain) AND CONTAINS(LOWER(c.normalized_domain), @q)) OR
  (IS_DEFINED(c.amazon_url) AND IS_STRING(c.amazon_url) AND CONTAINS(LOWER(c.amazon_url), @q))
`;

const SELECT_FIELDS = [
  // Identity / names
  "c.id",
  "c.company_id",
  "c.company_name",
  "c.display_name",
  "c.name",

  // Category + keywords
  "c.industries",
  "c.product_keywords",
  "c.keywords",

  // Links
  "c.website_url",
  "c.url",
  "c.canonical_url",
  "c.website",
  "c.amazon_url",
  "c.normalized_domain",

  // Timestamps
  "c.created_at",
  "c.updated_at",
  "c._ts",

  // Location (used for completeness + admin UX)
  "c.manufacturing_locations",
  "c.manufacturing_geocodes",
  "c.headquarters",
  "c.headquarters_locations",
  "c.headquarters_location",
  "c.hq_lat",
  "c.hq_lng",

  // Content
  "c.tagline",
  "c.curated_reviews",

  // Ratings + stars
  "c.rating",
  "c.rating_icon_type",
  "c.avg_rating",
  "c.star_rating",
  "c.star_score",
  "c.confidence_score",
  "c.star_overrides",
  "c.admin_manual_extra",
  "c.star_notes",
  "c.star_explanation",

  // Reviews
  "c.review_count",
  "c.public_review_count",
  "c.private_review_count",
  "c.review_count_approved",
  "c.editorial_review_count",

  // UI / misc
  "c.profile_completeness",
  "c.profile_completeness_version",
  "c.logo_url",
  "c.logoUrl",
  "c.logo",
  "c.location_sources",
  "c.show_location_sources_to_users",
  "c.visibility",
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

function deriveNameFromHost(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";

  let host = "";
  try {
    const u = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    host = String(u.hostname || "").trim();
  } catch {
    host = raw.replace(/^https?:\/\//i, "").split("/")[0].trim();
  }

  const clean = host.toLowerCase().replace(/^www\./, "");
  const base = clean.split(".")[0] || "";
  if (!base) return "";

  return base.charAt(0).toUpperCase() + base.slice(1);
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

  const review_count = typeof doc.review_count === "number" ? doc.review_count : 0;
  const public_review_count = typeof doc.public_review_count === "number" ? doc.public_review_count : 0;
  const private_review_count = typeof doc.private_review_count === "number" ? doc.private_review_count : 0;

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

  const logo_url =
    asString(doc.logo_url).trim() ||
    asString(doc.logoUrl).trim() ||
    asString(doc.logoURL).trim() ||
    (doc.logo && typeof doc.logo === "object" ? asString(doc.logo.url).trim() : asString(doc.logo).trim()) ||
    "";

  const company_id = doc.company_id || doc.id;

  const display_name =
    asString(doc.display_name).trim() ||
    (() => {
      const n = asString(doc.name).trim();
      const cn = asString(doc.company_name).trim();
      if (!n) return "";
      if (!cn) return n;
      return n !== cn ? n : "";
    })();

  return {
    id: company_id,
    company_id,
    company_name: doc.company_name || doc.name || "",
    display_name: display_name || undefined,
    name: doc.name,
    website_url,
    normalized_domain: doc.normalized_domain || "",
    amazon_url,
    logo_url,
    industries,
    manufacturing_locations,
    headquarters_location: doc.headquarters_location || "",
    tagline: doc.tagline || "",
    product_keywords,
    keywords,
    stars,
    review_count,
    public_review_count,
    private_review_count,
    reviews_count: reviews_count ?? review_count,
    created_at: doc.created_at,
    updated_at: doc.updated_at,

    // Extra fields used by the public UI (non-redundant with canonical shape)
    headquarters:
      Array.isArray(doc.headquarters) && doc.headquarters.length
        ? doc.headquarters
        : Array.isArray(doc.headquarters_locations)
          ? doc.headquarters_locations
          : [],
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
    visibility: doc.visibility,
  };
}

async function searchCompaniesHandler(req, context, deps = {}) {
  const method = String(req.method || "").toUpperCase();
  if (method === "OPTIONS") {
    return {
      status: 200,
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
  const sortField = (url.searchParams.get("sortField") || "").toLowerCase();
  const sortDir = (url.searchParams.get("sortDir") || "asc").toLowerCase() === "desc" ? "desc" : "asc";
  const lat = toFiniteNumber(url.searchParams.get("lat"));
  const lng = toFiniteNumber(url.searchParams.get("lng"));
  const user_location = lat != null && lng != null ? { lat, lng } : null;

  const takeParam = toFiniteNumber(url.searchParams.get("take"));
  const take = clamp(Math.floor(takeParam ?? 50), 1, 200);

  const skipParam = toFiniteNumber(url.searchParams.get("skip"));
  const skip = Math.max(0, Math.floor(skipParam ?? 0));

  const limit = clamp(skip + take, 1, 500);

  const container = deps.companiesContainer ?? getCompaniesContainer();

  const cosmosTarget = container ? await getCompaniesCosmosTargetDiagnostics(container).catch(() => null) : null;
  if (cosmosTarget) {
    try {
      context.log("[search-companies] cosmos_target", cosmosTarget);
    } catch {}
  }

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
            WHERE IS_ARRAY(c.manufacturing_locations) AND ARRAY_LENGTH(c.manufacturing_locations) > 0
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
              WHERE (NOT IS_ARRAY(c.manufacturing_locations) OR ARRAY_LENGTH(c.manufacturing_locations) = 0)
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
              WHERE (${SQL_TEXT_FILTER})
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
        if (!r?.updated_at && typeof r?._ts === "number") {
          try {
            r.updated_at = new Date(r._ts * 1000).toISOString();
          } catch {}
        }
        return r;
      });

      const mapped = normalized
        .map(mapCompanyToPublic)
        .filter((c) => c && c.id && c.company_name);

      if (sortField) {
        mapped.sort((a, b) => compareCompanies(sortField, sortDir, a, b));
      }

      const paged = mapped.slice(skip, skip + take);

      return json(
        {
          ok: true,
          success: true,
          ...(cosmosTarget ? cosmosTarget : {}),
          items: paged,
          count: mapped.length,
          meta: { q: qRaw, sort, skip, take, user_location },
        },
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
      return json({ ok: false, success: false, ...(cosmosTarget ? cosmosTarget : {}), error: e?.message || "query failed" }, 500, req);
    }
  }

  return json({ ok: false, success: false, ...(cosmosTarget ? cosmosTarget : {}), error: "Cosmos DB not configured" }, 503, req);
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
