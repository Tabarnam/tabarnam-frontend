let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const { CosmosClient } = require("@azure/cosmos");
const { getContainerPartitionKeyPath } = require("../_cosmosPartitionKey");
const { logInboundRequest } = require("../_diagnostics");
const { parseQuery, foldDiacritics } = require("../_queryNormalizer");
const { expandQueryTermsForFTS, expandProductSynonyms } = require("../_searchSynonyms");
const { isFuzzyNameMatch, damerauLevenshtein } = require("../_fuzzyMatch");
const { simpleStem, stemWords } = require("../_stemmer");
const {
  loadIndustryAffinityIndex,
  getAffinityIndustriesFromIndex,
} = require("../_industryAffinityIndex");

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
    "star5" in value ||
    "star6" in value
  );
}

function calculateTotalScore(rating) {
  if (!rating || typeof rating !== "object") return 0;
  // star6 is admin discretion (max 1.0). Total still clamps to 0–5; the visible
  // star strip is fixed at 5 icons, with star6 acting as a weighting lever.
  const starKeys = ["star1", "star2", "star3", "star4", "star5", "star6"];
  let total = 0;
  for (const k of starKeys) {
    const v = rating[k];
    const n = typeof v === "object" ? toFiniteNumber(v?.value) : toFiniteNumber(v);
    total += n || 0;
  }
  return clamp(total, 0, 5);
}

// Haversine distance in kilometres between two lat/lng points.
function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Extract {lat,lng} from various object shapes (geocode results, location records, etc.)
function extractLatLng(obj) {
  if (!obj || typeof obj !== "object") return null;
  const lat = toFiniteNumber(obj.lat ?? obj.latitude);
  const lng = toFiniteNumber(obj.lng ?? obj.lon ?? obj.longitude);
  if (lat != null && lng != null) return { lat, lng };
  if (obj.location && typeof obj.location === "object") {
    const locLat = toFiniteNumber(obj.location.lat ?? obj.location.latitude);
    const locLng = toFiniteNumber(obj.location.lng ?? obj.location.lon ?? obj.location.longitude);
    if (locLat != null && locLng != null) return { lat: locLat, lng: locLng };
  }
  return null;
}

// Find the nearest manufacturing location distance (in km) for a company.
// Returns Infinity if no manufacturing geocodes are available.
function nearestManuDistKm(company, userLat, userLng) {
  const geos = Array.isArray(company.manufacturing_geocodes) && company.manufacturing_geocodes.length
    ? company.manufacturing_geocodes
    : Array.isArray(company.manufacturing_locations) ? company.manufacturing_locations : [];
  let best = Infinity;
  for (const g of geos) {
    const coords = typeof g === "object" ? extractLatLng(g) : null;
    if (!coords) continue;
    const d = haversineKm(userLat, userLng, coords.lat, coords.lng);
    if (Number.isFinite(d) && d < best) best = d;
  }
  return best;
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

function clean(value) {
  return asString(value).trim();
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

  // Fold diacritics BEFORE the strip so "Béis" → "beis" (not "bis" — \w is ASCII-only
  // so é would otherwise be treated as punctuation and deleted entirely).
  const rawNorm = q_raw ? foldDiacritics(q_raw.toLowerCase()).replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim() : "";
  const queries = [
    rawNorm,
    q_norm ? q_norm.toLowerCase().trim() : "",
    q_compact ? q_compact.toLowerCase().trim() : "",
  ].filter(Boolean);

  const uniqueQueries = [...new Set(queries)];
  if (!uniqueQueries.length || !names.length) return 0;

  let best = 0;

  for (const rawName of names) {
    // Fold diacritics so "Béis" (company name) normalizes the same way as "beis" (query).
    const nameLower = foldDiacritics(rawName.toLowerCase()).replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
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
      // Query starts with company name: "watson farms beef" starts with "watson farms"
      // The user is searching for the company + a product qualifier
      if (q.startsWith(nameLower) || q.startsWith(nameCompact)) {
        best = Math.max(best, 70);
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
 * Checks product_keywords, keywords, and industries for match quality.
 *
 * Base scores per keyword:
 *   100 = exact keyword match (query === keyword)
 *    70 = query appears at a word boundary in a multi-word keyword
 *    60 = keyword starts with query or query starts with keyword
 *    20 = query is a non-boundary substring of keyword (e.g., "water" in "freshwater")
 *    25 = keyword is a substring of query
 *     0 = no keyword match
 *
 * Modifiers:
 *   Frequency multiplier: more matching keywords → higher score (×1.0 / ×1.15 / ×1.3)
 *   Multi-term coupling: "cotton sheets" → companies matching BOTH words get +25 bonus
 *   Partial coverage penalty: matching only 1 of N query words → score × 0.6
 */
function computeKeywordMatchScore(company, q_norm, q_compact) {
  if (!company || (!q_norm && !q_compact)) return 0;

  const queryTerms = [q_norm, q_compact].filter(Boolean).map((t) => t.toLowerCase());
  if (!queryTerms.length) return 0;

  // For multi-word coupling: split query into individual words
  const queryWords = (q_norm || "").toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  const coveredWords = new Set();

  let best = 0;
  let matchCount = 0;

  const checkField = (arr) => {
    for (const raw of arr) {
      const kw = asString(raw).toLowerCase().trim();
      if (!kw) continue;
      let matched = false;
      for (const qt of queryTerms) {
        if (kw === qt) {
          best = Math.max(best, 100);
          matched = true;
        } else if (kw.startsWith(qt) || qt.startsWith(kw)) {
          best = Math.max(best, 60);
          matched = true;
        } else if (kw.includes(qt)) {
          const idx = kw.indexOf(qt);
          const atWordBoundary = idx === 0 || /\s/.test(kw[idx - 1]);
          best = Math.max(best, atWordBoundary ? 70 : 20);
          matched = true;
        } else if (qt.includes(kw)) {
          best = Math.max(best, 25);
          matched = true;
        }
      }
      // Per-word matching: for multi-word queries, check individual query words
      // against each keyword. "watson farms beef" → "beef" matches keyword "Beef Brisket"
      if (!matched && queryWords.length >= 2) {
        for (const w of queryWords) {
          if (kw === w) {
            best = Math.max(best, 60);
            matched = true;
          } else if (kw.startsWith(w + " ") || kw.endsWith(" " + w) || kw.includes(" " + w + " ")) {
            best = Math.max(best, 50);
            matched = true;
          }
        }
      }
      // Track which individual query words this keyword covers.
      // Must be a word-boundary match — using raw substring (kw.includes(w))
      // wrongly counted "bluetooth" as covering "tooth", letting kitchen
      // appliances rank above oral-care companies for a "tooth scraper" query.
      if (queryWords.length >= 2) {
        for (const w of queryWords) {
          if (
            kw === w ||
            kw.startsWith(w + " ") ||
            kw.endsWith(" " + w) ||
            kw.includes(" " + w + " ")
          ) {
            coveredWords.add(w);
          }
        }
      }
      if (matched) matchCount++;
    }
  };

  checkField(normalizeStringArray(company.product_keywords));
  checkField(normalizeStringArray(company.keywords));
  checkField(normalizeStringArray(company.industries));

  if (best === 0) return 0;

  // Frequency multiplier: more matching keywords = more relevant
  const freqMult = matchCount >= 3 ? 1.3 : matchCount >= 2 ? 1.15 : 1.0;

  // Multi-term coupling bonus/penalty for multi-word queries
  let couplingAdj = 0;
  if (queryWords.length >= 2) {
    if (coveredWords.size >= queryWords.length) {
      // All query words covered by keywords → strong relevance signal
      couplingAdj = 25;
    } else if (coveredWords.size <= 1) {
      // Only 1 (or 0) of N query words covered → weak match, penalize
      return Math.round(best * 0.6);
    }
  }

  return Math.min(130, Math.round(best * freqMult) + couplingAdj);
}

/**
 * Check whether a company matched the original query directly, or only via
 * synonym expansion (e.g., "hoodie" → "sweatshirt"/"pullover").
 *
 * Returns true if the company has NO direct match on the original query in
 * its name, keywords, product_keywords, industries, or search_text_norm —
 * meaning it only appeared in results because a synonym matched.
 *
 * For MULTI-WORD queries, a company counts as "directly matching" if ANY of
 * the query words appears at a word boundary in its data. Before this rule
 * was added, a keyword like "scraper mixer pro" against query "tooth scraper"
 * failed the full-phrase check and was wrongly flagged synonym-only — taking
 * a ×0.4 penalty that, combined with the substring penalty and MIN_RELEVANCE
 * cutoff, removed the company from results entirely. That's too aggressive:
 * a direct partial match is a real match, not a synonym match.
 */
function isSynonymOnlyMatch(company, q_norm, q_compact) {
  if (!q_norm) return false;

  const names = [
    asString(company.company_name),
    asString(company.display_name),
    asString(company.name),
  ].filter(Boolean).map((n) => n.toLowerCase());

  for (const name of names) {
    if (name.includes(q_norm) || (q_compact && name.replace(/\s+/g, "").includes(q_compact))) {
      return false; // direct name match on the whole phrase
    }
  }

  const allKeywords = [
    ...normalizeStringArray(company.product_keywords),
    ...normalizeStringArray(company.keywords),
    ...normalizeStringArray(company.industries),
  ].map((k) => asString(k).toLowerCase().trim()).filter(Boolean);

  for (const kw of allKeywords) {
    if (kw.includes(q_norm) || q_norm.includes(kw)) return false;
    if (q_compact && (kw.includes(q_compact) || q_compact.includes(kw))) return false;
  }

  const stn = asString(company.search_text_norm).toLowerCase();
  if (stn && (stn.includes(` ${q_norm} `) || stn.includes(q_norm))) {
    return false; // direct search_text_norm match on the whole phrase
  }

  // Multi-word partial-match rule: if any query word appears at a word
  // boundary in any of the company's fields, it's a real (partial) match,
  // not a synonym-only match.
  const queryWords = q_norm.split(/\s+/).filter((w) => w.length >= 2);
  if (queryWords.length >= 2) {
    for (const w of queryWords) {
      for (const kw of allKeywords) {
        if (
          kw === w ||
          kw.startsWith(w + " ") ||
          kw.endsWith(" " + w) ||
          kw.includes(" " + w + " ")
        ) {
          return false;
        }
      }
      if (stn && stn.includes(` ${w} `)) return false;
    }
  }

  return true;
}

/**
 * Compute a composite relevance score combining name and keyword match quality.
 * When a name match exists: name 70%, keyword 30%, plus a +20 bonus for
 * strong name matches (word-boundary or better, nameScore ≥ 60) so that
 * companies whose name matches the query always outrank keyword-only matches.
 * When no name match: keyword gets 60% weight to widen the scoring gap
 * (otherwise all keyword-only matches compress into 0-30 range).
 * Industry exact match adds +15 bonus (companies categorized under the query term).
 * Synonym-only penalty: companies matching only via synonym expansion (not the
 * original query) get a 60% score reduction so direct matches always rank higher.
 */
function computeRelevanceScore(company, q_raw, q_norm, q_compact, affinityIndustries = []) {
  const nameScore = computeNameMatchScore(company, q_raw, q_norm, q_compact);
  const keywordScore = computeKeywordMatchScore(company, q_norm, q_compact);
  const nameBonus = nameScore >= 60 ? 20 : 0;

  // Industry match bonus — fires when the query appears in any of the
  // company's industry tags. Previously this required *exact* equality
  // ("peppercorn" only matched an industry literally called "peppercorn"),
  // which meant a niche peppercorn specialist with industry "Peppercorns"
  // or "Specialty Peppercorns" missed the bonus entirely. A butcher shop
  // with peppercorn-crusted steaks in its product list could then outrank
  // the specialist on pure keyword frequency. The bonus now fires on:
  //   - exact match: industry === query
  //   - industry contains query as substring/word: "peppercorns" / "spices — peppercorn"
  //   - query contains industry as substring: "seafood" query matching "food"
  // The set of industries per company is small (typically 1-5 tags), so the
  // includes() check is cheap. Combined with the relevance tier sort, this
  // promotes specialty companies into tier 0 — where they should be when
  // the user is searching for their specific product category.
  const industries = normalizeStringArray(company.industries).map((s) => asString(s).toLowerCase().trim());
  const qLower = (q_norm || "").toLowerCase().trim();
  const industryBonus =
    qLower && industries.some((ind) =>
      ind === qLower ||
      ind.includes(qLower) ||
      qLower.includes(ind)
    )
      ? 30
      : 0;

  // Industry-affinity bonus — the list of "expected" industries for this query
  // is derived from the data-driven inverted index (see _industryAffinityIndex.js)
  // and supplied by the caller, so we don't reload it per company. When the
  // query has any affinity industries:
  //   +25 bonus for companies IN one of those industries
  //   -15 penalty for companies NOT in any of them
  // This creates a 40-point gap between aligned and non-aligned companies.
  const hasAffinity = affinityIndustries.length > 0 &&
    industries.some((ind) => affinityIndustries.some((aff) => ind.includes(aff.toLowerCase())));
  const affinityBonus = hasAffinity ? 25 : (affinityIndustries.length > 0 ? -15 : 0);

  let relevanceScore = nameScore > 0
    ? Math.round(nameScore * 0.7 + keywordScore * 0.3) + nameBonus + industryBonus + affinityBonus
    : Math.round(keywordScore * 0.6) + industryBonus + affinityBonus;

  // Synonym-only penalty: companies that matched only via synonym expansion
  // (e.g., a coffee company with "sweatshirt" merch matching "hoodie" query)
  // get demoted so direct-match companies always rank above them.
  const synonymOnly = isSynonymOnlyMatch(company, q_norm, q_compact);
  if (synonymOnly) {
    relevanceScore = Math.round(relevanceScore * 0.4);
  }

  // Floor at 0 — negative scores shouldn't happen
  relevanceScore = Math.max(0, relevanceScore);

  return { _nameMatchScore: nameScore, _keywordMatchScore: keywordScore, _relevanceScore: relevanceScore, _synonymOnly: synonymOnly };
}

// Coarse relevance tiers used by the "Highest rated" sort so that strong
// matches (especially exact name matches) cannot be demoted by less-relevant
// results that happen to have higher star ratings.
//
// Exact name matches (nameScore >= 100) get their own bucket above every other
// tier so that e.g. searching "Jerky & Spice" always puts the actual Jerky &
// Spice company first — even when a food-adjacent competitor (Nesco, Tanners)
// lands in tier 0 via keyword + industry-affinity bonuses and happens to have
// a slightly higher star rating. `nameScore` comes from _nameMatchScore, which
// `computeRelevanceScore` already attaches to each company record.
function relevanceTier(score, nameScore = 0) {
  if (nameScore >= 100) return -1; // exact name match — always first
  if (score >= 90) return 0;       // very-relevant non-exact match
  if (score >= 60) return 1;       // strong name or keyword match
  if (score >= 30) return 2;       // moderate match
  return 3;                        // weak match
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
    (IS_DEFINED(c.amazon_url) AND IS_STRING(c.amazon_url) AND (CONTAINS(LOWER(c.amazon_url), @q) OR CONTAINS(REPLACE(LOWER(c.amazon_url), " ", ""), @q_compact))) OR
    (IS_DEFINED(c.search_text_norm) AND IS_STRING(c.search_text_norm) AND CONTAINS(c.search_text_norm, @q))
  `;
}

/**
 * Build a word-boundary search filter using the space-padded search_text_norm
 * and search_text_stemmed fields stored in Cosmos DB.
 *
 * Because search_text_norm is stored as " word1 word2 word3 " (space-padded),
 * CONTAINS(field, " robes ") matches only the whole word "robes" and NOT
 * "bathrobes" or "wardrobes". This provides precise, high-relevance matches.
 *
 * @param {string} q_norm - Normalized query (e.g., "robes")
 * @param {string} q_stemmed - Stemmed query (e.g., "robe")
 * @param {string} q_compact - Compact query (e.g., "robes")
 * @param {Array} params - Mutable params array to push new parameters into
 * @returns {string} SQL WHERE fragment
 */
function buildWordBoundaryFilter(q_norm, q_stemmed, q_compact, params) {
  const clauses = [];

  // 1. Word-boundary match on search_text_norm (space-padded field)
  //    " robes " matches in " acme corp robes clothing " but NOT " bathrobes "
  params.push({ name: "@q_wb", value: ` ${q_norm} ` });
  clauses.push(
    `(IS_DEFINED(c.search_text_norm) AND IS_STRING(c.search_text_norm) AND CONTAINS(c.search_text_norm, @q_wb))`
  );

  // 2. Stemmed word-boundary match on search_text_stemmed (space-padded field)
  //    " robe " matches stemmed text, catching singular/plural variations
  if (q_stemmed && q_stemmed !== q_norm) {
    params.push({ name: "@q_stemmed_wb", value: ` ${q_stemmed} ` });
    clauses.push(
      `(IS_DEFINED(c.search_text_stemmed) AND IS_STRING(c.search_text_stemmed) AND CONTAINS(c.search_text_stemmed, @q_stemmed_wb))`
    );
  }

  // 3. Multi-word queries: each word checked with word boundary (AND logic)
  //    "silk robes" → " silk " AND " robes " both present as whole words
  const words = q_norm.split(/\s+/).filter((w) => w.length >= 2);
  if (words.length >= 2) {
    const wordClauses = words.map((word, i) => {
      const paramName = `@q_mw${i}`;
      params.push({ name: paramName, value: ` ${word} ` });
      return `CONTAINS(c.search_text_norm, ${paramName})`;
    });
    clauses.push(
      `(IS_DEFINED(c.search_text_norm) AND IS_STRING(c.search_text_norm) AND ${wordClauses.join(" AND ")})`
    );

    // Also try stemmed per-word matching
    const stemmedWords = words.map((w) => simpleStem(w));
    const hasStemmedDiff = stemmedWords.some((sw, i) => sw !== words[i]);
    if (hasStemmedDiff) {
      const stemmedWordClauses = stemmedWords.map((word, i) => {
        const paramName = `@q_msw${i}`;
        params.push({ name: paramName, value: ` ${word} ` });
        return `CONTAINS(c.search_text_stemmed, ${paramName})`;
      });
      clauses.push(
        `(IS_DEFINED(c.search_text_stemmed) AND IS_STRING(c.search_text_stemmed) AND ${stemmedWordClauses.join(" AND ")})`
      );
    }
  }

  // 4. Exact company name match (case-insensitive)
  params.push({ name: "@q_name", value: q_norm });
  clauses.push(
    `(IS_DEFINED(c.company_name) AND IS_STRING(c.company_name) AND LOWER(c.company_name) = @q_name)`
  );
  clauses.push(
    `(IS_DEFINED(c.display_name) AND IS_STRING(c.display_name) AND LOWER(c.display_name) = @q_name)`
  );

  // 5. Domain matching (substring OK — domains don't have compound-word issues)
  params.push({ name: "@q_domain", value: q_norm });
  clauses.push(
    `(IS_DEFINED(c.normalized_domain) AND IS_STRING(c.normalized_domain) AND CONTAINS(LOWER(c.normalized_domain), @q_domain))`
  );
  if (q_compact && q_compact !== q_norm) {
    params.push({ name: "@q_domain_c", value: q_compact });
    clauses.push(
      `(IS_DEFINED(c.normalized_domain) AND IS_STRING(c.normalized_domain) AND CONTAINS(LOWER(c.normalized_domain), @q_domain_c))`
    );
  }

  return clauses.join(" OR\n    ");
}

/**
 * Build extra CONTAINS clauses for synonym-expanded phrase variants AND per-word matching.
 *
 * When FTS is disabled, the legacy CONTAINS filter only checks the raw query (@q)
 * as an exact substring. This function adds two layers of additional matching:
 *
 * 1. Synonym phrase variants — e.g., "rocky mountain soda co" from "company" → "co"
 * 2. Per-word matching — e.g., "monster" and "beverage" checked individually so that
 *    "monster beverage" finds "Monster Energy" (matched on "monster" word)
 *
 * @param {string[]} phrases - Expanded phrase variants from expandQueryTermsForFTS()
 * @param {string} q_norm - The original normalized query (already covered by @q)
 * @param {Array} params - Mutable params array to push new parameters into
 * @returns {string} SQL fragment like " OR (CONTAINS(c.search_text_norm, @q_v0) OR ...)"
 *                   or empty string if no extra variants
 */
function buildVariantContainsClauses(phrases, q_norm, params) {
  const variantClauses = [];

  // 1. Synonym phrase variants (e.g., "rocky mountain soda co")
  phrases.forEach((phrase, i) => {
    if (phrase === q_norm) return; // already covered by @q in the legacy filter
    const paramName = `@q_v${i}`;
    params.push({ name: paramName, value: phrase });
    variantClauses.push(`CONTAINS(c.search_text_norm, ${paramName})`);
    // Also check compact form (no spaces) for concatenated domain/name matches
    const compact = phrase.replace(/\s+/g, "");
    if (compact !== phrase) {
      const compactParam = `@q_vc${i}`;
      params.push({ name: compactParam, value: compact });
      variantClauses.push(`CONTAINS(c.search_text_compact, ${compactParam})`);
    }
  });

  // 2. Per-word matching for multi-word queries.
  //    "monster beverage" → check "monster" AND "beverage" together.
  //    This ensures "Monster Energy" is found even though the full phrase
  //    "monster beverage" doesn't appear in the document, while preventing
  //    single-word matches (e.g., "bone broth" matching a company with just "bone").
  const words = q_norm.split(/\s+/).filter((w) => w.length >= 3);
  if (words.length >= 2) {
    const wordClauses = [];
    words.forEach((word, i) => {
      const paramName = `@q_w${i}`;
      params.push({ name: paramName, value: word });
      wordClauses.push(`CONTAINS(c.search_text_norm, ${paramName})`);
    });
    variantClauses.push(`(${wordClauses.join(" AND ")})`);
  }

  if (variantClauses.length === 0) return "";
  return ` OR (IS_DEFINED(c.search_text_norm) AND (${variantClauses.join(" OR ")}))`;
}

/**
 * Sanitize a search token for safe inline use in Cosmos DB FTS SQL.
 *
 * Cosmos DB FTS functions (FullTextContains, FullTextContainsAll, FullTextScore)
 * require string literals — parameterized values (@param) are a known gap that
 * causes 500 errors on cross-partition queries.  Because tokens are inlined we
 * strip everything except alphanumerics, spaces, and hyphens to prevent any
 * injection risk.
 */
function sanitizeFTSToken(token) {
  if (!token || typeof token !== "string") return "";
  return token.replace(/[^a-zA-Z0-9\s\-]/g, "").trim();
}

/**
 * Build a Cosmos DB Full-Text Search query from expanded phrase variants.
 *
 * Each phrase is tokenized into words. For each phrase, a FullTextContainsAll
 * clause is built requiring ALL words to be present. Phrases are OR'd together
 * so that matching ANY synonym variant returns results.
 *
 * IMPORTANT: FTS functions use inline string literals, NOT parameterized values.
 * This is a known limitation of Cosmos DB FTS (confirmed by Azure team).
 *
 * @param {string[]} phrases - Expanded phrase variants (e.g., ["rocky mountain soda company", "rocky mountain soda co"])
 * @returns {{ ftsWhere: string, ftsOrderBy: string }}
 */
function buildFTSQuery(phrases) {
  const allTokens = new Set();
  const phraseGroups = [];

  for (const phrase of phrases) {
    const tokens = phrase
      .split(/\s+/)
      .map(sanitizeFTSToken)
      .filter((t) => t.length > 0);
    if (tokens.length === 0) continue;
    tokens.forEach((t) => allTokens.add(t));
    phraseGroups.push(tokens);
  }

  if (allTokens.size === 0) return { ftsWhere: "", ftsOrderBy: "" };

  // Build FullTextContainsAll clause for each phrase variant using inline literals
  const whereClauses = [];
  for (const tokens of phraseGroups) {
    const literals = tokens.map((t) => `"${t}"`).join(", ");
    if (tokens.length === 1) {
      whereClauses.push(
        `FullTextContains(c.search_text_norm, ${literals})`
      );
    } else {
      whereClauses.push(
        `FullTextContainsAll(c.search_text_norm, ${literals})`
      );
    }
  }

  const ftsWhere =
    whereClauses.length === 1
      ? whereClauses[0]
      : `(${whereClauses.join(" OR ")})`;

  // Build ORDER BY RANK with all unique tokens for BM25 scoring
  const allLiterals = Array.from(allTokens)
    .map((t) => `"${t}"`)
    .join(", ");
  const ftsOrderBy = `ORDER BY RANK FullTextScore(c.search_text_norm, ${allLiterals})`;

  return { ftsWhere, ftsOrderBy };
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

  // Full-text search field (indexed for BM25 search)
  "c.search_text_norm",

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

  // Flags
  "c.limited_manufacturing",
  "c.unknown_manufacturing",
  "c.unknown_hq",

  // UI / misc
  "c.profile_completeness",
  "c.profile_completeness_version",
  "c.logo_url",
  "c.logo_url_dark",
  "c.logoUrl",
  "c.logo",
  "c.homepage_image_url",
  "c.homepage_approved",
  "c.location_sources",
  "c.show_location_sources_to_users",
  "c.visibility",
].join(", ");

/**
 * Deduplicate companies by normalized_domain.
 * When multiple records share the same domain, keep the best one
 * (most reviews → most complete profile → most recently updated).
 */
/**
 * Map an ISO 3166-1 alpha-2 country code to lowercase tokens that commonly
 * appear in free-text location strings (e.g. "San Francisco, CA, USA").
 */
function countryMatchTokens(isoCode) {
  const code = (isoCode || "").toUpperCase();
  if (!code) return [];
  const MAP = {
    US: ["usa", "united states", ", us"],
    GB: ["uk", "united kingdom", "england", "scotland", "wales", "great britain"],
    CA: ["canada"],
    AU: ["australia"],
    DE: ["germany", "deutschland"],
    FR: ["france"],
    IT: ["italy", "italia"],
    ES: ["spain", "españa"],
    JP: ["japan"],
    CN: ["china"],
    KR: ["south korea", "korea"],
    IN: ["india"],
    BR: ["brazil", "brasil"],
    MX: ["mexico", "méxico"],
    NL: ["netherlands", "holland"],
    SE: ["sweden"],
    NO: ["norway"],
    DK: ["denmark"],
    FI: ["finland"],
    NZ: ["new zealand"],
    IE: ["ireland"],
    CH: ["switzerland"],
    AT: ["austria"],
    BE: ["belgium"],
    PT: ["portugal"],
    PL: ["poland"],
    TR: ["turkey", "türkiye"],
    TW: ["taiwan"],
    TH: ["thailand"],
    VN: ["vietnam"],
    PH: ["philippines"],
    ID: ["indonesia"],
    IL: ["israel"],
    ZA: ["south africa"],
    CL: ["chile"],
    CO: ["colombia"],
    AR: ["argentina"],
    PE: ["peru"],
  };
  const tokens = (MAP[code] || []).slice(); // clone
  tokens.push(code.toLowerCase()); // always match the code itself (e.g. ", US")
  return tokens;
}

const COUNTRY_ALIAS_MAP = {
  usa: ["united states", "united states of america", "us"],
  us: ["united states", "united states of america", "usa"],
  uk: ["united kingdom", "great britain", "britain", "gb"],
  gb: ["united kingdom", "great britain", "britain", "uk"],
  gbr: ["united kingdom", "great britain", "britain", "uk"],
  uae: ["united arab emirates"],
};

const STATE_ALIAS_MAP = {
  cali: ["california"],
  ca: ["california"],
  ny: ["new york"],
  nj: ["new jersey"],
  pa: ["pennsylvania"],
  mo: ["missouri"],
  tx: ["texas"],
  fl: ["florida"],
  il: ["illinois"],
  ga: ["georgia"],
  va: ["virginia"],
  wa: ["washington"],
  or: ["oregon"],
  az: ["arizona"],
  co: ["colorado"],
  nc: ["north carolina"],
  sc: ["south carolina"],
  tn: ["tennessee"],
  mi: ["michigan"],
  oh: ["ohio"],
  ma: ["massachusetts"],
  md: ["maryland"],
};

const CITY_ALIAS_MAP = {
  la: ["los angeles"],
  "l a": ["los angeles"],
  sf: ["san francisco"],
  "s f": ["san francisco"],
  philly: ["philadelphia"],
  nyc: ["new york city"],
  "n y c": ["new york city"],
};

function locationTextKey(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s,]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitLocationParts(value) {
  return clean(value)
    .split(",")
    .map((part) => locationTextKey(part))
    .filter(Boolean);
}

function initialismForValue(value) {
  return locationTextKey(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0] || "")
    .join("");
}

function addAliasTokens(targets, map, base) {
  const aliases = map[base] || [];
  aliases.forEach((alias) => {
    const normalized = locationTextKey(alias);
    if (normalized) targets.add(normalized);
  });
}

function addReverseAliasTokens(targets, map, base) {
  for (const [key, aliases] of Object.entries(map)) {
    const normalizedKey = locationTextKey(key);
    const normalizedAliases = Array.isArray(aliases) ? aliases.map((alias) => locationTextKey(alias)).filter(Boolean) : [];
    if (normalizedKey === base || normalizedAliases.includes(base)) {
      if (normalizedKey) targets.add(normalizedKey);
      normalizedAliases.forEach((alias) => targets.add(alias));
    }
  }
}

function locationInputTokens(value, field) {
  const base = locationTextKey(value);
  if (!base) return [];

  const targets = new Set([base]);

  if (field === "country") {
    addAliasTokens(targets, COUNTRY_ALIAS_MAP, base);
    addReverseAliasTokens(targets, COUNTRY_ALIAS_MAP, base);
    if (/^[a-z]{2,3}$/.test(base)) {
      countryMatchTokens(base.toUpperCase()).forEach((token) => {
        const normalized = locationTextKey(token);
        if (normalized) targets.add(normalized);
      });
    }
    return Array.from(targets);
  }

  addAliasTokens(targets, CITY_ALIAS_MAP, base);
  addReverseAliasTokens(targets, CITY_ALIAS_MAP, base);
  addAliasTokens(targets, STATE_ALIAS_MAP, base);
  addReverseAliasTokens(targets, STATE_ALIAS_MAP, base);
  addAliasTokens(targets, COUNTRY_ALIAS_MAP, base);
  addReverseAliasTokens(targets, COUNTRY_ALIAS_MAP, base);

  return Array.from(targets);
}

function locationMatchesCountry(locString, tokens) {
  if (!locString || !tokens.length) return false;
  const lower = locString.toString().toLowerCase();
  // Word-boundary match required. Plain substring matching produces false
  // positives like "Milwaukee, WI, USA" matching the "uk" token (because
  // milwa-UK-ee contains the substring), which let US-based companies pass
  // the GB hqCountry filter. \b treats commas / spaces / start / end as
  // word boundaries, so "uk" only matches as a standalone country code.
  return tokens.some((t) => {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(lower);
  });
}

function locationMatchesInput(locString, input, field) {
  const hay = locationTextKey(locString);
  if (!hay) return false;

  const hayParts = splitLocationParts(locString);
  const hayWords = hay
    .split(/[\s,]+/)
    .map((part) => locationTextKey(part))
    .filter(Boolean);
  const hayInitials = initialismForValue(locString);
  const tokens = locationInputTokens(input, field);

  return tokens.some((target) => {
    if (!target) return false;
    if (hay === target) return true;
    if (hayParts.includes(target)) return true;
    if (hayWords.includes(target)) return true;
    if (target.length > 3 && hay.includes(target)) return true;
    if (target.length <= 3 && hayInitials.includes(target.replace(/\s+/g, ""))) return true;
    return false;
  });
}

function collectCompanyLocationStrings(company) {
  const values = [];
  const push = (value) => {
    const raw =
      typeof value === "string"
        ? clean(value)
        : typeof value?.formatted === "string"
          ? clean(value.formatted)
          : typeof value?.geocode_formatted_address === "string"
            ? clean(value.geocode_formatted_address)
            : clean([
                value?.address,
                value?.city,
                value?.region || value?.state,
                value?.country,
              ]
                .filter(Boolean)
                .join(", "));

    if (raw) values.push(raw);
  };

  push(company.headquarters_location);
  (Array.isArray(company.headquarters) ? company.headquarters : []).forEach(push);
  (Array.isArray(company.headquarters_locations) ? company.headquarters_locations : []).forEach(push);
  (Array.isArray(company.manufacturing_locations) ? company.manufacturing_locations : []).forEach(push);
  (Array.isArray(company.manufacturing_geocodes) ? company.manufacturing_geocodes : []).forEach(push);
  (Array.isArray(company.manufacturing_sites) ? company.manufacturing_sites : []).forEach(push);

  return values;
}

function companyMatchesLocationFilters(company, filters) {
  const country = clean(filters.country);
  const state = clean(filters.state);
  const city = clean(filters.city);
  if (!country && !state && !city) return true;

  const locations = collectCompanyLocationStrings(company);
  if (!locations.length) return false;

  if (country && !locations.some((location) => locationMatchesInput(location, country, "country"))) {
    return false;
  }

  if (state && !locations.some((location) => locationMatchesInput(location, state, "state"))) {
    return false;
  }

  if (city && !locations.some((location) => locationMatchesInput(location, city, "city"))) {
    return false;
  }

  return true;
}

// Lightweight per-field corpus for concept matching: each entry is a single
// cohesive piece of text (one keyword, one industry, the company name, etc.),
// pre-lowercased and diacritic-folded to align with how query concepts are
// normalized upstream. Concepts match against individual entries — a phrase
// like "air compressor" must appear in a single field, not split across two.
function collectCompanyConceptFields(company) {
  const fields = [];
  const add = (v) => {
    const s = foldDiacritics(asString(v).toLowerCase()).trim();
    if (s) fields.push(s);
  };

  add(company?.company_name);
  add(company?.display_name);
  add(company?.name);
  add(company?.tagline);

  for (const kw of normalizeStringArray(company?.product_keywords)) add(kw);
  for (const kw of normalizeStringArray(company?.keywords)) add(kw);
  for (const ind of normalizeStringArray(company?.industries)) add(ind);
  for (const cat of normalizeStringArray(company?.categories)) add(cat);

  return fields;
}

// Does the company satisfy EVERY concept? A concept matches when it appears as
// a phrase (substring for multi-word; word-boundary for single-word) in any
// one collected field, OR when the phrase is found at word boundaries in
// search_text_norm / search_text_stemmed (the space-padded searchable index).
// Both the original and stemmed forms of the concept are tried, so that
// "tires" matches companies whose keyword is "tire inflators" (singular) —
// mirroring how buildWordBoundaryFilter uses search_text_stemmed at retrieval
// time. Without this, Cosmos retrieves Viair for "air compressor, tires" (via
// stemming) but the filter drops it because "tires" doesn't literally appear.
function companyMatchesAllConcepts(company, concepts) {
  if (!Array.isArray(concepts) || concepts.length === 0) return true;

  const fields = collectCompanyConceptFields(company);
  const stn = foldDiacritics(asString(company?.search_text_norm).toLowerCase());
  const sts = foldDiacritics(asString(company?.search_text_stemmed).toLowerCase());

  for (const concept of concepts) {
    const c = (concept || "").trim();
    if (!c) continue;

    // Try the concept in both its original and stemmed forms so plural/
    // singular differences between the query and the stored data don't
    // cause false negatives.
    const cStem = stemWords(c);
    const variants = cStem && cStem !== c ? [c, cStem] : [c];

    let matched = false;
    for (const variant of variants) {
      if (matched) break;

      const words = variant.split(/\s+/).filter(Boolean);
      const isMultiWord = words.length > 1;

      if (isMultiWord) {
        // Multi-word concept → phrase must appear contiguously in some field
        // or as a word-boundary phrase in the search-text indexes.
        if (fields.some((f) => f.includes(variant))) { matched = true; break; }
        if (stn && stn.includes(` ${variant} `)) { matched = true; break; }
        if (sts && sts.includes(` ${variant} `)) { matched = true; break; }
      } else {
        // Single-word concept → word-boundary match in any field.
        const esc = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const wb = new RegExp(`(?:^|[\\s\\-_])${esc}(?:$|[\\s\\-_])`);
        if (fields.some((f) => wb.test(f))) { matched = true; break; }
        if (stn && stn.includes(` ${variant} `)) { matched = true; break; }
        if (sts && sts.includes(` ${variant} `)) { matched = true; break; }
      }
    }

    if (!matched) return false;
  }

  return true;
}

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
    logo_url_dark: asString(doc.logo_url_dark).trim() || "",
    homepage_image_url: asString(doc.homepage_image_url).trim() || "",
    homepage_approved: Boolean(doc.homepage_approved),
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

    // Flags
    limited_manufacturing: doc.limited_manufacturing || undefined,
    unknown_manufacturing: doc.unknown_manufacturing || undefined,
    unknown_hq: doc.unknown_hq || undefined,
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

  const url = new URL(req.url || "https://localhost/api/search-companies");

  // Support both old style (q param) and new style (raw, norm, compact params)
  const qRawParam = url.searchParams.get("raw") || url.searchParams.get("q") || "";
  const qNormParam = url.searchParams.get("norm") || "";
  const qCompactParam = url.searchParams.get("compact") || "";

  // If we get raw/norm/compact from frontend, use them directly; otherwise parse from q
  let q_raw, q_norm, q_compact, q_stemmed;
  if (qNormParam || qCompactParam) {
    // New style: frontend provided normalized forms
    q_raw = qRawParam;
    q_norm = qNormParam;
    q_compact = qCompactParam;
    q_stemmed = q_norm ? stemWords(q_norm) : "";
  } else {
    // Old style or fallback: parse from raw query
    const parsed = parseQuery(qRawParam);
    q_raw = parsed.q_raw;
    q_norm = parsed.q_norm;
    q_compact = parsed.q_compact;
    q_stemmed = parsed.q_stemmed || (q_norm ? stemWords(q_norm) : "");
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

  // Are we just counting total results (no items returned)?
  const countOnly = url.searchParams.get("countOnly") === "1";

  // Quick mode: return only Pass 1 (word-boundary) results, skip synonym expansion
  // and substring fallback for fastest possible response time
  const quickMode = url.searchParams.get("quick") === "1";

  // Amazon-only filter: when &amazon=1, only return companies with an amazon_url
  const amazonOnly = url.searchParams.get("amazon") === "1";

  // Country-based filters: only return companies with HQ/manufacturing in the specified country
  const hqCountry = (url.searchParams.get("hqCountry") || "").toUpperCase().trim();
  const mfgCountry = (url.searchParams.get("mfgCountry") || "").toUpperCase().trim();
  const country = clean(url.searchParams.get("country") || "");
  const state = clean(url.searchParams.get("state") || url.searchParams.get("region") || "");
  const city = clean(url.searchParams.get("city") || "");

  // Comma-separated concepts (pipe-delimited in the URL). When 2+ present, each
  // concept must match independently — companies missing any concept are filtered.
  // Single-concept queries are left to the existing soft-AND scoring.
  const conceptsParam = url.searchParams.get("concepts") || "";
  const q_concepts = conceptsParam
    ? conceptsParam.split("|").map((s) => foldDiacritics(s.toLowerCase()).trim()).filter(Boolean)
    : [];

  // Retrieval candidate limit. The earlier "fetch just enough for the page"
  // strategy (skip + take + 1) was hiding companies for single-word queries
  // like "golf": Pass 1 word-boundary matches alone could fill the 51-row
  // budget, leaving no room for Pass 2 substring fallback to surface
  // "golfing"/"golfer"/etc. matches. countOnly meanwhile retrieves 500 and
  // returns a higher totalCount, producing the "Page 1 of N" indicator
  // without the corresponding companies actually appearing on the page.
  //
  // Use the same broad 500-row pool for any text-search query so paginated
  // and count requests draw from the same candidate set. Page-internal
  // ordering still uses skip/take after scoring, so users land on
  // deterministic pages — they just have a richer set to land on.
  const hasLocationFilter = !!(country || state || city || hqCountry || mfgCountry);
  const isLocationOnly = hasLocationFilter && !q_norm;
  const needsManuProximity = sort === "manu" && user_location;
  // QuickMode's only job is to paint above-the-fold companies as fast as
  // possible — the frontend already fires it in parallel with the full
  // request and replaces results when the full pipeline finishes. So we
  // don't need 500 candidates to choose from in quick mode: ~50 is plenty
  // for page 1 and cuts Cosmos retrieval time roughly 10×. Quick mode also
  // skips synonym expansion (line 1653) and Passes 2/3/4 + fuzzy fallback,
  // so the small pool composes cleanly into a fast first-paint path.
  const limit = countOnly
    ? 500
    : isLocationOnly
    ? 500
    : quickMode
    ? clamp(skip + take + 1, 1, 51) // above-the-fold preview only
    : q_norm
    ? 500 // text-search: broad retrieval matches countOnly so totals and pages align
    : needsManuProximity
    ? Math.max(clamp(skip + take + 1, 1, 501), 200)
    : clamp(skip + take + 1, 1, 501);

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

      const softDeleteFilter = "(NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, 'refresh_job_') AND NOT STARTSWITH(c.id, '_import_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')";

      // Expand query into phrase variants using synonyms + business abbreviations
      // In quick mode, skip synonym expansion entirely for fastest response
      let ftsWhere = "";
      let ftsOrderBy = "";
      let ftsPhrases = [];
      if (q_norm && !quickMode) {
        const expansion = await expandQueryTermsForFTS(q_norm, q_compact);
        ftsPhrases = expansion.phrases;
      } else if (q_norm) {
        ftsPhrases = [q_norm]; // quick mode: original query only
      }

      // TEMPORARY: Disable FTS queries while the full-text index is still building.
      // Multi-word FTS queries (FullTextContainsAll) hang indefinitely and
      // the Cosmos SDK silently ignores AbortController/abortSignal.
      // Set to true once the index is confirmed ready via Azure Portal
      // (Container → Indexing → Index Transformation Progress = 100%).
      const USE_FTS = false;

      // Helper: run a Cosmos query with a timeout to prevent hanging when FTS index is building.
      // Uses AbortController to properly cancel the underlying HTTP request on timeout,
      // freeing the connection so the CONTAINS fallback can run cleanly.
      const FTS_TIMEOUT_MS = 5000;
      function queryWithTimeout(sql, parameters) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FTS_TIMEOUT_MS);
        return container.items
          .query({ query: sql, parameters }, { enableCrossPartitionQuery: true, abortSignal: controller.signal })
          .fetchAll()
          .then((res) => { clearTimeout(timer); return res; })
          .catch((err) => { clearTimeout(timer); throw err; });
      }

      // Try FTS first; if FTS query fails or times out (e.g. index still building),
      // fall back to legacy CONTAINS-based search so the site stays functional.
      let usedFallback = false;

      if (sort === "manu") {
        // Manufacturing sort: two-stage query — companies WITH mfg locations first
        let searchFilter = "";
        let sqlParams = [{ name: "@take", value: limit }];
        if (ftsPhrases.length > 0) {
          const fts = buildFTSQuery(ftsPhrases);
          searchFilter = `AND (${fts.ftsWhere}) AND ${softDeleteFilter}`;
        } else {
          searchFilter = `AND ${softDeleteFilter}`;
        }

        try {
          if (!USE_FTS && ftsPhrases.length > 0) throw new Error("FTS disabled — index still building");
          const sqlA = `
              SELECT TOP @take ${SELECT_FIELDS}
              FROM c
              WHERE IS_ARRAY(c.manufacturing_locations) AND ARRAY_LENGTH(c.manufacturing_locations) > 0
              ${searchFilter}
              ORDER BY c._ts DESC
            `;

          const partA = ftsPhrases.length > 0
            ? await queryWithTimeout(sqlA, [...sqlParams])
            : await container.items.query({ query: sqlA, parameters: [...sqlParams] }, { enableCrossPartitionQuery: true }).fetchAll();
          items = partA.resources || [];

          const remaining = Math.max(0, limit - items.length);
          if (remaining > 0) {
            const sqlParamsB = [
              { name: "@take2", value: remaining },
              ...sqlParams.filter((p) => p.name !== "@take"),
            ];
            const sqlB = `
                SELECT TOP @take2 ${SELECT_FIELDS}
                FROM c
                WHERE (NOT IS_ARRAY(c.manufacturing_locations) OR ARRAY_LENGTH(c.manufacturing_locations) = 0)
                ${searchFilter}
                ORDER BY c._ts DESC
              `;

            const partB = ftsPhrases.length > 0
              ? await queryWithTimeout(sqlB, sqlParamsB)
              : await container.items.query({ query: sqlB, parameters: sqlParamsB }, { enableCrossPartitionQuery: true }).fetchAll();
            items = items.concat(partB.resources || []);
          }
        } catch (ftsErr) {
          // FTS failed — use hybrid two-pass search: word-boundary first, then substring fill
          context.log("[search-companies] FTS failed (manu), using hybrid word-boundary + substring search:", ftsErr?.message);
          usedFallback = true;

          // Helper to run the two-part manu query (with + without manufacturing locations)
          async function runManuQuery(whereClause, params) {
            const sqlA = `
                SELECT TOP @take ${SELECT_FIELDS}
                FROM c
                WHERE IS_ARRAY(c.manufacturing_locations) AND ARRAY_LENGTH(c.manufacturing_locations) > 0
                ${whereClause}
                ORDER BY c._ts DESC
              `;
            const partA = await container.items
              .query({ query: sqlA, parameters: [...params] }, { enableCrossPartitionQuery: true })
              .fetchAll();
            const result = partA.resources || [];

            const rem = Math.max(0, limit - result.length);
            if (rem > 0) {
              const paramsB = [
                { name: "@take2", value: rem },
                ...params.filter((p) => p.name !== "@take"),
              ];
              const sqlB = `
                  SELECT TOP @take2 ${SELECT_FIELDS}
                  FROM c
                  WHERE (NOT IS_ARRAY(c.manufacturing_locations) OR ARRAY_LENGTH(c.manufacturing_locations) = 0)
                  ${whereClause}
                  ORDER BY c._ts DESC
                `;
              const partB = await container.items
                .query({ query: sqlB, parameters: paramsB }, { enableCrossPartitionQuery: true })
                .fetchAll();
              result.push(...(partB.resources || []));
            }
            return result;
          }

          // ── Pass 1: Word-boundary matching (precise, high-relevance) ──
          const MIN_WORD_BOUNDARY_LEN = 3;
          if (q_norm && q_norm.length >= MIN_WORD_BOUNDARY_LEN) {
            const wbParams = [{ name: "@take", value: limit }];
            const wbFilter = buildWordBoundaryFilter(q_norm, q_stemmed, q_compact, wbParams);
            const wbWhere = `AND (${wbFilter}) AND ${softDeleteFilter}`;
            items = await runManuQuery(wbWhere, wbParams);
          }

          // ── Pass 2: Substring matching (broader, fills remaining slots) ──
          // Skip in quick mode — return word-boundary results only for fastest response
          const manuRemaining = Math.max(0, limit - items.length);
          if (manuRemaining > 0 && !quickMode) {
            const legacyFilter = q_norm ? buildLegacySearchFilter() : "";
            const legacyParams = [{ name: "@take", value: manuRemaining }];
            if (q_norm) {
              legacyParams.push({ name: "@q", value: q_norm });
              legacyParams.push({ name: "@q_compact", value: q_compact || q_norm.replace(/\s+/g, "") });
            }
            const variantFilter = q_norm ? buildVariantContainsClauses(ftsPhrases, q_norm, legacyParams) : "";
            const legacyWhere = q_norm
              ? `AND (${legacyFilter}${variantFilter}) AND ${softDeleteFilter}`
              : `AND ${softDeleteFilter}`;

            const legacyItems = await runManuQuery(legacyWhere, legacyParams);

            // Merge: add Pass 2 results not already in Pass 1, tagged for scoring
            const existingIds = new Set(items.map((i) => i.id));
            for (const item of legacyItems) {
              if (!existingIds.has(item.id)) {
                item._substringOnly = true;
                items.push(item);
                existingIds.add(item.id);
              }
            }
          }
        }
      } else {
        // Standard query — use FTS for text matching
        let queryParams = [{ name: "@take", value: limit }];

        if (ftsPhrases.length > 0) {
          try {
            if (!USE_FTS) throw new Error("FTS disabled — index still building");
            const fts = buildFTSQuery(ftsPhrases);
            ftsWhere = fts.ftsWhere;
            ftsOrderBy = fts.ftsOrderBy;

            // Determine ordering strategy:
            // - "name" sort: alphabetical by company name
            // - Default (recent/stars/etc.): BM25 relevance ranking
            const orderBy =
              sort === "name"
                ? "ORDER BY c.company_name ASC"
                : ftsOrderBy; // BM25 relevance

            const sql = `
                SELECT TOP @take ${SELECT_FIELDS}
                FROM c
                WHERE ${ftsWhere} AND ${softDeleteFilter}
                ${orderBy}
              `;

            const res = await queryWithTimeout(sql, queryParams);
            items = res.resources || [];
          } catch (ftsErr) {
            // FTS failed — use hybrid two-pass search: word-boundary first, then substring fill
            context.log("[search-companies] FTS failed, using hybrid word-boundary + substring search:", ftsErr?.message);
            usedFallback = true;
            const orderBy =
              sort === "name" ? "ORDER BY c.company_name ASC" : "ORDER BY c._ts DESC";

            // ── Pass 1: Word-boundary matching (precise, high-relevance) ──
            const MIN_WORD_BOUNDARY_LEN = 3;
            if (q_norm.length >= MIN_WORD_BOUNDARY_LEN) {
              const wbParams = [{ name: "@take", value: limit }];
              const wbFilter = buildWordBoundaryFilter(q_norm, q_stemmed, q_compact, wbParams);

              const wbSql = `
                  SELECT TOP @take ${SELECT_FIELDS}
                  FROM c
                  WHERE (${wbFilter}) AND ${softDeleteFilter}
                  ${orderBy}
                `;
              const wbRes = await container.items
                .query({ query: wbSql, parameters: wbParams }, { enableCrossPartitionQuery: true })
                .fetchAll();
              items = wbRes.resources || [];
            }

            // ── Pass 2: Substring matching (broader, fills remaining slots) ──
            // Skip in quick mode — return word-boundary results only for fastest response
            const remaining = Math.max(0, limit - items.length);
            if (remaining > 0 && !quickMode) {
              const legacyFilter = buildLegacySearchFilter();
              const legacyParams = [
                { name: "@take", value: remaining },
                { name: "@q", value: q_norm },
                { name: "@q_compact", value: q_compact || q_norm.replace(/\s+/g, "") },
              ];
              const variantFilter = buildVariantContainsClauses(ftsPhrases, q_norm, legacyParams);

              const legacySql = `
                  SELECT TOP @take ${SELECT_FIELDS}
                  FROM c
                  WHERE (${legacyFilter}${variantFilter}) AND ${softDeleteFilter}
                  ${orderBy}
                `;
              const legacyRes = await container.items
                .query({ query: legacySql, parameters: legacyParams }, { enableCrossPartitionQuery: true })
                .fetchAll();

              // Merge: add Pass 2 results not already in Pass 1, tagged for scoring
              const existingIds = new Set(items.map((i) => i.id));
              for (const item of (legacyRes.resources || [])) {
                if (!existingIds.has(item.id)) {
                  item._substringOnly = true;
                  items.push(item);
                  existingIds.add(item.id);
                }
              }
            }
          }
        } else {
          // No search query — return all results
          const orderBy =
            sort === "name" ? "ORDER BY c.company_name ASC" : "ORDER BY c._ts DESC";

          const sql = `
              SELECT TOP @take ${SELECT_FIELDS}
              FROM c
              WHERE ${softDeleteFilter}
              ${orderBy}
            `;

          const res = await container.items
            .query({ query: sql, parameters: queryParams }, { enableCrossPartitionQuery: true })
            .fetchAll();
          items = res.resources || [];
        }
      }

      // ── Pass 3: broadening — per-word word-boundary OR ──
      // For multi-word queries, also retrieve companies that match ANY query
      // word at a word boundary. This is what surfaces pickle companies for
      // "Hobbs Pickles" beneath the brand match. Strict-AND retrieval (Pass
      // 1/2) keeps precision for the primary hit; this pass adds related
      // candidates that the existing relevance scoring + industry affinity
      // index then rank correctly. Skipped in quickMode and for single-word
      // queries (Pass 1 already covers the equivalent set). Skipped for
      // sort=manu where the user explicitly chose a strict view.
      if (!quickMode && q_norm && sort !== "manu") {
        const broadenWords = q_norm.split(/\s+/).filter((w) => w.length >= 3);
        if (broadenWords.length >= 2) {
          const broadenParams = [{ name: "@broadenTake", value: 500 }];
          const broadenClauses = [];
          broadenWords.forEach((word, i) => {
            const wParam = `@bw${i}`;
            broadenParams.push({ name: wParam, value: ` ${word} ` });
            broadenClauses.push(`CONTAINS(c.search_text_norm, ${wParam})`);
            const stemmed = simpleStem(word);
            if (stemmed && stemmed !== word) {
              const sParam = `@bws${i}`;
              broadenParams.push({ name: sParam, value: ` ${stemmed} ` });
              broadenClauses.push(`CONTAINS(c.search_text_stemmed, ${sParam})`);
            }
          });

          const broadenSql = `
            SELECT TOP @broadenTake ${SELECT_FIELDS}
            FROM c
            WHERE (${broadenClauses.join(" OR ")}) AND ${softDeleteFilter}
            ORDER BY c._ts DESC
          `;

          try {
            const broadenRes = await container.items
              .query({ query: broadenSql, parameters: broadenParams }, { enableCrossPartitionQuery: true })
              .fetchAll();
            const broadenItems = broadenRes.resources || [];
            const existingIds = new Set(items.map((i) => i.id));
            for (const item of broadenItems) {
              if (existingIds.has(item.id)) continue;
              item._broadenedMatch = true;
              items.push(item);
              existingIds.add(item.id);
            }
          } catch (broadenErr) {
            // Best-effort. If this fails, the user still gets Pass 1+2 results.
            context.log("[search-companies] broadening pass error:", broadenErr?.message);
          }
        }
      }

      // Fuzzy fallback: fall back to prefix-based search with Damerau-Levenshtein
      // post-filter when primary search produces no real name match for the query.
      // Tries a 4-char prefix first, then a 3-char prefix.
      //
      // The gate used to be `items.length === 0`, but Pass 2's per-word substring
      // AND can return incidental matches that block real typo corrections — e.g.
      // "Cliff Bar" → "Clif Bar" never surfaced because some other company had
      // "cliff" + "bar" as substrings somewhere, leaving items.length > 0. Now we
      // also fire fuzzy when none of the retrieved companies has a name match
      // score >= 60 (word-boundary or better) for the query. The decoy substring
      // hits stay in results but rank below the fuzzy correction.
      const hasStrongNameMatch =
        items.length > 0 &&
        items.some((c) => computeNameMatchScore(c, q_raw, q_norm, q_compact) >= 60);

      if (!hasStrongNameMatch && q_norm && q_norm.length >= 4 && !quickMode) {
        try {
          const prefixLengths = [4, 3]; // try longer prefix first for precision, then shorter
          const existingIds = new Set(items.map((i) => i.id));

          for (const prefixLen of prefixLengths) {
            const prefix = q_norm.substring(0, Math.min(prefixLen, q_norm.length));
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

            for (const candidate of fuzzyCandidates) {
              if (existingIds.has(candidate.id)) continue;
              const names = [candidate.company_name, candidate.display_name, candidate.name, candidate.normalized_domain].filter(Boolean);
              if (names.some((n) => isFuzzyNameMatch(n, q_norm))) {
                candidate._fuzzyMatch = true;
                items.push(candidate);
                existingIds.add(candidate.id);
              }
            }

            // If we found matches with this prefix length, no need to try shorter
            if (items.length > 0) break;
          }
        } catch (fuzzyErr) {
          // Fuzzy fallback is best-effort; don't fail the search
          context.log("search-companies fuzzy fallback error:", fuzzyErr?.message);
        }
      }

      // ── Pass 4: industry-related companies ──
      // When the user searched a specific brand (clear name match,
      // nameScore >= 90) — e.g. "MaraNatha", "Santa Cruz Organic" — also
      // surface companies that share the brand's industry tags so the user
      // sees peers in the same product category. Without this, an obscure
      // brand search returns one card; with it, the user gets the brand
      // first plus a curated set of related companies (e.g. other Organic
      // Nut Butter makers for MaraNatha).
      //
      // Skipped: in quickMode, on pages > 1 (related companies belong with
      // the primary on page 1), and when no primary brand match exists in
      // the result set.
      if (!quickMode && q_norm && skip === 0) {
        let primary = null;
        let primaryScore = 0;
        for (const c of items) {
          const score = computeNameMatchScore(c, q_raw, q_norm, q_compact);
          if (score > primaryScore) {
            primaryScore = score;
            primary = c;
          }
        }
        if (
          primary &&
          primaryScore >= 90 &&
          Array.isArray(primary.industries) &&
          primary.industries.length > 0
        ) {
          // Cap how many of the primary's industries we look up — most brands
          // have 1-3 meaningful tags; capping at 5 keeps the SQL bounded.
          const seedIndustries = primary.industries
            .map((ind) => String(ind || "").toLowerCase().trim())
            .filter(Boolean)
            .slice(0, 5);
          if (seedIndustries.length > 0) {
            const indParams = [{ name: "@indTake", value: 50 }];
            const indClauses = seedIndustries.map((ind, i) => {
              const p = `@ind${i}`;
              indParams.push({ name: p, value: ind });
              // EXISTS over c.industries with LOWER() so the match is
              // case-insensitive against however the data was stored.
              return `EXISTS(SELECT VALUE x FROM x IN c.industries WHERE LOWER(x) = ${p})`;
            });
            const indSql = `
              SELECT TOP @indTake ${SELECT_FIELDS}
              FROM c
              WHERE (${indClauses.join(" OR ")}) AND ${softDeleteFilter}
              ORDER BY c._ts DESC
            `;
            try {
              const indRes = await container.items
                .query({ query: indSql, parameters: indParams }, { enableCrossPartitionQuery: true })
                .fetchAll();
              const indItems = indRes.resources || [];
              const existingIds = new Set(items.map((i) => i.id));
              for (const item of indItems) {
                if (existingIds.has(item.id)) continue;
                item._industryRelated = true;
                items.push(item);
                existingIds.add(item.id);
              }
            } catch (indErr) {
              // Best-effort. If this fails the user still gets the primary match.
              context.log("[search-companies] industry-related pass error:", indErr?.message);
            }
          }
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

      // Deduplicate by normalized_domain BEFORE mapCompanyToPublic. With
      // limit=500 the raw item array can hold dozens of dupes from Pass 1+2+3
      // (especially since broadening and industry-related pull from the same
      // candidate pool). Running the expensive mapCompanyToPublic +
      // normalizeStringArray normalization on every dupe before dropping them
      // was wasted work — the dedup helper only reads normalized_domain /
      // review_count / profile_completeness / _ts, all of which exist on the
      // raw Cosmos document. Saves ~25-35ms on multi-pass searches.
      const dedupedRaw = deduplicateByDomain(normalized);

      const mapped = dedupedRaw
        .map((r) => {
          const pub = mapCompanyToPublic(r);
          if (pub && r._fuzzyMatch) pub._fuzzyMatch = true;
          if (pub && r._substringOnly) pub._substringOnly = true;
          if (pub && r._broadenedMatch) pub._broadenedMatch = true;
          if (pub && r._industryRelated) pub._industryRelated = true;
          return pub;
        })
        .filter((c) => c && c.id);

      let deduped = mapped;

      // Amazon-only filter: keep only companies that have an amazon_url
      if (amazonOnly) {
        deduped = deduped.filter((c) => c.amazon_url && c.amazon_url.trim() !== "");
      }

      if (country || state || city) {
        deduped = deduped.filter((c) => companyMatchesLocationFilters(c, { country, state, city }));
      }

      // HQ country filter: keep only companies with HQ in the specified country
      if (hqCountry) {
        const tokens = countryMatchTokens(hqCountry);
        deduped = deduped.filter((c) => {
          if (locationMatchesCountry(c.headquarters_location, tokens)) return true;
          const hqArr = Array.isArray(c.headquarters) ? c.headquarters : [];
          return hqArr.some((h) => locationMatchesCountry(h.formatted || h, tokens));
        });
      }

      // Manufacturing country filter: keep only companies manufacturing in the specified country
      if (mfgCountry) {
        const tokens = countryMatchTokens(mfgCountry);
        deduped = deduped.filter((c) => {
          const locs = Array.isArray(c.manufacturing_locations) ? c.manufacturing_locations : [];
          if (locs.some((l) => locationMatchesCountry(l, tokens))) return true;
          const geos = Array.isArray(c.manufacturing_geocodes) ? c.manufacturing_geocodes : [];
          return geos.some((g) => locationMatchesCountry(g.formatted, tokens));
        });
      }

      // Comma-separated concept filter: "air compressor, tires" requires BOTH
      // concepts to find a real match in the company's data. A broad platform
      // like Vevor that only matches "tires" is dropped so the user's intent
      // ("air compressor specifically for tires") is honoured.
      if (q_concepts.length >= 2) {
        deduped = deduped.filter((c) => companyMatchesAllConcepts(c, q_concepts));
      }

      // Resolve the affinity industries for this query once (data-driven inverted
      // index — replaces the old hand-curated PRODUCT_INDUSTRY_AFFINITY map).
      // Falls back to [] when the index isn't built yet; scoring then skips the
      // affinity bonus/penalty without breaking search.
      let affinityIndustries = [];
      if (q_norm) {
        try {
          const idx = await loadIndustryAffinityIndex(container);
          affinityIndustries = getAffinityIndustriesFromIndex(idx, q_norm.split(/\s+/));
        } catch (err) {
          context.log?.("[search-companies] loadIndustryAffinityIndex failed:", err?.message);
        }
      }

      // Attach relevance scores so the frontend can prioritise strong matches
      if (q_norm) {
        for (const company of deduped) {
          if (company._fuzzyMatch) {
            // The user typo'd the company name. Score this company AS IF they
            // had typed the corrected name (the closest candidate name) so
            // that a high-confidence typo on a real brand outranks a tangential
            // keyword match in some other catalog. Then deduct a small per-edit
            // penalty so a genuine direct match still wins on a tie.
            //
            // Before this rule, fuzzy scores were capped at 50 (fuzzyScore
            // formula = 50 − dist×15), lower than even modest keyword scores —
            // so e.g. "Cliff Bar" returned Floyd at #1 (had "cliff" and "bar"
            // among its 1877 keywords) while the actual Clif Bar dropped to #2.
            const names = [
              company.company_name,
              company.display_name,
              company.name,
              company.normalized_domain,
            ].filter(Boolean);

            let bestName = "";
            let bestDist = Infinity;
            for (const n of names) {
              const candidateLower = String(n).toLowerCase().trim();
              const d = damerauLevenshtein(candidateLower, q_norm);
              if (d < bestDist) {
                bestDist = d;
                bestName = candidateLower;
              }
            }

            // Re-normalise the corrected name into raw/norm/compact forms and
            // score the company as if the user had typed it correctly.
            const correctedNorm = bestName
              .replace(/[^a-z0-9\s]/g, "")
              .replace(/\s+/g, " ")
              .trim();
            const correctedCompact = correctedNorm.replace(/\s+/g, "");
            const scores = computeRelevanceScore(
              company,
              bestName,
              correctedNorm,
              correctedCompact,
              affinityIndustries
            );

            const fuzzyPenalty = (Number.isFinite(bestDist) ? bestDist : 0) * 5;
            company._nameMatchScore = scores._nameMatchScore;
            company._keywordMatchScore = scores._keywordMatchScore;
            company._relevanceScore = Math.max(0, scores._relevanceScore - fuzzyPenalty);
            company._matchType = "fuzzy";
            delete company._fuzzyMatch;
          } else {
            const scores = computeRelevanceScore(company, q_raw, q_norm, q_compact, affinityIndustries);
            company._nameMatchScore = scores._nameMatchScore;
            company._keywordMatchScore = scores._keywordMatchScore;
            company._relevanceScore = scores._relevanceScore;

            // Tier 2 (substring-only) results get a penalty so word-boundary matches rank higher
            if (company._substringOnly) {
              company._relevanceScore = Math.max(0, company._relevanceScore - 10);
              company._matchType = "substring";
              delete company._substringOnly;
            } else {
              company._matchType = scores._synonymOnly ? "synonym" : "word_boundary";
            }
          }
        }
      }

      // Filter out low-relevance results to prevent irrelevant matches
      // (e.g., "granola" returning GRAMMER or Grado headphones)
      const MIN_RELEVANCE = 5;
      if (q_norm) {
        deduped = deduped.filter((c) => (c._relevanceScore || 0) >= MIN_RELEVANCE);
      }

      if (sortField) {
        deduped.sort((a, b) => compareCompanies(sortField, sortDir, a, b));
      }

      // When there's a search query and no explicit sort field, re-sort by relevance
      // so that strong name/keyword matches (e.g., "Red Bull" for query "red bull")
      // rank above weak per-word matches. This compensates for the CONTAINS fallback's
      // ORDER BY _ts DESC which sorts by recency, not relevance.
      if (q_norm && !sortField && sort !== "name") {
        deduped.sort((a, b) => (b._relevanceScore || 0) - (a._relevanceScore || 0));
      }

      // Stars sort ("Highest rated"): when there's a query, anchor highly-relevant
      // matches at the top (so an exact name match like "The Wellness Company" can't
      // be demoted by a less-relevant company with slightly higher stars), then sort
      // by star rating *within* each relevance tier. Without a query, pure stars sort.
      if (sort === "stars" && !sortField) {
        if (q_norm) {
          deduped.sort((a, b) => {
            const tierA = relevanceTier(a._relevanceScore || 0, a._nameMatchScore || 0);
            const tierB = relevanceTier(b._relevanceScore || 0, b._nameMatchScore || 0);
            if (tierA !== tierB) return tierA - tierB;
            return getQQScoreLike(b) - getQQScoreLike(a);
          });
        } else {
          deduped.sort((a, b) => getQQScoreLike(b) - getQQScoreLike(a));
        }
      }

      // Manufacturing proximity sort: when user coordinates are available, sort by
      // nearest manufacturing distance so the closest factories appear first.
      // Companies without geocoded manufacturing locations sink to the bottom.
      if (sort === "manu" && !sortField && user_location) {
        for (const c of deduped) {
          c._nearestManuDistKm = nearestManuDistKm(c, user_location.lat, user_location.lng);
        }
        deduped.sort((a, b) => {
          const hasManuA = Array.isArray(a.manufacturing_locations) && a.manufacturing_locations.length > 0;
          const hasManuB = Array.isArray(b.manufacturing_locations) && b.manufacturing_locations.length > 0;
          // Companies with manufacturing always above those without
          if (hasManuA && !hasManuB) return -1;
          if (!hasManuA && hasManuB) return 1;
          // Both have manufacturing: sort by nearest distance
          return (a._nearestManuDistKm || Infinity) - (b._nearestManuDistKm || Infinity);
        });
      }

      // countOnly mode: return just the total count, no items (used for async pagination info)
      if (countOnly) {
        const totalCount = deduped.length;
        const totalPages = Math.ceil(totalCount / take);
        return json(
          { ok: true, success: true, totalCount, totalPages, meta: { q: q_raw, sort, take } },
          200,
          req
        );
      }

      const paged = deduped.slice(skip, skip + take);
      const hasMore = deduped.length > skip + take;

      return json(
        {
          ok: true,
          success: true,
          ...(cosmosTarget ? cosmosTarget : {}),
          items: paged,
          count: paged.length,
          hasMore,
          meta: { q: q_raw, sort, skip, take, user_location, _searchMode: quickMode ? "quick" : usedFallback ? "contains" : "fts" },
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
  buildWordBoundaryFilter,
  companyMatchesAllConcepts,
  isSynonymOnlyMatch,
};
