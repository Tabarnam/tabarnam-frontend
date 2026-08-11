let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const { CosmosClient } = require("@azure/cosmos");
const { getContainerPartitionKeyPath } = require("../_cosmosPartitionKey");
const { logInboundRequest } = require("../_diagnostics");
const { parseQuery, foldDiacritics, normalizeQuery } = require("../_queryNormalizer");
const { expandQueryTermsForFTS, expandProductSynonyms, splitCompoundQuery } = require("../_searchSynonyms");
const { isFuzzyNameMatch, damerauLevenshtein } = require("../_fuzzyMatch");
const { simpleStem, stemWords } = require("../_stemmer");
const { toNormalizedDomain } = require("../import-start/_importStartCompanyUtils");
const {
  loadIndustryAffinityIndex,
  getAffinityIndustriesFromIndex,
} = require("../_industryAffinityIndex");
const {
  getDictionary: getTypoCorrectionDictionary,
  correctQuery: correctTypoQuery,
  getLastLoadError: getTypoLoadError,
  getCacheInfo: getTypoCacheInfo,
  startBackgroundLoad: startTypoBackgroundLoad,
} = require("../_typoCorrection");
const { TTLCache, buildCacheKey } = require("../_responseCache");

// In-worker hot-query cache. Two anonymous users searching "candle" within
// the TTL window share the same Cosmos work. Cross-user by design (cache
// key is query+params, never user identity). Per-worker, so 1-3 workers
// during scaled-up bursts each warm independently — acceptable for a
// small LRU. Cache is bypassed when ?nocache=1 is set.
//
// Phase 4.27 — DEFAULT-DISABLED via RESPONSE_CACHE_ENABLED env var.
//
// Empirical (2026-05-26): under sustained admin-only bulk-import load,
// the 200-entry cache accumulated on a single always-ready instance and
// pushed working-set memory toward the 2 GB Flex ceiling. Minute-level
// memory peaks at 1.5+ GB triggered V8 GC pauses that froze the event
// loop, causing short-lived HTTP requests (search-companies, health,
// version) to queue and time out while the worker was busy with a
// long-running xAI streaming call.
//
// Cross-user response caching pays off when MANY anonymous users hit
// the same hot query within the TTL window — i.e. real public traffic.
// Pre-launch traffic is admin-only with low query-repeat probability,
// so the cache was paying memory cost for ~zero benefit.
//
// To re-enable: set RESPONSE_CACHE_ENABLED=on in the Function App
// configuration (no redeploy). Right-size maxEntries / ttlMs against
// real production metrics before flipping on. The TTLCache + cache
// integration tests still exercise the wiring when the env is set.
const _responseCache = new TTLCache({ maxEntries: 200, ttlMs: 5 * 60 * 1000 });
function _getResponseCache() { return _responseCache; }
function _responseCacheEnabled() {
  const raw = String(process.env.RESPONSE_CACHE_ENABLED || "").toLowerCase().trim();
  return raw === "on" || raw === "true" || raw === "1";
}

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

// Module-scope cache. Every new CosmosClient eats an HTTPS connect + TLS
// handshake + Cosmos endpoint-discovery roundtrip on first use — easily
// 80-200ms per cold call. Functions reuses the worker process across
// requests, so caching the client at module scope amortizes that cost
// over the worker's lifetime. Tests bypass this path entirely by
// injecting `companiesContainer` through `deps`.
let _cachedCosmosClient = null;
let _cachedCompaniesContainer = null;
let _cachedCompaniesContainerKey = null;

function getCompaniesContainer() {
  try {
    const endpoint = env("COSMOS_DB_ENDPOINT", "");
    const key = env("COSMOS_DB_KEY", "");
    const databaseId = env("COSMOS_DB_DATABASE", "tabarnam-db");
    const containerId = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");

    if (!endpoint || !key) return null;

    // Cache key includes every input that would invalidate the connection.
    // Env vars are stable per worker on Functions, but key rotation /
    // container migration shouldn't require a worker restart to take effect.
    const cacheKey = `${endpoint}|${databaseId}|${containerId}|${key.length}:${key.slice(0, 4)}`;
    if (_cachedCompaniesContainer && _cachedCompaniesContainerKey === cacheKey) {
      return _cachedCompaniesContainer;
    }

    // requestTimeout: a hung/slow query (e.g. the FTS path) aborts in 30s
    // instead of pinning the single warm worker for the 10-min function timeout.
    _cachedCosmosClient = new CosmosClient({ endpoint, key, connectionPolicy: { requestTimeout: 30000 } });
    _cachedCompaniesContainer = _cachedCosmosClient.database(databaseId).container(containerId);
    _cachedCompaniesContainerKey = cacheKey;
    return _cachedCompaniesContainer;
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

    // Per-token overlap (multi-word query only). The checks above all
    // reward the WHOLE query appearing somewhere in the name. This adds
    // a separate signal for when MOST of the query tokens appear as
    // individual words in the name — which is exactly what happens when
    // the user types a name from memory with one word wrong
    // ("grand teton ORGANIC grains" → "Grand Teton ANCIENT Grains") or
    // mixes up brand qualifiers. Without this path, partial-name matches
    // get nameScore=0 and are outranked by keyword-only matches that
    // share no name signal at all.
    //
    // Scoring is deliberately conservative on short queries:
    //   ALL tokens match, query has ≥3 tokens → 100 (tier -1)
    //   ALL tokens match, query has 2 tokens  → 90  (tier 0)
    //   ≥75% match, ≥2 matched               → 90  (tier 0)
    //   ≥50% match, ≥2 matched               → 70  (tier 1)
    //   else                                  → no boost
    const queryTokens = q_norm
      ? q_norm.toLowerCase().trim().split(/\s+/).filter((t) => t.length >= 2)
      : [];
    if (queryTokens.length >= 2) {
      const nameTokens = new Set(
        nameLower.split(/\s+/).filter((t) => t.length >= 2)
      );
      let matched = 0;
      for (const qt of queryTokens) {
        if (nameTokens.has(qt)) matched++;
      }
      if (matched >= 2) {
        const fraction = matched / queryTokens.length;
        let overlapScore = 0;
        if (matched === queryTokens.length) {
          overlapScore = queryTokens.length >= 3 ? 100 : 90;
        } else if (fraction >= 0.75) {
          overlapScore = 90;
        } else if (fraction >= 0.5) {
          overlapScore = 70;
        }
        if (overlapScore > 0) best = Math.max(best, overlapScore);
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
      // against each keyword. "watson farms beef" → "beef" matches keyword "Beef Brisket".
      // Fires whenever the ORIGINAL query is multi-word (has a space) and at
      // least one word survives the length filter — NOT just when 2+ survive.
      // Without this, a query like "pre-x" (normalizes to "pre x", then the
      // 1-char "x" is dropped, leaving only "pre") matched NOTHING: the whole-
      // phrase queryTerms "pre x"/"prex" don't appear in any keyword, and the
      // per-word fallback used to require 2+ surviving words. Result: Nutricost
      // (industries "pre-x" / "pre workout") scored 0 and vanished, even though
      // plain "pre" ranked it #1. Same class of bug for "vitamin c", "omega-3".
      const queryIsMultiWord = (q_norm || "").includes(" ");
      if (!matched && queryWords.length >= 1 && queryIsMultiWord) {
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
      // Partial coverage: only 1 (or 0) of N query words matched a keyword.
      // Normally a weak signal → heavy ×0.6 penalty. EXCEPTION: when the one
      // covered word is the query's HEAD NOUN (the last word — "emblem" in
      // "custom emblem", "honey" in "organic honey"), the company makes the
      // thing itself and only misses a qualifier. That's a legitimate result the
      // user still wants — ranked below full matches, but NOT filtered out.
      // `coveredWords` only counts word-boundary hits, so a head-noun match is
      // genuine; value it as such (a single-word exact match is undervalued by
      // the whole-phrase `best` above) and apply just a gentle penalty so it
      // clears the MIN_RELEVANCE floor. A qualifier-only match keeps the ×0.6.
      const headNoun = queryWords[queryWords.length - 1];
      if (coveredWords.has(headNoun)) {
        return Math.round(Math.max(best, 60) * 0.85);
      }
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
  // not a synonym-only match. Fires for any multi-word query (original has a
  // space) with >=1 surviving word — NOT just 2+. Without this, "pre-x"
  // (normalizes to "pre x"; the 1-char "x" is dropped, leaving "pre") skipped
  // this block, so Nutricost (search_text_norm contains " pre ") was wrongly
  // flagged synonym-only and hit with a 0.4x penalty (R 30 → 12), sinking it
  // to rank 38. With the block firing, "pre" is found → not synonym-only.
  const queryWords = q_norm.split(/\s+/).filter((w) => w.length >= 2);
  if (queryWords.length >= 1 && q_norm.includes(" ")) {
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
function computeRelevanceScore(company, q_raw, q_norm, q_compact, affinityIndustries = [], synonymPhrases = []) {
  let nameScore = computeNameMatchScore(company, q_raw, q_norm, q_compact);
  let keywordScore = computeKeywordMatchScore(company, q_norm, q_compact);

  // Singular/plural equivalence. Candidate RETRIEVAL already ORs each query
  // word with its stem (so "bras" fetches the same token candidates as
  // "bra"), but SCORING used only the literal query. The result: a company
  // retrieved via the stem could score below MIN_RELEVANCE for the inflected
  // form and get filtered out — so "bras" returned fewer results than "bra"
  // even though it should match at least as many. Score the stemmed query
  // too and take the max of each component, so an inflected query clears the
  // cutoff (and ranks) identically to its base form. This only ever RAISES a
  // score, so it can never drop a match that the literal query already had.
  const stemmedNorm = stemWords(q_norm);
  if (stemmedNorm && stemmedNorm !== q_norm) {
    const stemmedCompact = stemmedNorm.replace(/\s+/g, "");
    nameScore = Math.max(
      nameScore,
      computeNameMatchScore(company, stemmedNorm, stemmedNorm, stemmedCompact)
    );
    keywordScore = Math.max(
      keywordScore,
      computeKeywordMatchScore(company, stemmedNorm, stemmedCompact)
    );
  }

  // Synonym-expanded equivalence. Candidate RETRIEVAL ORs each query word with
  // its product synonyms (fridge→refrigerator, wine→winery, lipgloss→"lip
  // gloss") so synonym docs are FETCHED — but scoring used only the literal
  // query. A brand tagged only the synonym ("refrigerator", never "fridge")
  // therefore scored 0 on both name and keyword, fell below MIN_RELEVANCE, and
  // was filtered right back out: "fridge" retrieved KitchenAid then dropped it.
  // Score each synonym phrase too and take the max per component so the synonym
  // doc clears the cutoff and ranks. Only ever RAISES a score (never drops a
  // literal match). The synonym-only ×0.4 penalty below still keeps literal
  // "fridge" matches ranked above "refrigerator"-only brands.
  for (const phrase of synonymPhrases) {
    if (!phrase || phrase === q_norm) continue;
    const pc = String(phrase).replace(/\s+/g, "");
    nameScore = Math.max(nameScore, computeNameMatchScore(company, phrase, phrase, pc));
    keywordScore = Math.max(keywordScore, computeKeywordMatchScore(company, phrase, pc));
  }

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
  // Normalize each industry the SAME way the query was normalized (hyphens/
  // punctuation → space, diacritics folded, collapsed) so a stored industry
  // like "pre-x" compares equal to the normalized query "pre x". Without
  // this, an exact industry match ("pre-x" industry vs a "pre-x" search that
  // normalizes to "pre x") missed the bonus on a raw hyphen-vs-space mismatch,
  // leaving the company tied with every generic "pre" match instead of
  // standing out.
  const industries = normalizeStringArray(company.industries)
    .map((s) => normalizeQuery(asString(s)))
    .filter(Boolean);
  const qLower = (q_norm || "").trim();
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
  //   -15 penalty for companies NOT in any of them — BUT only when the
  //        company also has no strong name match. A strong name match
  //        (nameScore >= 60: exact / startsWith / q.startsWith / word
  //        boundary) means the user typed THIS brand by name, so the
  //        brand's own category trumps the query's affinity bucket.
  //        Without this exception, searches like "alo yoga" demote the
  //        ALO brand below yoga-tagged competitors because ALO's
  //        industries are Apparel/Activewear/leggings (not yoga).
  //        Brand searches lose to category searches every time.
  // This creates a 40-point gap between aligned and non-aligned non-name-
  // match companies, while keeping name-matched brands honest.
  const hasAffinity = affinityIndustries.length > 0 &&
    industries.some((ind) => affinityIndustries.some((aff) => ind.includes(aff.toLowerCase())));
  const affinityBonus = hasAffinity
    ? 25
    : (affinityIndustries.length > 0 && nameScore < 60 ? -15 : 0);

  let relevanceScore = nameScore > 0
    ? Math.round(nameScore * 0.7 + keywordScore * 0.3) + nameBonus + industryBonus + affinityBonus
    : Math.round(keywordScore * 0.6) + industryBonus + affinityBonus;

  // Synonym-only penalty: companies that matched only via synonym expansion
  // (e.g., a coffee company with "sweatshirt" merch matching "hoodie" query)
  // get demoted so direct-match companies always rank above them.
  //
  // EXCEPTION: when the company has a strong name match (nameScore >= 60 —
  // exact / startsWith / q.startsWith / word-boundary), the user typed THIS
  // brand by name. That's a more definitive signal than "your text doesn't
  // contain the literal query phrase". The previous synonym-only logic
  // relied heavily on search_text_norm being populated with space-padded
  // words; in production some docs (e.g. brands that moved to the Phase
  // 4.36 search_tokens system) have inconsistent search_text_norm, causing
  // strong-name-match brands like ALO to be misclassified as synonym-only
  // and demoted with a 60% reduction (R goes from 69 → 28 for "alo yoga"
  // → ALO buried at rank #37 instead of #1). Same principle as the
  // affinity-bonus exemption above: the brand the user typed wins.
  const synonymOnly = isSynonymOnlyMatch(company, q_norm, q_compact);
  if (synonymOnly && nameScore < 60) {
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
// "Direct" = above the "Loosely related to …" divider the frontend draws.
// Mirrored as LOOSE_TIER_CUTOFF in ResultsPage.jsx. Used for the pagination
// directCount AND as the auto-correct trigger's definition of "found nothing
// good", so the banner appears exactly when the whole page would sit below
// that divider.
const LOOSE_TIER_CUTOFF = 2;
// A typo-correction retry doubles the Cosmos work for that request. Skip it if
// the first pass already ate this much of the budget, so a slow query can never
// be pushed into REQUEST_HARD_TIMEOUT_MS (15s) and 503 by the retry.
const SECOND_PASS_BUDGET_MS = 6000;
function directMatchCount(rows) {
  if (!Array.isArray(rows)) return 0;
  return rows.filter(
    (c) => relevanceTier(c._relevanceScore || 0, c._nameMatchScore || 0) < LOOSE_TIER_CUTOFF
  ).length;
}

function relevanceTier(score, nameScore = 0) {
  if (nameScore >= 100) return -1; // exact name match — always first
  if (score >= 90) return 0;       // very-relevant non-exact match
  if (score >= 60) return 1;       // strong name or keyword match
  if (score >= 30) return 2;       // moderate match
  return 3;                        // weak match
}

// Excludes soft-deleted docs and the non-company control rows (refresh jobs,
// import control docs) that share the container. Module scope because it is
// used both inside the retrieval pass and by the domain-alternatives block
// that sits outside it.
const softDeleteFilter =
  "(NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, 'refresh_job_') AND NOT STARTSWITH(c.id, '_import_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')";

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

  // Phase 4.38 — sub-brand relationship. Included so search responses
  // can render "part of {parent}" context, and so admin diagnostics
  // can confirm the parent link without opening the record editor.
  "c.parent_company_id",

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
  "c.visible_review_count",

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

// Slim projection for the ~500-candidate retrieval pool. Contains ONLY the raw
// fields read by scoring / sort / filter / dedup / Pass-4 / domain-alt / meta —
// so ranking is byte-identical to a full projection. The display-only "fat"
// fields (logos, reviews arrays, notes, hq lat/lng, admin/star metadata,
// search_text_norm, etc.) are dropped here and hydrated for ONLY the paged ≤25
// rows via hydratePageDisplayFields(). This is the main lever: cosmos time is
// ~90-95% of a search and tracks doc payload size, so shrinking each of the
// (up to 5) TOP-500 passes to the slim set is where the win comes from.
//
// SLIM must stay a strict superset of every field the scoring/sort/filter/dedup
// code reads. A static test (perf-snapshot.test.js) asserts the required set is
// present so a future field addition can't silently drop out of ranking.
// NOTE: search_text_norm is intentionally excluded — its only JS readers run on
// the MAPPED object (which never carried it → already inert), and its Cosmos
// WHERE-clause use (CONTAINS) does not require it in SELECT. If scoring is ever
// moved to run pre-map, re-add it here.
const SLIM_SELECT_FIELDS = [
  // Identity / names — name scoring, dedup keys, response ids, domain match
  "c.id", "c.company_id", "c.company_name", "c.display_name", "c.name",
  // Category + keywords — keyword scoring, industry bonus, concept filter, Pass-4 seed
  "c.industries", "c.product_keywords", "c.keywords",
  // Links — amazon filter; website_url et al. feed the empty-name deriveNameFromHost fallback
  "c.website_url", "c.url", "c.canonical_url", "c.website", "c.amazon_url",
  "c.normalized_domain",
  // Timestamps — created/updated sorts; _ts backfill + dedup tiebreak
  "c.created_at", "c.updated_at", "c._ts",
  // Locations — location/country filters, manu-sort hasManu + nearest-distance
  "c.manufacturing_locations", "c.manufacturing_geocodes",
  "c.headquarters", "c.headquarters_locations", "c.headquarters_location",
  // Content — tagline feeds the concept filter
  "c.tagline",
  // Ratings/stars — quality (QQ) sort inputs
  "c.rating", "c.avg_rating", "c.star_rating", "c.star_score", "c.confidence_score",
  // Reviews — reviews sort + dedup best-record; review_count_approved feeds mapped reviews_count
  "c.review_count", "c.review_count_approved",
  // Dedup best-record tiebreak
  "c.profile_completeness",
].join(", ");

// Hydrate the display-only (LIST B) fields onto ONLY the final page of results.
// The candidate pool is retrieved with SLIM_SELECT_FIELDS (ranking fields only);
// this re-reads the full document for each of the ≤`take` shown rows (cheap
// single-partition point reads by id + partition key) and re-maps it, then
// copies the pipeline's computed `_`-prefixed fields (scores, match type, flags)
// back on. Ranking is untouched — only the display payload is enriched. On any
// read miss/error it falls back to the slim-mapped row (ranking intact, some
// display fields sparse) so a hydration hiccup can never drop a result.
async function hydratePageDisplayFields(pagedItems, container, context) {
  if (!container || !Array.isArray(pagedItems) || pagedItems.length === 0) {
    return pagedItems;
  }
  try {
    const fulls = await Promise.all(
      pagedItems.map((p) => {
        if (!p || !p.id || !p.normalized_domain) return Promise.resolve(null);
        return container
          .item(p.id, p.normalized_domain)
          .read()
          .then((r) => r?.resource || null)
          .catch(() => null);
      })
    );
    return pagedItems.map((slimPub, i) => {
      const full = fulls[i];
      if (!full) return slimPub; // graceful fallback — ranking intact
      const fullPub = mapCompanyToPublic(full);
      if (!fullPub) return slimPub;
      // Preserve everything the scoring/sort pipeline computed on the slim row.
      for (const k of Object.keys(slimPub)) {
        if (k.charCodeAt(0) === 95 /* "_" */) fullPub[k] = slimPub[k];
      }
      return fullPub;
    });
  } catch (e) {
    context?.log?.("[search-companies] page hydration failed, serving slim rows:", e?.message);
    return pagedItems;
  }
}

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

  // Pick the best record among true duplicates: most reviews → highest
  // profile_completeness → newest _ts.
  const bestFirst = (a, b) => {
    const ra = Number(a?.review_count || 0);
    const rb = Number(b?.review_count || 0);
    if (rb !== ra) return rb - ra;

    const pa = Number(a?.profile_completeness || 0);
    const pb = Number(b?.profile_completeness || 0);
    if (pb !== pa) return pb - pa;

    const ta = Number(a?._ts || 0);
    const tb = Number(b?._ts || 0);
    return tb - ta;
  };

  const result = [...noDomain];
  for (const [, group] of byDomain) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    // Collapse only records with the SAME normalized company name (true
    // re-imports / duplicates). DISTINCT names sharing a domain are kept —
    // these are legitimate sub-brands (HP + "HP Calculators" on hp.com,
    // Canon + "Canon Calculator" on usa.canon.com). Before this, the whole
    // domain group collapsed to one record and the sub-brand vanished from
    // results entirely, before it was even scored.
    const byName = new Map();
    for (const c of group) {
      const nameKey =
        normalizeQuery(
          asString(c?.company_name || c?.display_name || c?.name || "")
        ) || `__id_${c?.id || c?.company_id || Math.random()}`;
      if (!byName.has(nameKey)) byName.set(nameKey, []);
      byName.get(nameKey).push(c);
    }
    for (const [, sameName] of byName) {
      if (sameName.length === 1) {
        result.push(sameName[0]);
      } else {
        sameName.sort(bestFirst);
        result.push(sameName[0]);
      }
    }
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
    // Pinned count of reviews visible to users (maintained on every review
    // change; see _pinVisibleReviewCount). Present once a company has been
    // written/backfilled — the card prefers it; otherwise it falls back to the
    // batch /review-counts endpoint.
    visible_review_count:
      typeof doc.visible_review_count === "number" ? doc.visible_review_count : undefined,
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
    // _ts (raw Cosmos system timestamp) intentionally omitted from the public
    // response — created_at/updated_at above already cover any UI need.

    // Rating schema fields consumed by the public results page.
    // Dropped from this response (used only by the admin dashboard, which
    // hits /api/admin-company directly, or by the now-unused CompanyRow.jsx
    // table view): rating_icon_type, review_count_approved,
    // editorial_review_count, star_overrides, admin_manual_extra, star_notes,
    // star_explanation. Shipping null/empty copies of those on every result
    // bloats the JSON for no consumer.
    star_rating: doc.star_rating,
    star_score: doc.star_score,
    confidence_score: doc.confidence_score,
    rating: doc.rating,

    // Affiliate links used by ExpandableCompanyRow — the component reads
    // the array forms (`affiliate_links` / `affiliate_link_urls`) only.
    // The 15 flat legacy variants (`affiliate_link_N`, `affiliate_link_N_url`,
    // `affiliateN_url` for N=1..5) have zero consumers on the public path
    // (verified by grep across src/). Dropped.
    affiliate_links: doc.affiliate_links,
    affiliate_link_urls: doc.affiliate_link_urls,

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

  // ── Compound-spelling normalization ────────────────────────────────────────
  // "lipgloss" is not a different product from "lip gloss" — it is the same
  // words typed solid. RETRIEVAL already coped (the split is added as an FTS
  // phrase), but SCORING did not: with q_norm left as "lipgloss", no company
  // literally contains it, so isSynonymOnlyMatch flagged every hit as
  // synonym-only and applied the x0.4 penalty, sinking them below the direct
  // tier. Measured on prod: "lip gloss" 53 direct / "lipgloss" 6 direct, from
  // an IDENTICAL retrieval pool of 85. Same shape for icemaker (16 vs 1).
  //
  // So canonicalize q_norm to the spaced form. Deliberately NOT routed through
  // the "did you mean" suggestion used for typos below: this changes no words,
  // only whitespace, and comes from a curated map rather than corpus edit
  // distance, so it carries none of the padron→patron hijack risk that rule
  // exists to prevent. q_compact is left alone — it is byte-identical for both
  // spellings ("lipgloss"), so a brand literally NAMED "LipGloss" still matches
  // by name via the q_compact paths.
  let _splitDiag = null;
  const compoundSplit = splitCompoundQuery(q_norm);
  if (compoundSplit) {
    _splitDiag = { from: q_norm, to: compoundSplit };
    q_norm = compoundSplit;
    q_stemmed = stemWords(q_norm);
  }

  // ── Domain search ──────────────────────────────────────────────────────────
  // When the user pastes a URL, the frontend sends the exact normalized_domain
  // (?domain=cove.com). A domain search is the narrowest possible intent, so
  // when it's present we look the company up by that domain ONLY (see the
  // short-circuit in the retrieval block below). Defensively derive from the
  // raw query for direct API callers that pass a full URL as ?q=.
  let domainParam = (url.searchParams.get("domain") || "").trim().toLowerCase();
  if (!domainParam && q_raw) {
    const derived = toNormalizedDomain(q_raw);
    if (derived && derived !== "unknown") domainParam = derived;
  }
  // Only a real host (has a dot, not the "unknown" sentinel) is a domain search.
  if (!domainParam.includes(".") || domainParam === "unknown") domainParam = "";

  const sort = (url.searchParams.get("sort") || "recent").toLowerCase();
  const sortField = (url.searchParams.get("sortField") || "").toLowerCase();
  const sortDir = (url.searchParams.get("sortDir") || "asc").toLowerCase() === "desc" ? "desc" : "asc";
  const lat = toFiniteNumber(url.searchParams.get("lat"));
  const lng = toFiniteNumber(url.searchParams.get("lng"));
  const user_location = lat != null && lng != null ? { lat, lng } : null;

  const takeParam = toFiniteNumber(url.searchParams.get("take"));
  // Results-per-page ceiling is 100 (the user-facing "Per page" max). Anything
  // larger — a hand-edited URL or direct API caller — is capped here.
  const take = clamp(Math.floor(takeParam ?? 50), 1, 100);

  const skipParam = toFiniteNumber(url.searchParams.get("skip"));
  const skip = Math.max(0, Math.floor(skipParam ?? 0));

  // Are we just counting total results (no items returned)?
  const countOnly = url.searchParams.get("countOnly") === "1";
  // Map view opt-in: include the FULL matched id list (up to the retrieval
  // pool cap) so the results map can plot every match — page rows render as
  // full pins, the rest join against the /api/map-pins index client-side.
  // Ids only (~35B each); key-affecting for the response cache like nocorrect.
  const includeMatchIds = url.searchParams.get("matchIds") === "1";
  // Escape hatch behind the "Search instead for …" link: forces the literal
  // query so a user who really meant the odd spelling can get it back. Not in
  // the response cache's STRIPPED_PARAMS, so it is key-affecting (asserted in
  // _responseCache.test.js) and can never serve a corrected body.
  const allowCorrection = url.searchParams.get("nocorrect") !== "1";
  const _handlerStartedAt = Date.now();

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

  // Pre-Cosmos typo correction. When the user types a common product
  // word with a typo ("paintt", "puzle", "jerkey-but-as-an-actual-typo"),
  // rewrite the query to the corrected form BEFORE issuing the Cosmos
  // query. Source dictionary = the affinity-index `terms` map (every
  // token appearing in ≥3 companies). The existing fuzzy fallback only
  // matches single-word company NAMES via prefix STARTSWITH, so it can't
  // surface "Miller Paint Company" for "paintt" — this fixes that.
  //
  // Best-effort: if the dictionary isn't loaded yet (cold worker) or the
  // load fails, we just search with the original query — never blocks.
  // We ALWAYS search the exact query the user typed; a spelling candidate is
  // only surfaced as a non-destructive "Did you mean …?" suggestion (in
  // meta.did_you_mean) when the original query returns nothing.
  // Kick the dictionary load in the background on every request — it's a
  // no-op once the cache is warm. First request after a worker recycle
  // sees no correction (dictionary still building), but every subsequent
  // request gets it. Cheaper than blocking the user's first query.
  if (container) startTypoBackgroundLoad(container);

  let typo_suggestion = null; // a "Did you mean …?" candidate — NEVER auto-applied
  let _typoDiag = { attempted: false };
  // Reused by the brand-name recovery gate (below) as a corpus-frequency signal:
  // its `terms` map holds only tokens appearing in ≥ MIN_COMPANIES_PER_TOKEN
  // companies, so a token ABSENT from it is a distinctive (coined) brand word.
  let typoDictionary = null;
  if (q_norm && container) {
    _typoDiag.attempted = true;
    try {
      // IMPORTANT: don't await getDictionary here — that would re-introduce
      // the cold-load latency on first requests. Use whatever's cached
      // RIGHT NOW (could be null if the background load is still running).
      const cacheInfo = getTypoCacheInfo();
      _typoDiag.dictionaryLoaded = !!cacheInfo;
      _typoDiag.termCount = cacheInfo?.termCount || 0;
      if (cacheInfo?.source) _typoDiag.source = cacheInfo.source;
      // Size + point-read cost of the persisted dictionary doc. Reported here
      // because the refresh that loads it runs detached from any invocation,
      // so its logs never reach App Insights. These drive the daily RU bill:
      // point-read RU scales with doc size, and every worker re-reads it each
      // CACHE_TTL_MS.
      if (cacheInfo?.nameTokenCount != null) _typoDiag.nameTokenCount = cacheInfo.nameTokenCount;
      if (cacheInfo?.packedBytes != null) _typoDiag.packedBytes = cacheInfo.packedBytes;
      if (cacheInfo?.docRequestCharge != null) _typoDiag.docRequestCharge = cacheInfo.docRequestCharge;
      const loadErr = getTypoLoadError();
      if (loadErr) _typoDiag.loadError = loadErr;

      if (cacheInfo) {
        // Cache is populated — actually call getDictionary which returns
        // the cached object synchronously without re-fetching.
        const dictionary = await getTypoCorrectionDictionary(container);
        typoDictionary = dictionary;
        const rewritten = correctTypoQuery(q_norm, dictionary);
        _typoDiag.rewritten = rewritten;
        if (rewritten && rewritten !== q_norm) {
          // We NEVER silently rewrite the user's query — that would change what
          // they searched for without their knowledge (and can hijack a real,
          // recently-added brand like "padron" → "patron" when the typo
          // dictionary's protection set is stale). Instead we keep the original
          // query as-is and merely REMEMBER a candidate. It's surfaced to the
          // user as a "Did you mean …?" suggestion below — and only when the
          // original query comes up empty, so it stays out of the way for good
          // queries.
          typo_suggestion = rewritten;
        }
      }
    } catch (typoErr) {
      _typoDiag.error = typoErr?.message || String(typoErr);
    }
  }

  const cosmosTarget = container ? await getCompaniesCosmosTargetDiagnostics(container).catch(() => null) : null;
  if (cosmosTarget) {
    try {
      context.log("[search-companies] cosmos_target", cosmosTarget);
    } catch {}
  }

  if (container) {
    try {
      // ── One retrieval + scoring pass ─────────────────────────────────────
      // Extracted so the entire pipeline can be re-run with a corrected query
      // when the typed one turns out to be junk (see the auto-correct block
      // below). Declared here rather than hoisted to module scope so it closes
      // over container / filters / sort / paging / typoDictionary — no param
      // threading. The parameters deliberately SHADOW the outer q_* bindings,
      // so the body below needs no identifier changes.
      async function runSearchPass(q_raw, q_norm, q_compact, q_stemmed) {
      let items = [];
      // Perf instrument: split retrieval (Cosmos round-trips) from compute
      // (map/dedup/score/sort). Surfaced as meta._timing to confirm where the
      // per-search time goes and to measure optimizations before/after.
      const _tStart = Date.now();

      // ── Domain-only exact retrieval (pasted-URL search) ──
      // When `domainParam` is set, the search is a narrow "find the company at
      // THIS domain" lookup. Query by exact normalized_domain (the partition
      // key → single-partition point lookup, cheapest possible) and SKIP the
      // whole brand-token pipeline below (token/broadening/fuzzy/Pass 4). TOP 5
      // covers a legitimate same-domain family (HP + HP Calculators). If the
      // domain isn't in the DB, items stays empty → the frontend shows the
      // opt-in "did you mean / explore" state; alternatives ride in meta only.
      if (domainParam) {
        const domRes = await container.items
          .query(
            {
              query: `SELECT TOP 5 ${SELECT_FIELDS} FROM c WHERE c.normalized_domain = @dom AND ${softDeleteFilter}`,
              parameters: [{ name: "@dom", value: domainParam }],
            },
            { enableCrossPartitionQuery: true }
          )
          .fetchAll();
        items = (domRes.resources || []).map((r) => ({ ...r, _domainExactMatch: true }));
      }

      // Expand query into phrase variants using synonyms + business abbreviations.
      // In quick mode, skip synonym expansion entirely for fastest response.
      // These phrases drive the token-match WHERE built below.
      let ftsPhrases = [];
      if (q_norm && !quickMode) {
        const expansion = await expandQueryTermsForFTS(q_norm, q_compact);
        ftsPhrases = expansion.phrases;
      } else if (q_norm) {
        ftsPhrases = [q_norm]; // quick mode: original query only
      }

      // ── Candidate retrieval: ONE indexed query over search_tokens ──
      // Replaces the former FTS path + manu two-stage + word-boundary/substring
      // passes. ARRAY_CONTAINS over the (default-indexed) search_tokens array is a
      // true index lookup: fast, bounded, and — unlike FullTextContainsAll — it
      // cannot hang and wedge the worker. Matching model:
      //   - per query word: word OR its stem (so plurals/inflections hit)
      //   - words WITHIN a synonym phrase are AND'd (all must be present)
      //   - synonym phrases are OR'd together
      //   - stopwords are dropped from the QUERY so strict-AND never requires a
      //     filler word ("the", "of") to be present; stored tokens keep them.
      // sort=manu / stars / distance are all handled by the post-fetch reranker
      // below, so retrieval is identical for every sort (no special manu path).
      // Skipped entirely for a domain search (domainParam) — that path already
      // populated `items` with the exact on-domain company above.
      if (!domainParam) {
        const SEARCH_STOPWORDS = new Set([
          "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "by",
          "with", "at", "from", "as", "is", "are", "be",
        ]);
        const orderBy = sort === "name" ? "ORDER BY c.company_name ASC" : "ORDER BY c._ts DESC";
        const tokenParams = [{ name: "@take", value: limit }];
        let tokenWhere = "";

        if (q_norm && ftsPhrases.length > 0) {
          let pIdx = 0;
          const phraseClauses = [];
          for (const phrase of ftsPhrases) {
            const words = String(phrase || "")
              .split(/\s+/)
              .filter((w) => w.length >= 2 && !SEARCH_STOPWORDS.has(w));
            if (words.length === 0) continue;
            const wordClauses = [];
            for (const word of words) {
              const variants = new Set([word]);
              const st = simpleStem(word);
              if (st && st.length >= 2) variants.add(st);
              const ors = [];
              for (const v of variants) {
                const pn = `@tok${pIdx++}`;
                tokenParams.push({ name: pn, value: v });
                ors.push(`ARRAY_CONTAINS(c.search_tokens, ${pn})`);
              }
              wordClauses.push(`(${ors.join(" OR ")})`);
            }
            if (wordClauses.length > 0) {
              phraseClauses.push(`(${wordClauses.join(" AND ")})`);
            }
          }

          // Compact-form phrase: handles the tokenizer asymmetry where a
          // brand is stored as ONE solid token (MyPillow, Lululemon,
          // YouTube, Facebook — names with no whitespace) but the user
          // types it WITH whitespace ("my pillow", "lulu lemon"). The
          // per-word AND above can't match — the doc has neither "my" nor
          // "pillow" as a separate token, only "mypillow". Adding the
          // joined q_compact as one more phrase (OR'd with the existing
          // ones) lets ARRAY_CONTAINS hit "mypillow" directly. Strictly
          // ADDITIVE — never removes a match the AND path was already
          // catching. Gate keeps it from firing on single-word queries
          // (q_compact === q_norm — would be a duplicate clause) and on
          // compacts too short to be discriminating ("to do" → "todo" is
          // noise; "iam" / "ups" / actual short brand acronyms are real).
          // Mirrors the per-word loop's stem-variant treatment.
          if (
            q_compact &&
            q_compact !== q_norm &&
            q_compact.length >= 4 &&
            !SEARCH_STOPWORDS.has(q_compact)
          ) {
            const variants = new Set([q_compact]);
            const st = simpleStem(q_compact);
            if (st && st.length >= 2) variants.add(st);
            const ors = [];
            for (const v of variants) {
              const pn = `@tok${pIdx++}`;
              tokenParams.push({ name: pn, value: v });
              ors.push(`ARRAY_CONTAINS(c.search_tokens, ${pn})`);
            }
            phraseClauses.push(`(${ors.join(" OR ")})`);
          }

          if (phraseClauses.length > 0) {
            tokenWhere = `AND (${phraseClauses.join(" OR ")}) `;
          }
        }

        const tokenSql = `
            SELECT TOP @take ${SLIM_SELECT_FIELDS}
            FROM c
            WHERE ${softDeleteFilter} ${tokenWhere}
            ${orderBy}
          `;
        const tokenRes = await container.items
          .query({ query: tokenSql, parameters: tokenParams }, { enableCrossPartitionQuery: true })
          .fetchAll();
        items = tokenRes.resources || [];
      }

      // Compute once and reuse for the broadening + fuzzy gates below.
      const hasStrongNameMatch =
        items.length > 0 &&
        items.some((c) => computeNameMatchScore(c, q_raw, q_norm, q_compact) >= 60);

      // ── Broadening fallback (restored Pass 3) ──
      // The Phase 4.36 search_tokens rewrite removed Pass 3 on the rationale
      // that the indexed AND-of-tokens query "already covers multi-word
      // recall". It doesn't — when a brand's record doesn't have ALL the
      // query words as tags, strict AND returns zero. Production case:
      // searching "alo yoga" returned 0 items because the ALO brand has
      // "alo" in search_tokens but no "yoga" tag (its industries are
      // Apparel / Activewear / leggings / etc.). Same hazard for any
      // "brand + category" query when the brand isn't tagged for that
      // category. Restore Pass 3 as a CONDITIONAL fallback: fires only on
      // multi-word queries where the token query returned thin results and
      // produced no strong primary name match. When the AND query already
      // found a clear primary or a healthy result pool, the broadening
      // pass adds noise — so we gate hard.
      const BROADEN_FALLBACK_THRESHOLD = 10;
      let usedBroadenFallback = false;
      if (
        !domainParam &&
        !quickMode &&
        q_norm &&
        !hasStrongNameMatch &&
        items.length < BROADEN_FALLBACK_THRESHOLD
      ) {
        const broadenWords = q_norm.split(/\s+/).filter((w) => w.length >= 3);
        if (broadenWords.length >= 2) {
          const broadenParams = [{ name: "@broadenTake", value: limit }];
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
            SELECT TOP @broadenTake ${SLIM_SELECT_FIELDS}
            FROM c
            WHERE (${broadenClauses.join(" OR ")}) AND ${softDeleteFilter}
            ORDER BY c._ts DESC
          `;

          try {
            const broadenRes = await container.items
              .query(
                { query: broadenSql, parameters: broadenParams },
                { enableCrossPartitionQuery: true }
              )
              .fetchAll();
            const broadenItems = broadenRes.resources || [];
            const existingIds = new Set(items.map((i) => i.id));
            for (const item of broadenItems) {
              if (existingIds.has(item.id)) continue;
              item._broadenedMatch = true;
              items.push(item);
              existingIds.add(item.id);
            }
            usedBroadenFallback = true;
          } catch (broadenErr) {
            // Best-effort. If this fails, the user still gets the token-query
            // results (possibly empty) and the fuzzy fallback below still runs.
            context.log("[search-companies] broadening fallback error:", broadenErr?.message);
          }
        }
      }

      // Fuzzy fallback: fall back to prefix-based search with Damerau-Levenshtein
      // post-filter when primary search produces no real name match for the query.
      // Tries a 4-char prefix first, then a 3-char prefix.

      if (!domainParam && !hasStrongNameMatch && q_norm && q_norm.length >= 4 && !quickMode) {
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
              SELECT TOP @fuzzyTake ${SLIM_SELECT_FIELDS}
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
      if (!domainParam && !quickMode && q_norm && skip === 0) {
        let primary = null;
        let primaryScore = 0;
        for (const c of items) {
          // Fuzzy-matched companies are automatic primaries: the fuzzy
          // fallback has already concluded the user meant THIS company
          // (it survived a Damerau-Levenshtein threshold). Re-running
          // computeNameMatchScore against the user's original typo'd
          // query would return 0 here (because the typo doesn't literally
          // match the company name) and Pass 4 would silently skip —
          // exactly the moodhops → MoodHoops case where peer comps
          // (UltraPoi, Hoopologie, HulaFit, Hoopnotica) never surfaced.
          const score = c._fuzzyMatch
            ? 100
            : computeNameMatchScore(c, q_raw, q_norm, q_compact);
          if (score > primaryScore) {
            primaryScore = score;
            primary = c;
          }
        }
        // Threshold of 70 catches both the common brand-search shapes:
        //   - user types ONE word that's the first word of a multi-word
        //     company name (everlit → EVERLIT SURVIVAL, skindinavia →
        //     Skindinavia Inc, greenlight → Greenlight Bookstore). These
        //     land at nameScore = 80 via the startsWith path.
        //   - user types BRAND + QUALIFIER where the brand is a short
        //     prefix of the query ("alo yoga" → ALO, "watson farms beef"
        //     → Watson Farms, "boulder canyon kettle" → Boulder Canyon).
        //     These land at nameScore = 70 via the q.startsWith(name)
        //     path. Without catching this case, ALO surfaces (via
        //     broadening fallback) for "alo yoga" but Pass 4 doesn't fire
        //     so the user never sees ALO's true activewear/apparel
        //     competitors (Athleta, Lululemon, etc.) — only yoga-tagged
        //     companies via the broadening pass.
        // 70 is the precise floor for "user's query begins with this
        // company's full name", which is rarely accidental. Tighter than
        // the word-boundary (60) and substring (40) paths, which would
        // over-fire.
        if (
          primary &&
          primaryScore >= 70 &&
          Array.isArray(primary.industries) &&
          primary.industries.length > 0
        ) {
          // Comp retrieval used to require another company's industry tag to
          // EXACTLY equal one of the primary's. In a catalog with ~21k
          // near-unique industry labels, a brand like Skindinavia (industry
          // "Makeup Setting Sprays") shares that exact tag with nobody — so
          // the comp query returned empty and the user saw only the brand.
          //
          // We match on PHRASES (consecutive bigrams) extracted from the
          // primary's industry tags, not loose single words. "Makeup Setting
          // Sprays" → {"makeup setting", "setting spray"}. The bigram
          // "setting spray" is the discriminating comp anchor — it matches
          // every setting-spray company without dragging in unrelated
          // "spray" (hairspray, sunscreen) or "setting" (table setting)
          // companies that loose single-word matching would pull in.
          // Single-word industry tags (e.g. "Cosmetics") fall back to the
          // bare word. Generic business filler is dropped so a bigram never
          // collapses to noise.
          const INDUSTRY_STOPWORDS = new Set([
            "and", "the", "of", "for", "with", "in", "on", "to", "by",
            "a", "an", "or",
            "manufacturing", "manufacturer", "production", "products",
            "product", "company", "companies", "retail", "wholesale",
            "services", "service", "supply", "supplies", "brand", "brands",
            "goods", "store", "shop", "co", "inc", "llc", "industry",
            "industries", "general",
          ]);
          const industryTerms = new Set();
          for (const ind of primary.industries) {
            const words = String(ind || "")
              .toLowerCase()
              .split(/\s+/)
              .map((raw) => raw.replace(/[^a-z0-9]/g, ""))
              .filter((w) => w.length >= 3 && !INDUSTRY_STOPWORDS.has(w))
              .map((w) => {
                const s = simpleStem(w);
                return s && s.length >= 3 ? s : w;
              });
            if (words.length >= 2) {
              // Consecutive bigrams — the discriminating comp anchors.
              for (let i = 0; i < words.length - 1; i++) {
                industryTerms.add(`${words[i]} ${words[i + 1]}`);
              }
            } else if (words.length === 1) {
              // Single-word industry tag: use the bare word.
              industryTerms.add(words[0]);
            }
          }
          // Cap at 8 distinct terms to keep the SQL bounded.
          const seedWords = [...industryTerms].slice(0, 8);
          if (seedWords.length > 0) {
            const indParams = [{ name: "@indTake", value: 50 }];
            const indClauses = seedWords.map((term, i) => {
              const p = `@iw${i}`;
              indParams.push({ name: p, value: term });
              // CONTAINS over each industry tag (lower-cased) so a company
              // whose tag merely includes the phrase — "Facial Setting
              // Spray", "Setting Spray Manufacturing" — counts as a comp.
              return `EXISTS(SELECT VALUE x FROM x IN c.industries WHERE CONTAINS(LOWER(x), ${p}))`;
            });
            const indSql = `
              SELECT TOP @indTake ${SLIM_SELECT_FIELDS}
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

      const _tRetrieved = Date.now(); // end of all Cosmos retrieval passes

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
          if (pub && r._domainExactMatch) pub._domainExactMatch = true;
          return pub;
        })
        .filter((c) => c && c.id);

      let deduped = mapped;

      // A domain search (pasted URL) is explicit "find THIS company" intent, so
      // it overrides all filters — the on-domain company is never dropped by an
      // active Amazon-only / location / concept filter. Skip the filter block
      // entirely (every item here is the exact domain match).
      if (!domainParam) {
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
      } // end filter block (skipped for a domain search)

      // Pin exact website (domain) matches to the top tier so they lead the
      // result set regardless of q_norm/sort — tier -1 is `_nameMatchScore >= 100`
      // (see relevanceTier). The main scoring loop below skips them.
      for (const c of deduped) {
        if (c._domainExactMatch) {
          c._nameMatchScore = 100;
          c._relevanceScore = 100;
          c._matchType = "website";
        }
      }

      // Resolve the affinity industries for this query once (data-driven inverted
      // index — replaces the old hand-curated PRODUCT_INDUSTRY_AFFINITY map).
      // Falls back to [] when the index isn't built yet; scoring then skips the
      // affinity bonus/penalty without breaking search.
      let affinityIndustries = [];
      let affinityIndex = null;
      if (q_norm) {
        try {
          affinityIndex = await loadIndustryAffinityIndex(container);
          affinityIndustries = getAffinityIndustriesFromIndex(affinityIndex, q_norm.split(/\s+/));
        } catch (err) {
          context.log?.("[search-companies] loadIndustryAffinityIndex failed:", err?.message);
        }
      }

      // Brand-name recovery (Gate A): a "brand + product qualifier" query
      // ("natrulo tallow soap", "viking blade chef knife") LEADS with the brand
      // name, then appends a product. computeNameMatchScore discards a single
      // shared token (it needs ≥2), so the named brand scores 0 on name and gets
      // buried under product specialists. Fix: when the QUERY LEADS WITH a
      // company's leading name token(s), pin that company.
      //
      // Order is the signal — the brand is the query PREFIX, then a qualifier.
      // We pin C when the query LEADS WITH C's leading (significant) name
      // token(s) AND the query carries a product qualifier beyond that brand
      // prefix (so pure-brand queries like "sub-zero" / "the north face" are
      // left to natural ranking — the gate only rescues a BURIED brand):
      //   (a) 2-token brand prefix ("viking blade", "true primal") + ≥1 more
      //       word — a two-word coincidence is unlikely, so no rarity test; or
      //   (b) 1-token brand prefix ("natrulo") that is DISTINCTIVE corpus-wide.
      // Distinctiveness (b) uses the typo-correction dictionary's `terms` map as
      // a real corpus-frequency signal (it keeps only tokens in ≥ 2 companies):
      // a leading word ABSENT from it is coined ("natrulo" → 1 company), while
      // common qualifier words ("organic", "honey", "apple", "hot") are present
      // and never pin. This is what pool-relative rarity could not tell apart.
      // Kill-switch: default ON; set BRAND_NAME_GATE_ENABLED=false/off/0 to
      // disable the pin without a redeploy (also used to A/B the gate's effect).
      const _brandGateEnabled = (() => {
        const raw = String(process.env.BRAND_NAME_GATE_ENABLED ?? "").toLowerCase().trim();
        return raw !== "false" && raw !== "off" && raw !== "0";
      })();
      const BRAND_STOP = new Set(["the", "and", "for", "with", "from", "your", "our", "all", "new", "a", "an", "of", "co"]);
      // Pin above any natural name score so the NAMED brand leads even when a
      // different company legitimately name-matches the query words higher
      // (e.g. "true primal maple granola" must beat "True North Granola").
      const BRAND_PIN_SCORE = 1000;
      const _commonTerms = typoDictionary && typoDictionary.terms ? typoDictionary.terms : null;
      const _splitToks = (str) =>
        foldDiacritics(String(str || "").toLowerCase()).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
      const _stripLeadStop = (toks) => { let i = 0; while (i < toks.length && BRAND_STOP.has(toks[i])) i++; return toks.slice(i); };
      const _nameLeadCache = new Map();
      const nameLeadTokens = (c) => {
        let t = _nameLeadCache.get(c);
        if (!t) { t = _stripLeadStop(_splitToks(c.company_name || c.display_name || c.name)); _nameLeadCache.set(c, t); }
        return t;
      };
      const _qLead = q_norm && _brandGateEnabled ? _stripLeadStop(_splitToks(q_norm)) : [];
      // Distinctive (corpus-wide) iff we have the dictionary AND the word isn't in
      // it. The dictionary tokenizes at ≥4 chars (_typoCorrection MIN_TOKEN_LEN),
      // so shorter words ("hot", "sub") can NEVER appear in it and must not be
      // read as distinctive — require length ≥ 4. Without the dictionary (cold
      // worker) we can't judge → treat as NOT distinctive so we never guess-pin.
      const _isDistinctiveWord = (w) => !!_commonTerms && w.length >= 4 && !(w in _commonTerms);

      // Attach relevance scores so the frontend can prioritise strong matches
      if (q_norm) {
        for (const company of deduped) {
          if (company._domainExactMatch) {
            // Already pinned to tier -1 above (exact website match) — don't let
            // the normal name/keyword scoring overwrite it.
            continue;
          }
          if (company._industryRelated) {
            // Pass 4 surfaced this company because it shares industry tags
            // with the primary brand match — not because it matches the
            // query directly. Without a fixed score it would fall through
            // to computeRelevanceScore which gives it 0 (no name match,
            // no keyword match for "nordstrom"), then the synonym-only
            // penalty zeroes it out completely, and MIN_RELEVANCE drops it
            // from results — leaving the user with just the brand and no
            // comps. Assign a small fixed relevance so they survive the
            // filter and appear in a clearly-below-tier-2 position. They
            // already rank below every genuine keyword/name match because
            // those score 30+ by construction.
            company._nameMatchScore = 0;
            company._keywordMatchScore = 0;
            company._relevanceScore = 20;
            company._matchType = "industry_related";
            delete company._industryRelated;
            continue;
          }
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
            const scores = computeRelevanceScore(company, q_raw, q_norm, q_compact, affinityIndustries, ftsPhrases);
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

          // Gate A pin (see leading-prefix rule above): the query leads with this
          // company's leading name token, and either a 2-token brand prefix
          // matches or the single leading word is pool-distinctive → the user
          // named this brand; pin it to the top tier so a product qualifier can't
          // bury it. Mirrors the exact domain-match pin. domainExact /
          // industryRelated rows `continue` above and never reach here.
          if (_qLead.length >= 2 && (company._nameMatchScore || 0) < BRAND_PIN_SCORE) {
            const nt = nameLeadTokens(company);
            if (nt.length && nt[0] === _qLead[0]) {
              // 2-token brand ("viking blade") + ≥1 qualifier word → qLead ≥ 3.
              const twoTokenBrand = _qLead.length >= 3 && nt.length >= 2 && nt[1] === _qLead[1];
              // 1-token distinctive brand ("natrulo") + ≥1 qualifier → qLead ≥ 2.
              const oneTokenBrand = _isDistinctiveWord(_qLead[0]);
              if (twoTokenBrand || oneTokenBrand) {
                company._nameMatchScore = BRAND_PIN_SCORE;
                company._relevanceScore = Math.max(company._relevanceScore || 0, BRAND_PIN_SCORE);
                company._matchType = "brand_name";
              }
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

      // Manufacturing proximity sort: tier-aware. Companies are bucketed by
      // relevance tier FIRST, then ordered by nearest manufacturing distance
      // within each tier. A pure-distance sort would let a low-relevance
      // company with a nearby factory (e.g. a fitness-equipment maker for a
      // "pre workout" supplement query) leap above genuine matches whose
      // factories happen to be farther. Tier-first keeps relevance primary
      // and makes "nearest" mean "nearest among comparably-relevant
      // companies". This also keeps page composition relevance-meaningful so
      // the frontend's strong/loosely-related divider divides a sensible set.
      if (sort === "manu" && !sortField && user_location) {
        for (const c of deduped) {
          c._nearestManuDistKm = nearestManuDistKm(c, user_location.lat, user_location.lng);
        }
        deduped.sort((a, b) => {
          const tierA = relevanceTier(a._relevanceScore || 0, a._nameMatchScore || 0);
          const tierB = relevanceTier(b._relevanceScore || 0, b._nameMatchScore || 0);
          if (tierA !== tierB) return tierA - tierB;
          const hasManuA = Array.isArray(a.manufacturing_locations) && a.manufacturing_locations.length > 0;
          const hasManuB = Array.isArray(b.manufacturing_locations) && b.manufacturing_locations.length > 0;
          // Within a tier: companies with manufacturing data above those without
          if (hasManuA && !hasManuB) return -1;
          if (!hasManuA && hasManuB) return 1;
          // Then by nearest distance
          return (a._nearestManuDistKm || Infinity) - (b._nearestManuDistKm || Infinity);
        });
      }

      // Brand-family grouping: when a search clearly targets one brand — the
      // top result is a strong name match (exact or startsWith, nameScore
      // >= 80) with a real domain — pull that brand's same-domain sub-
      // companies up to immediately follow it. So "HP" → [HP, HP Calculators,
      // …others] and "Canon" → [Canon, Canon Calculator, …others] instead of
      // unrelated higher-QQ companies interleaving between a parent and its
      // sub-brands. Scoped narrowly: fires ONLY on a strong-name-match top
      // result, and only moves that one brand's own same-domain siblings —
      // it does NOT globally cluster every domain. Skipped for proximity
      // sorts (manu/hq), which express "nearest first", a different intent.
      if (
        q_norm &&
        !sortField &&
        sort !== "manu" &&
        sort !== "hq" &&
        deduped.length > 1
      ) {
        const parent = deduped[0];
        const parentDomain = String(parent?.normalized_domain || "")
          .trim()
          .toLowerCase();
        const parentNameScore = computeNameMatchScore(
          parent,
          q_raw,
          q_norm,
          q_compact
        );
        if (
          parentNameScore >= 80 &&
          parentDomain &&
          parentDomain !== "unknown"
        ) {
          const family = [];
          const rest = [];
          for (let i = 1; i < deduped.length; i++) {
            const c = deduped[i];
            const dom = String(c?.normalized_domain || "").trim().toLowerCase();
            if (dom === parentDomain) family.push(c);
            else rest.push(c);
          }
          if (family.length > 0) {
            // family preserves its relevance-sorted relative order.
            deduped = [parent, ...family, ...rest];
          }
        }
      }

        return { deduped, usedBroadenFallback, hasStrongNameMatch, _tStart, _tRetrieved };
      }

      const pass1 = await runSearchPass(q_raw, q_norm, q_compact, q_stemmed);

      // ── Auto-applied typo correction ────────────────────────────────────
      // If the query the user typed found nothing worth showing but the typo
      // dictionary has a candidate, re-run the search on the correction and
      // show it as "Showing results for X — Search instead for Y".
      //
      // "Nothing worth showing" means: no rows at all, OR the only rows came
      // from the broaden fallback's OR-soup with nothing reaching the direct
      // tier. That is exactly the "oilve oil" shape — strict token AND finds
      // nothing, broaden matches bare "oil", and 476 motor-oil rows land at
      // tier 2. The broaden fallback itself is untouched; it is read purely as
      // a signal, because it legitimately serves thin-pool brand queries.
      //
      // This retrieval-grounded trigger is also what makes auto-applying safe
      // at all. A real brand ("padron") retrieves on its own token and
      // name-matches, so the pool is never junk and the second pass never
      // runs — regardless of whether the dictionary's brand-protection set is
      // stale. That staleness was the whole basis of the padron→patron
      // objection to unconditional rewriting.
      const shouldAutoCorrect = (p) => {
        if (!typo_suggestion || !allowCorrection) return false;
        if (domainParam || quickMode) return false; // exact intent / first paint
        // A second pass doubles Cosmos work; never risk the 15s hard timeout.
        if (Date.now() - _handlerStartedAt > SECOND_PASS_BUDGET_MS) return false;
        if (p.deduped.length === 0) return "empty";
        if (p.usedBroadenFallback && !p.hasStrongNameMatch && directMatchCount(p.deduped) === 0) {
          return "broaden_junk";
        }
        return false;
      };

      let pass = pass1;
      let appliedCorrection = null;
      const _trigger = shouldAutoCorrect(pass1);
      if (_trigger) {
        const corrected = typo_suggestion;
        const pass2 = await runSearchPass(
          q_raw,
          corrected,
          corrected.replace(/\s+/g, ""),
          stemWords(corrected)
        );
        // Only adopt the correction if it actually beats what we had — a
        // correction that is ALSO junk should not replace the user's query.
        const better =
          pass1.deduped.length === 0
            ? pass2.deduped.length > 0
            : directMatchCount(pass2.deduped) > 0;
        _typoDiag.trigger = _trigger;
        _typoDiag.pass1Count = pass1.deduped.length;
        _typoDiag.pass2Count = pass2.deduped.length;
        if (better) {
          pass = pass2;
          appliedCorrection = { original: q_norm, corrected };
          _typoDiag.applied = true;
        }
      }

      let { deduped, usedBroadenFallback, _tStart, _tRetrieved } = pass;
      // Timings span both passes so meta._timing stays honest about total work.
      if (pass !== pass1) _tStart = pass1._tStart;

      // countOnly mode: return just the total count, no items (used for async pagination info)
      if (countOnly) {
        const totalCount = deduped.length;
        const totalPages = Math.ceil(totalCount / take);
        // Count of DIRECT (strong) matches — the companies that appear above the
        // "Loosely related to …" divider on the frontend. Direct = relevanceTier
        // < 2 (the LOOSE_TIER_CUTOFF mirrored in ResultsPage.jsx). Only meaningful
        // when a text query was scored; location-only counts skip scoring, so we
        // return null there rather than a misleading 0.
        const directCount = q_norm ? directMatchCount(deduped) : null;
        return json(
          {
            ok: true,
            success: true,
            totalCount,
            totalPages,
            directCount,
            // Must mirror the full response: without this the page shows
            // corrected results while "Page 1 of N" counts the junk pool.
            meta: {
              q: q_raw,
              sort,
              take,
              ...(appliedCorrection ? { corrected_query: appliedCorrection } : {}),
            },
          },
          200,
          req
        );
      }

      const pagedSlim = deduped.slice(skip, skip + take);
      const hasMore = deduped.length > skip + take;
      // Enrich just this page with the display-only fields dropped from the slim
      // candidate projection. Ranking/order already finalized above — unchanged.
      const paged = await hydratePageDisplayFields(pagedSlim, container, context);

      // Fold the pagination totals into the full response. In non-quick mode the
      // pool scanned here is the SAME full pool a separate countOnly request
      // would scan, so returning totalCount/totalPages/directCount inline lets
      // the client skip that extra round-trip. Omitted in quick mode, whose pool
      // is intentionally small and would under-count.
      let pageInfo = {};
      if (!quickMode) {
        const directCount = q_norm ? directMatchCount(deduped) : null;
        pageInfo = {
          totalCount: deduped.length,
          totalPages: Math.ceil(deduped.length / take) || 1,
          directCount,
        };
      }

      // Domain-search meta. On a match we're silent (the pinned company IS the
      // answer); on a miss we flag matched:false so the frontend renders the
      // opt-in empty state. `alternatives` (like-brands + industries) is added
      // by Stage 5g below.
      const domainMatch = domainParam ? deduped.find((c) => c._domainExactMatch) : null;
      const domainMeta = domainParam
        ? domainMatch
          ? { matched_by: { type: "website", domain: domainParam, company_id: domainMatch.company_id || domainMatch.id } }
          : { domain_search: { domain: domainParam, matched: false } }
        : {};

      // ── Stage 5g: opt-in alternative suggestions (never auto-results) ──
      // Offered in BOTH domain outcomes. On a match: the found company's own
      // industries + a few same-industry peer brands. On a miss: seed from the
      // brand-token pipeline (one extra query) so the empty state can suggest
      // like brands + industries. Best-effort — a failure just omits them. The
      // frontend renders these as clickable chips that DROP the domain param.
      let domainAlternatives = null;
      if (domainParam) {
        try {
          const altBrands = [];
          const altIndustries = new Set();
          const pushBrand = (r) => {
            if (!r) return;
            const dom = String(r.normalized_domain || "").toLowerCase();
            if (dom === domainParam) return; // exclude the matched family
            const cid = r.company_id || r.id || "";
            if (altBrands.some((b) => b.company_id === cid)) return;
            altBrands.push({
              company_name: r.company_name || r.name || "",
              company_id: cid,
              normalized_domain: dom,
            });
          };

          // Slim projection — alternatives only need identity + industries,
          // not the full SELECT_FIELDS payload (keeps RU/response small).
          const ALT_FIELDS =
            "c.company_name, c.company_id, c.id, c.normalized_domain, c.industries, c._ts";

          if (domainMatch) {
            // Match: the found company's own industries (shown as-is), plus
            // peer brands RANKED by how much of its industry fingerprint they
            // share. A broad OR-query over the tags gives a candidate pool;
            // we then score each by tag overlap so a peer that shares several
            // tags beats one that merely shares a single broad tag (e.g.
            // "food" pulling in food-packaging companies for an apparel brand).
            const myInds = normalizeStringArray(domainMatch.industries);
            myInds.slice(0, 5).forEach((i) => altIndustries.add(i));
            // Normalized tag fingerprint — wider window than the 5 shown so the
            // overlap score sees the company's full industry profile.
            const myTags = myInds
              .map((i) => String(i).toLowerCase().trim())
              .filter((i) => i.length >= 3)
              .slice(0, 15);
            const seed = myTags.slice(0, 8);
            if (seed.length) {
              const p = [{ name: "@t", value: 40 }, { name: "@dom", value: domainParam }];
              const clauses = seed.map((term, i) => {
                p.push({ name: `@a${i}`, value: term });
                return `EXISTS(SELECT VALUE x FROM x IN c.industries WHERE CONTAINS(LOWER(x), @a${i}))`;
              });
              const sql = `SELECT TOP @t ${ALT_FIELDS} FROM c WHERE (${clauses.join(" OR ")}) AND c.normalized_domain != @dom AND ${softDeleteFilter}`;
              const res = await container.items
                .query({ query: sql, parameters: p }, { enableCrossPartitionQuery: true })
                .fetchAll();
              // Rank by tag overlap: count how many of MY tags each candidate
              // covers (exact match or containment either direction). Tie-break
              // by recency so ordering is deterministic.
              const scored = (res.resources || []).map((r) => {
                const theirTags = normalizeStringArray(r.industries)
                  .map((i) => String(i).toLowerCase().trim())
                  .filter(Boolean);
                let overlap = 0;
                for (const m of myTags) {
                  if (theirTags.some((t) => t === m || t.includes(m) || m.includes(t))) overlap++;
                }
                return { r, overlap, ts: Number(r._ts) || 0 };
              });
              scored.sort((a, b) => b.overlap - a.overlap || b.ts - a.ts);
              for (const { r } of scored) {
                pushBrand(r);
                if (altBrands.length >= 5) break;
              }
            }
          } else if (q_norm) {
            // No match: seed like-brands from the brand token; industries follow.
            const words = q_norm
              .split(/\s+/)
              .map((w) => w.trim())
              .filter((w) => w.length >= 2)
              .slice(0, 6);
            if (words.length) {
              const p = [{ name: "@t", value: 12 }];
              const clauses = words.map((w, i) => {
                p.push({ name: `@w${i}`, value: w });
                return `ARRAY_CONTAINS(c.search_tokens, @w${i})`;
              });
              const sql = `SELECT TOP @t ${ALT_FIELDS} FROM c WHERE (${clauses.join(" OR ")}) AND ${softDeleteFilter} ORDER BY c._ts DESC`;
              const res = await container.items
                .query({ query: sql, parameters: p }, { enableCrossPartitionQuery: true })
                .fetchAll();
              for (const r of res.resources || []) {
                pushBrand(r);
                normalizeStringArray(r.industries).forEach((i) => altIndustries.add(i));
                if (altBrands.length >= 5) break;
              }
            }
          }

          const industries = [...altIndustries]
            .map((i) => String(i).trim())
            .filter(Boolean)
            .slice(0, 5);
          if (altBrands.length || industries.length) {
            domainAlternatives = { brands: altBrands.slice(0, 5), industries };
          }
        } catch (altErr) {
          context.log("[search-companies] domain alternatives error:", altErr?.message);
        }
      }

      return json(
        {
          ok: true,
          success: true,
          // Cosmos topology (db/container/partition-key/host) intentionally NOT
          // echoed to clients — this is a public endpoint. It is logged
          // server-side instead (see cosmos_target log above).
          items: paged,
          count: paged.length,
          hasMore,
          ...pageInfo,
          // Full matched id list for the map (opt-in, skipped in quickMode
          // whose pool is intentionally small — ids there would under-plot).
          ...(includeMatchIds && !quickMode
            ? { match_ids: deduped.map((c) => String(c.company_id || c.id || "")).filter(Boolean) }
            : {}),
          meta: {
            q: q_raw,
            sort,
            skip,
            take,
            user_location,
            _searchMode: quickMode
              ? "quick"
              : usedBroadenFallback
                ? "tokens+broaden"
                : "tokens",
            // The correction was APPLIED — these results are for `corrected`,
            // not for what the user typed. The client shows "Showing results
            // for X — Search instead for Y" and the escape hatch re-runs with
            // ?nocorrect=1.
            ...(appliedCorrection ? { corrected_query: appliedCorrection } : {}),
            // "Did you mean …?" — the non-destructive fallback, for when we did
            // NOT auto-apply: ?nocorrect=1 was set, or the corrected query was
            // itself junk. Mutually exclusive with corrected_query.
            ...(typo_suggestion && !appliedCorrection && deduped.length === 0
              ? { did_you_mean: { original: q_norm, suggestion: typo_suggestion } }
              : {}),
            ...domainMeta,
            ...(domainAlternatives ? { alternatives: domainAlternatives } : {}),
            _typoDiag,
            ...(_splitDiag ? { _splitDiag } : {}),
            _timing: {
              cosmos_ms: _tRetrieved - _tStart,
              compute_ms: Date.now() - _tRetrieved,
              total_ms: Date.now() - _tStart,
            },
          },
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
      return json({ ok: false, success: false, error: e?.message || "query failed" }, 500, req);
    }
  }

  return json({ ok: false, success: false, error: "Cosmos DB not configured" }, 503, req);
}

// Phase 4.29 — per-worker recycle code removed.
//
// Earlier commits (b35feddd "fix: per-worker recycle no longer kills in-flight
// responses") added a `_maybeRecycleWorker` path that called
// `setTimeout(() => process.exit(0), 100)` after 200 search-companies calls
// or 20 minutes of worker age. The intent was defense-in-depth against
// hypothetical leaked worker state.
//
// Forensic finding (2026-05-27, App Insights workspace
// af1760ad-1d06-429e-b846-3857086b2a2e): the recycle path was the actual
// cause of every multi-minute 500-storm we'd been chasing for 48 hours.
// Failure mode:
//   1. _requestsInFlight counted ONLY search-companies invocations, NOT
//      get-reviews / company-logo / ping / adminCompanies / etc.
//   2. When the recycle fired, the worker process exited even if other
//      functions were mid-flight on the same worker. process.exit(0)
//      kills the entire Node worker, not just one function.
//   3. Worse: the Function host had already dispatched additional
//      invocations to the doomed worker. When it died, those invocations
//      were stuck waiting until the platform's 10-minute functionTimeout
//      fired — producing the AppRequests entries with DurationMs ≈
//      600,000 whose OperationIds never appear in any trace log (the
//      handler never ran).
//
// Trust Azure Functions' built-in worker lifecycle management instead.
// Workers will live longer; if a genuine leak appears we'll see it in
// memory metrics and address it directly rather than via this
// sledgehammer.

// If the handler blocks past this (e.g. a Cosmos call wedged, an FTS
// query hanging despite AbortController), return 503 to unblock the
// response loop. The handler keeps running in the background — we can't
// truly cancel its in-flight work — but the per-worker recycle limits
// how many of those zombie requests can accumulate before the worker
// is replaced.
const REQUEST_HARD_TIMEOUT_MS = 15000;

function timeoutResponse(req) {
  return {
    status: 503,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Retry-After": "1",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({
      ok: false,
      success: false,
      error: "search timed out — please retry",
    }),
  };
}

/**
 * Lightly clone a cached response so the cached object's headers aren't
 * mutated by downstream code. The body is a string (already serialized)
 * so it can be shared by reference cheaply.
 */
function cloneCachedResponse(cached) {
  return {
    status: cached.status,
    headers: { ...cached.headers, "X-Cache": "HIT" },
    body: cached.body,
  };
}

/**
 * The Functions-host-facing wrapper. Adds the response cache, the
 * per-request hard timeout, and the per-worker recycle on top of
 * searchCompaniesHandler. Exported as `searchCompaniesHttpHandler` so
 * tests can drive the same code path the host does.
 */
async function searchCompaniesHttpHandler(req, context, deps = {}) {
  // ── Cache lookup ────────────────────────────────────────────────
  // Identical queries (after URL normalisation) within the TTL window
  // return the previously-computed response immediately. Skips the
  // entire pipeline including Cosmos round-trips.
  //
  // Phase 4.27 — gated on RESPONSE_CACHE_ENABLED env var; default
  // off. When disabled, cacheKey is null so both the lookup below
  // and the store further down short-circuit cleanly. X-Cache: MISS
  // is still tagged on every response for observability.
  const cacheKey = _responseCacheEnabled() ? buildCacheKey(req.url, req.method) : null;
  if (cacheKey) {
    const cached = _responseCache.get(cacheKey);
    if (cached) {
      return cloneCachedResponse(cached);
    }
  }

  const handlerPromise = searchCompaniesHandler(req, context, deps);
  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve(timeoutResponse(req)), REQUEST_HARD_TIMEOUT_MS)
  );
  const response = await Promise.race([handlerPromise, timeoutPromise]);

  // ── Cache store ─────────────────────────────────────────────────
  // Only cache successful responses (2xx). Errors / timeouts could be
  // transient and we don't want to pin them in the cache for 5 min.
  if (
    cacheKey &&
    response &&
    typeof response.status === "number" &&
    response.status >= 200 &&
    response.status < 300
  ) {
    _responseCache.set(cacheKey, {
      status: response.status,
      headers: { ...response.headers, "X-Cache": "MISS" },
      body: response.body,
    });
  }

  // Tag the (first-time) response as a MISS so cache behaviour is
  // observable end-to-end.
  if (response && response.headers) {
    response.headers = { ...response.headers, "X-Cache": "MISS" };
  }

  // Phase 4.29 — per-worker recycle bookkeeping removed. See the comment
  // block above the constants further up in this file for the forensic
  // narrative.

  return response;
}

app.http("search-companies", {
  route: "search-companies",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: searchCompaniesHttpHandler,
});

module.exports.handler = searchCompaniesHandler;
module.exports._test = {
  SELECT_FIELDS,
  SLIM_SELECT_FIELDS,
  normalizeStringArray,
  mapCompanyToPublic,
  searchCompaniesHandler,
  searchCompaniesHttpHandler,
  computeNameMatchScore,
  computeKeywordMatchScore,
  computeRelevanceScore,
  companyMatchesAllConcepts,
  isSynonymOnlyMatch,
  deduplicateByDomain,
  _getResponseCache,
};
