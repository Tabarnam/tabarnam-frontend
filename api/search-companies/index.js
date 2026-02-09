let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const { CosmosClient } = require("@azure/cosmos");
const { getContainerPartitionKeyPath } = require("../_cosmosPartitionKey");
const { logInboundRequest } = require("../_diagnostics");
const { parseQuery } = require("../_queryNormalizer");
const { expandQueryTerms } = require("../_searchSynonyms");
const { isFuzzyNameMatch, fuzzyScore } = require("../_fuzzyMatch");

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

  const starScore = toFiniteNumber(company.star_score);
  if (starScore != null) return clamp(starScore, 0, 5);

  const starRating = toFiniteNumber(company.star_rating);
  if (starRating != null) return clamp(starRating, 0, 5);

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

/**
 * Compute a name-match relevance score for a company against the search query.
 * Higher scores mean stronger name matches so exact name hits rank above keyword-only hits.
 *
 *   100 = exact match (lowered name === lowered query)
 *    80 = name starts with query
 *    60 = query appears at a word boundary in the name
 *    40 = query is a substring of the name
 *     0 = no name match
 */
function computeNameMatchScore(company, q_raw, q_norm, q_compact) {
  if (!company || (!q_raw && !q_norm && !q_compact)) return 0;

  const names = [
    asString(company.company_name).trim(),
    asString(company.display_name).trim(),
    asString(company.name).trim(),
  ].filter(Boolean);

  const queries = [
    q_raw ? q_raw.toLowerCase().trim() : "",
    q_norm ? q_norm.toLowerCase().trim() : "",
    q_compact ? q_compact.toLowerCase().trim() : "",
  ].filter(Boolean);

  const uniqueQueries = [...new Set(queries)];
  if (!uniqueQueries.length || !names.length) return 0;

  let best = 0;

  for (const rawName of names) {
    const nameLower = rawName.toLowerCase();
    const nameCompact = nameLower.replace(/\s+/g, "");

    for (const q of uniqueQueries) {
      if (nameLower === q || nameCompact === q) {
        best = Math.max(best, 100);
        continue;
      }
      if (nameLower.startsWith(q) || nameCompact.startsWith(q)) {
        best = Math.max(best, 80);
        continue;
      }
      // Word boundary: query after start, space, hyphen, or underscore
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(?:^|[\\s\\-_])${escaped}`).test(nameLower)) {
        best = Math.max(best, 60);
        continue;
      }
      if (nameLower.includes(q) || nameCompact.includes(q)) {
        best = Math.max(best, 40);
      }
    }
  }

  return best;
}

/**
 * Compute a keyword-match relevance score for a company against the search query.
 * Checks product_keywords and industries for match quality.
 *
 *   100 = exact keyword match (query === keyword)
 *    70 = keyword starts with query or query starts with keyword
 *    40 = query is a substring of keyword
 *    30 = keyword is a substring of query
 *     0 = no keyword match
 */
function computeKeywordMatchScore(company, q_norm, q_compact) {
  if (!company || (!q_norm && !q_compact)) return 0;

  const queryTerms = [q_norm, q_compact].filter(Boolean).map((t) => t.toLowerCase());
  if (!queryTerms.length) return 0;

  let best = 0;

  const checkField = (arr) => {
    for (const raw of arr) {
      const kw = asString(raw).toLowerCase().trim();
      if (!kw) continue;
      for (const qt of queryTerms) {
        if (kw === qt) {
          best = Math.max(best, 100);
        } else if (kw.startsWith(qt) || qt.startsWith(kw)) {
          best = Math.max(best, 70);
        } else if (kw.includes(qt)) {
          best = Math.max(best, 40);
        } else if (qt.includes(kw)) {
          best = Math.max(best, 30);
        }
      }
    }
  };

  checkField(normalizeStringArray(company.product_keywords));
  checkField(normalizeStringArray(company.keywords));
  checkField(normalizeStringArray(company.industries));

  return best;
}

/**
 * Compute a composite relevance score combining name and keyword match quality.
 * Name matches contribute 70%, keyword matches contribute 30%.
 */
function computeRelevanceScore(company, q_raw, q_norm, q_compact) {
  const nameScore = computeNameMatchScore(company, q_raw, q_norm, q_compact);
  const keywordScore = computeKeywordMatchScore(company, q_norm, q_compact);
  const relevanceScore = Math.round(nameScore * 0.7 + keywordScore * 0.3);
  return { _nameMatchScore: nameScore, _keywordMatchScore: keywordScore, _relevanceScore: relevanceScore };
}

// Helper to build search filter that handles both spaced and non-spaced queries
// Uses both @q (from first term) and @q_compact to allow flexible matching
function buildLegacySearchFilter() {
  // Build filter that checks both @q and @q_compact in each field
  return `
    (IS_DEFINED(c.company_name) AND IS_STRING(c.company_name) AND (CONTAINS(LOWER(c.company_name), @q) OR CONTAINS(REPLACE(LOWER(c.company_name), " ", ""), @q_compact))) OR
    (IS_DEFINED(c.display_name) AND IS_STRING(c.display_name) AND (CONTAINS(LOWER(c.display_name), @q) OR CONTAINS(REPLACE(LOWER(c.display_name), " ", ""), @q_compact))) OR
    (IS_DEFINED(c.name) AND IS_STRING(c.name) AND (CONTAINS(LOWER(c.name), @q) OR CONTAINS(REPLACE(LOWER(c.name), " ", ""), @q_compact))) OR
    (IS_DEFINED(c.product_keywords) AND IS_STRING(c.product_keywords) AND (CONTAINS(LOWER(c.product_keywords), @q) OR CONTAINS(REPLACE(LOWER(c.product_keywords), " ", ""), @q_compact))) OR
    (
      IS_ARRAY(c.product_keywords) AND
      ARRAY_LENGTH(
        ARRAY(
          SELECT VALUE kw
          FROM kw IN c.product_keywords
          WHERE IS_STRING(kw) AND (CONTAINS(LOWER(kw), @q) OR CONTAINS(REPLACE(LOWER(kw), " ", ""), @q_compact))
        )
      ) > 0
    ) OR
    (IS_DEFINED(c.keywords) AND IS_STRING(c.keywords) AND (CONTAINS(LOWER(c.keywords), @q) OR CONTAINS(REPLACE(LOWER(c.keywords), " ", ""), @q_compact))) OR
    (
      IS_ARRAY(c.keywords) AND
      ARRAY_LENGTH(
        ARRAY(
          SELECT VALUE k
          FROM k IN c.keywords
          WHERE IS_STRING(k) AND (CONTAINS(LOWER(k), @q) OR CONTAINS(REPLACE(LOWER(k), " ", ""), @q_compact))
        )
      ) > 0
    ) OR
    (IS_DEFINED(c.industries) AND IS_STRING(c.industries) AND (CONTAINS(LOWER(c.industries), @q) OR CONTAINS(REPLACE(LOWER(c.industries), " ", ""), @q_compact))) OR
    (
      IS_ARRAY(c.industries) AND
      ARRAY_LENGTH(
        ARRAY(
          SELECT VALUE i
          FROM i IN c.industries
          WHERE IS_STRING(i) AND (CONTAINS(LOWER(i), @q) OR CONTAINS(REPLACE(LOWER(i), " ", ""), @q_compact))
        )
      ) > 0
    ) OR
    (IS_DEFINED(c.normalized_domain) AND IS_STRING(c.normalized_domain) AND (CONTAINS(LOWER(c.normalized_domain), @q) OR CONTAINS(REPLACE(LOWER(c.normalized_domain), " ", ""), @q_compact))) OR
    (IS_DEFINED(c.amazon_url) AND IS_STRING(c.amazon_url) AND (CONTAINS(LOWER(c.amazon_url), @q) OR CONTAINS(REPLACE(LOWER(c.amazon_url), " ", ""), @q_compact)))
  `;
}

/**
 * Build a normalized search filter for Cosmos SQL
 * Uses word boundary matching on search_text_norm and contains matching on search_text_compact
 * Returns SQL fragment and updates params array
 */
function buildNormalizedSearchFilter(terms_norm, terms_compact, params) {
  if (!terms_norm.length && !terms_compact.length) {
    return "";
  }

  const conditions = [];
  let paramIndex = 1;

  // For each normalized term, add a boundary-matched condition
  for (const term of terms_norm) {
    if (term) {
      const paramName = `@norm${paramIndex}`;
      // Store with leading and trailing spaces for word boundary matching
      params.push({ name: paramName, value: ` ${term} ` });
      conditions.push(`(IS_DEFINED(c.search_text_norm) AND IS_STRING(c.search_text_norm) AND CONTAINS(c.search_text_norm, ${paramName}))`);
      paramIndex++;
    }
  }

  // For each compact term, add a contains condition
  for (const term of terms_compact) {
    if (term) {
      const paramName = `@comp${paramIndex}`;
      params.push({ name: paramName, value: term });
      conditions.push(`(IS_DEFINED(c.search_text_compact) AND IS_STRING(c.search_text_compact) AND CONTAINS(c.search_text_compact, ${paramName}))`);
      paramIndex++;
    }
  }

  // Also search original terms against stemmed document fields for cross-matching
  // (e.g., query "icebreakers" stemmed to "icebreaker" already added above,
  //  but also check unstemmed query against stemmed document text)
  for (const term of terms_norm) {
    if (term) {
      const paramName = `@stm${paramIndex}`;
      params.push({ name: paramName, value: ` ${term} ` });
      conditions.push(`(IS_DEFINED(c.search_text_stemmed) AND IS_STRING(c.search_text_stemmed) AND CONTAINS(c.search_text_stemmed, ${paramName}))`);
      paramIndex++;
    }
  }
  for (const term of terms_compact) {
    if (term) {
      const paramName = `@stmc${paramIndex}`;
      params.push({ name: paramName, value: term });
      conditions.push(`(IS_DEFINED(c.search_text_stemmed_compact) AND IS_STRING(c.search_text_stemmed_compact) AND CONTAINS(c.search_text_stemmed_compact, ${paramName}))`);
      paramIndex++;
    }
  }

  // Join all conditions with OR
  if (conditions.length === 0) return "";
  return conditions.length === 1 ? conditions[0] : `(${conditions.join(" OR ")})`;
}

/**
 * Build a legacy search filter using expanded terms
 * This allows multiple CONTAINS checks for different term variations
 */
function buildLegacySearchFilterWithTerms(terms_norm, terms_compact, params) {
  if (!terms_norm.length && !terms_compact.length) {
    return "";
  }

  const conditions = [];
  // Strip special characters from DB values to match normalizeQuery behavior.
  // normalizeQuery removes [^\w\s] (e.g. &, +, ', ., etc.) so the DB values
  // must be cleaned the same way for CONTAINS to find matches.
  const stripSpecial = (expr) =>
    `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(${expr}), "&", ""), "+", ""), "'", ""), ".", ""), ",", ""), "-", " "), "_", " "), "/", "")`;
  const fieldChecker = (fieldName, paramName) =>
    `(IS_DEFINED(c.${fieldName}) AND IS_STRING(c.${fieldName}) AND CONTAINS(${stripSpecial(`c.${fieldName}`)}, ${paramName}))`;
  const fieldArrayChecker = (arrayField, paramName) =>
    `(IS_ARRAY(c.${arrayField}) AND ARRAY_LENGTH(ARRAY(SELECT VALUE item FROM item IN c.${arrayField} WHERE IS_STRING(item) AND CONTAINS(${stripSpecial("item")}, ${paramName}))) > 0)`;

  const stringFields = ["company_name", "display_name", "name", "normalized_domain", "amazon_url", "product_keywords", "keywords", "industries", "tagline"];
  const arrayFields = ["product_keywords", "keywords", "industries"];
  let paramIndex = 1;

  // For each term, add conditions for all fields
  const allTerms = [...new Set([...terms_norm, ...terms_compact])];

  for (const term of allTerms) {
    if (term) {
      const paramName = `@term${paramIndex}`;
      params.push({ name: paramName, value: term.toLowerCase() });

      // Add conditions for each string field
      for (const field of stringFields) {
        conditions.push(fieldChecker(field, paramName));
      }

      // Add array field conditions (these handle when fields are arrays)
      for (const field of arrayFields) {
        conditions.push(fieldArrayChecker(field, paramName));
      }

      paramIndex++;
    }
  }

  // Join all conditions with OR
  if (conditions.length === 0) return "";
  return conditions.length === 1 ? conditions[0] : `(${conditions.join(" OR ")})`;
}

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

  // Normalized search fields (for normalized query matching)
  "c.search_text_norm",
  "c.search_text_compact",
  "c.search_text_stemmed",
  "c.search_text_stemmed_compact",

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
  "c.notes_entries",

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

/**
 * Deduplicate companies by normalized_domain.
 * When multiple records share the same domain, keep the best one
 * (most reviews → most complete profile → most recently updated).
 */
function deduplicateByDomain(companies) {
  if (!Array.isArray(companies) || companies.length <= 1) return companies;

  const byDomain = new Map();
  const noDomain = [];

  for (const c of companies) {
    const domain = String(c?.normalized_domain || "").trim().toLowerCase();
    if (!domain || domain === "unknown") {
      noDomain.push(c);
      continue;
    }
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(c);
  }

  const result = [...noDomain];
  for (const [, group] of byDomain) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    // Pick the best record: most reviews → highest profile_completeness → newest _ts
    group.sort((a, b) => {
      const ra = Number(a?.review_count || 0);
      const rb = Number(b?.review_count || 0);
      if (rb !== ra) return rb - ra;

      const pa = Number(a?.profile_completeness || 0);
      const pb = Number(b?.profile_completeness || 0);
      if (pb !== pa) return pb - pa;

      const ta = Number(a?._ts || 0);
      const tb = Number(b?._ts || 0);
      return tb - ta;
    });
    result.push(group[0]);
  }

  return result;
}

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

  const notes_entries = Array.isArray(doc.notes_entries)
    ? doc.notes_entries
        .filter((n) => n && typeof n === "object" && (n.is_public === true || String(n.is_public).toLowerCase() === "true"))
        .slice(0, 20)
    : [];

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
    company_name:
      asString(doc.company_name).trim() ||
      asString(doc.display_name).trim() ||
      asString(doc.name).trim() ||
      deriveNameFromHost(asString(doc.normalized_domain).trim() || website_url) ||
      "Unknown company",
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
    notes_entries,
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
  // Log inbound request for wiring diagnostics (helps trace requests from frontend to Function App)
  logInboundRequest(context, req, "search-companies");

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

  // Support both old style (q param) and new style (raw, norm, compact params)
  const qRawParam = url.searchParams.get("raw") || url.searchParams.get("q") || "";
  const qNormParam = url.searchParams.get("norm") || "";
  const qCompactParam = url.searchParams.get("compact") || "";

  // If we get raw/norm/compact from frontend, use them directly; otherwise parse from q
  let q_raw, q_norm, q_compact;
  if (qNormParam || qCompactParam) {
    // New style: frontend provided normalized forms
    q_raw = qRawParam;
    q_norm = qNormParam;
    q_compact = qCompactParam;
  } else {
    // Old style or fallback: parse from raw query
    const parsed = parseQuery(qRawParam);
    q_raw = parsed.q_raw;
    q_norm = parsed.q_norm;
    q_compact = parsed.q_compact;
  }

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

      // Expand query terms using synonyms
      let terms_norm = [], terms_compact = [];
      let whereTextFilter = "";
      if (q_norm) {
        const expansion = await expandQueryTerms(q_norm, q_compact);
        terms_norm = expansion.terms_norm;
        terms_compact = expansion.terms_compact;

        // Build WHERE clause for normalized and compact term matching
        whereTextFilter = buildNormalizedSearchFilter(terms_norm, terms_compact, params);
      }

      const softDeleteFilter = "(NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, 'refresh_job_') AND NOT STARTSWITH(c.id, '_import_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')";

      if (sort === "manu") {
        // Build search filter using expanded terms
        let searchFilter = "";
        let sqlParams = [{ name: "@take", value: limit }];
        if (q_norm) {
          // Build legacy filter with expanded terms
          const legacyFilter = buildLegacySearchFilterWithTerms(terms_norm, terms_compact, sqlParams);
          searchFilter = whereTextFilter
            ? `AND (((${whereTextFilter}) OR (${legacyFilter})) AND ${softDeleteFilter})`
            : `AND ((${legacyFilter}) AND ${softDeleteFilter})`;

          // Add normalized search parameters
          if (whereTextFilter) {
            sqlParams.push(...params.filter(p => p.name.startsWith("@norm") || p.name.startsWith("@comp")));
          }
        } else {
          searchFilter = `AND ${softDeleteFilter}`;
        }

        const sqlA = `
            SELECT TOP @take ${SELECT_FIELDS}
            FROM c
            WHERE IS_ARRAY(c.manufacturing_locations) AND ARRAY_LENGTH(c.manufacturing_locations) > 0
            ${searchFilter}
            ORDER BY c._ts DESC
          `;
        const paramsA = [...sqlParams];

        const partA = await container.items
          .query({ query: sqlA, parameters: paramsA }, { enableCrossPartitionQuery: true })
          .fetchAll();
        items = partA.resources || [];

        const remaining = Math.max(0, limit - items.length);
        if (remaining > 0) {
          const sqlB = `
              SELECT TOP @take2 ${SELECT_FIELDS}
              FROM c
              WHERE (NOT IS_ARRAY(c.manufacturing_locations) OR ARRAY_LENGTH(c.manufacturing_locations) = 0)
              ${searchFilter}
              ORDER BY c._ts DESC
            `;
          const paramsB = sqlParams.map(p => p.name === "@take" ? { name: "@take2", value: remaining } : p);

          const partB = await container.items
            .query({ query: sqlB, parameters: paramsB }, { enableCrossPartitionQuery: true })
            .fetchAll();
          items = items.concat(partB.resources || []);
        }
      } else {
        const orderBy = sort === "name" ? "ORDER BY c.company_name ASC" : "ORDER BY c._ts DESC";
        let searchFilter = "";
        let queryParams = [{ name: "@take", value: limit }];
        if (q_norm) {
          // Build legacy filter with expanded terms
          const legacyFilter = buildLegacySearchFilterWithTerms(terms_norm, terms_compact, queryParams);
          searchFilter = whereTextFilter
            ? `AND (((${whereTextFilter}) OR (${legacyFilter})) AND ${softDeleteFilter})`
            : `AND ((${legacyFilter}) AND ${softDeleteFilter})`;

          // Add normalized search parameters
          if (whereTextFilter) {
            queryParams.push(...params.filter(p => p.name.startsWith("@norm") || p.name.startsWith("@comp")));
          }
        } else {
          searchFilter = `AND ${softDeleteFilter}`;
        }

        const sql = `
            SELECT TOP @take ${SELECT_FIELDS}
            FROM c
            WHERE 1=1
            ${searchFilter}
            ${orderBy}
          `;

        const res = await container.items
          .query({ query: sql, parameters: queryParams }, { enableCrossPartitionQuery: true })
          .fetchAll();
        items = res.resources || [];
      }

      // Fuzzy fallback: when exact search yields < 3 results and query is long enough,
      // try a prefix-based search then post-filter with Levenshtein distance.
      if (items.length < 3 && q_norm && q_norm.length >= 4) {
        try {
          const prefix = q_norm.substring(0, Math.min(4, q_norm.length));
          const fuzzyParams = [
            { name: "@fuzzyTake", value: limit },
            { name: "@prefix", value: prefix },
          ];
          const fuzzySql = `
            SELECT TOP @fuzzyTake ${SELECT_FIELDS}
            FROM c
            WHERE (
              (IS_DEFINED(c.company_name) AND IS_STRING(c.company_name) AND STARTSWITH(LOWER(c.company_name), @prefix)) OR
              (IS_DEFINED(c.display_name) AND IS_STRING(c.display_name) AND STARTSWITH(LOWER(c.display_name), @prefix)) OR
              (IS_DEFINED(c.name) AND IS_STRING(c.name) AND STARTSWITH(LOWER(c.name), @prefix)) OR
              (IS_DEFINED(c.normalized_domain) AND IS_STRING(c.normalized_domain) AND STARTSWITH(LOWER(c.normalized_domain), @prefix))
            ) AND ${softDeleteFilter}
            ORDER BY c._ts DESC
          `;
          const fuzzyRes = await container.items
            .query({ query: fuzzySql, parameters: fuzzyParams }, { enableCrossPartitionQuery: true })
            .fetchAll();
          const fuzzyCandidates = fuzzyRes.resources || [];
          const existingIds = new Set(items.map((i) => i.id));
          for (const candidate of fuzzyCandidates) {
            if (existingIds.has(candidate.id)) continue;
            const names = [candidate.company_name, candidate.display_name, candidate.name, candidate.normalized_domain].filter(Boolean);
            if (names.some((n) => isFuzzyNameMatch(n, q_norm))) {
              candidate._fuzzyMatch = true;
              items.push(candidate);
              existingIds.add(candidate.id);
            }
          }
        } catch (fuzzyErr) {
          // Fuzzy fallback is best-effort; don't fail the search
          context.log("search-companies fuzzy fallback error:", fuzzyErr?.message);
        }
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
        .map((r) => {
          const pub = mapCompanyToPublic(r);
          if (pub && r._fuzzyMatch) pub._fuzzyMatch = true;
          return pub;
        })
        .filter((c) => c && c.id);

      // Deduplicate by normalized_domain — keep only the best record per domain.
      // This prevents duplicate company records (same domain, different IDs) from
      // showing multiple times in search results.
      const deduped = deduplicateByDomain(mapped);

      // Attach relevance scores so the frontend can prioritise strong matches
      if (q_norm) {
        for (const company of deduped) {
          if (company._fuzzyMatch) {
            // Fuzzy matches get a reduced score based on edit distance
            const names = [company.company_name, company.display_name, company.name, company.normalized_domain].filter(Boolean);
            let bestFuzzy = 0;
            for (const n of names) {
              bestFuzzy = Math.max(bestFuzzy, fuzzyScore(n, q_norm));
            }
            company._nameMatchScore = 0;
            company._keywordMatchScore = 0;
            company._relevanceScore = bestFuzzy;
            company._matchType = "fuzzy";
            delete company._fuzzyMatch;
          } else {
            const scores = computeRelevanceScore(company, q_raw, q_norm, q_compact);
            company._nameMatchScore = scores._nameMatchScore;
            company._keywordMatchScore = scores._keywordMatchScore;
            company._relevanceScore = scores._relevanceScore;
            company._matchType = "exact";
          }
        }
      }

      if (sortField) {
        deduped.sort((a, b) => compareCompanies(sortField, sortDir, a, b));
      }

      const paged = deduped.slice(skip, skip + take);

      return json(
        {
          ok: true,
          success: true,
          ...(cosmosTarget ? cosmosTarget : {}),
          items: paged,
          count: deduped.length,
          meta: { q: q_raw, sort, skip, take, user_location },
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
        q_norm,
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

module.exports.handler = searchCompaniesHandler;
module.exports._test = {
  SELECT_FIELDS,
  normalizeStringArray,
  mapCompanyToPublic,
  searchCompaniesHandler,
  computeNameMatchScore,
  computeKeywordMatchScore,
  computeRelevanceScore,
};
