/**
 * Data-derived industry affinity index.
 *
 * Replaces the hand-curated PRODUCT_INDUSTRY_AFFINITY map that used to live
 * in api/search-companies/index.js. Instead of adding one entry per product
 * term, we scan every company in Cosmos and compute, for each term that
 * appears in a company's searchable text, which industries that term
 * co-occurs with most strongly (TF-IDF).
 *
 * The output is a single document stored in the companies container with
 * id = "_index_industry_affinity" (excluded from user search queries by the
 * existing `NOT STARTSWITH(c.id, '_')` filter).
 *
 * At query time, search-companies loads this doc once (cached in memory
 * with a TTL) and calls getAffinityIndustriesFromIndex() to determine the
 * affinity industries for a query — replacing the old hand-curated lookup.
 */

const { normalizeQuery, foldDiacritics } = require("./_queryNormalizer");

const INDEX_DOC_ID = "_index_industry_affinity";
const INDEX_PARTITION_KEY = "_index";

// Small English stopword set — these are rarely discriminating and inflate
// the index without helping ranking. Keeping this list conservative so we
// don't drop real signals (e.g. "tea", "oil" are short but meaningful).
const STOPWORDS = new Set([
  "a", "an", "the",
  "and", "or", "but", "nor",
  "of", "for", "with", "in", "on", "at", "to", "from", "by",
  "is", "are", "was", "were", "be", "been", "being",
  "it", "its", "this", "that", "these", "those",
  "we", "you", "our", "your", "their",
  "as", "if", "so", "not",
  "all", "any", "no",
  "com", "www", "http", "https",
]);

const MIN_TOKEN_LEN = 3;
const MIN_COMPANIES_PER_TERM = 3;     // drop terms appearing in < N companies as noise
const MAX_INDUSTRIES_PER_TERM = 10;   // cap index size — top-N industries per term
// Companies in the tabarnam catalog can have very specific free-text "industry"
// labels ("handmade natural bath body and beard care", "ethnic wear", "desert
// botanicals"). With ~3.5 unique industry labels per company, TF-IDF over the
// raw data produces noisy affinities where a term linked to a single niche
// industry scores very high. Only industries with at least this many companies
// participate in the affinity signal — the long tail of near-unique labels is
// treated as "no industry" for affinity purposes, so those companies get the
// neutral affinityBonus = 0 rather than a misleading boost.
const MIN_COMPANIES_PER_INDUSTRY = 5;

/**
 * Extract a deduplicated list of normalized terms from a free-text field.
 * Uses the same normalizeQuery pipeline as the search query itself, so a
 * query for "tooth" matches a stored keyword of "Tooth" or "tooth-friendly".
 */
function tokenize(text) {
  const norm = normalizeQuery(typeof text === "string" ? text : "");
  if (!norm) return [];
  const out = [];
  for (const word of norm.split(/\s+/)) {
    if (word.length < MIN_TOKEN_LEN) continue;
    if (STOPWORDS.has(word)) continue;
    out.push(word);
  }
  return out;
}

function normalizeIndustry(v) {
  return foldDiacritics(String(v || "").toLowerCase()).trim();
}

function uniqueNonEmpty(arr) {
  const set = new Set();
  for (const v of arr || []) {
    const s = typeof v === "string" ? v.trim() : String(v || "").trim();
    if (s) set.add(s);
  }
  return [...set];
}

/**
 * Build the full inverted index by scanning every active company in the
 * companies container. Pure accumulator — does not write to Cosmos; the
 * caller (admin endpoint / timer trigger) is responsible for persisting.
 *
 * Returns the full index doc ready to upsert.
 */
async function buildIndustryAffinityIndex(
  container,
  { log = console.log, minCompaniesPerIndustry = MIN_COMPANIES_PER_INDUSTRY } = {}
) {
  const startedAt = Date.now();

  const industryCompanyCount = Object.create(null);  // industry -> # companies in industry
  const termCompanyCount = Object.create(null);      // term -> # companies with this term
  const termByIndustry = Object.create(null);        // term -> { industry -> count }
  let totalCompanies = 0;

  const sql = {
    query:
      "SELECT c.id, c.company_name, c.display_name, c.name, c.tagline, " +
      "c.keywords, c.product_keywords, c.industries " +
      "FROM c WHERE NOT STARTSWITH(c.id, '_') " +
      "AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted = false) " +
      "AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')",
  };

  const iterator = container.items.query(sql, { maxItemCount: 200 });

  for await (const { resources } of iterator.getAsyncIterator()) {
    for (const company of resources || []) {
      const industries = uniqueNonEmpty(
        Array.isArray(company.industries) ? company.industries : []
      ).map(normalizeIndustry).filter(Boolean);
      if (industries.length === 0) continue;

      totalCompanies++;

      for (const ind of industries) {
        industryCompanyCount[ind] = (industryCompanyCount[ind] || 0) + 1;
      }

      // Extract terms once per company (deduplicated) so a term repeated
      // across keywords doesn't get counted N times for a single company.
      const terms = new Set();
      const textSources = [
        company.company_name,
        company.display_name,
        company.name,
        company.tagline,
        ...(Array.isArray(company.keywords) ? company.keywords : []),
        ...(Array.isArray(company.product_keywords) ? company.product_keywords : []),
      ];
      for (const src of textSources) {
        for (const t of tokenize(src)) terms.add(t);
      }

      for (const term of terms) {
        termCompanyCount[term] = (termCompanyCount[term] || 0) + 1;
        if (!termByIndustry[term]) termByIndustry[term] = Object.create(null);
        for (const ind of industries) {
          termByIndustry[term][ind] = (termByIndustry[term][ind] || 0) + 1;
        }
      }
    }

    if (totalCompanies % 500 === 0 && totalCompanies > 0) {
      log(`[industryAffinityIndex] scanned ${totalCompanies} companies so far`);
    }
  }

  // Filter industries by minimum-companies threshold. Industries below the
  // threshold (long-tail free-text labels like "ethnic wear", "desert
  // botanicals") contribute noise to TF-IDF — a term appearing in a single
  // niche-label industry gets amplified to top of the list.
  const keptIndustries = new Set();
  for (const [ind, count] of Object.entries(industryCompanyCount)) {
    if (count >= minCompaniesPerIndustry) keptIndustries.add(ind);
  }
  const numIndustries = keptIndustries.size;
  const terms = Object.create(null);

  for (const term of Object.keys(termByIndustry)) {
    if (termCompanyCount[term] < MIN_COMPANIES_PER_TERM) continue;

    const byIndustry = termByIndustry[term];

    // Drop per-term entries for industries below the size threshold.
    const filteredEntries = Object.entries(byIndustry).filter(([ind]) => keptIndustries.has(ind));
    if (filteredEntries.length === 0) continue;

    // idf over the filtered industry set.
    const idf = Math.log(numIndustries / filteredEntries.length);
    if (idf <= 0) continue;

    const scored = [];
    for (const [ind, count] of filteredEntries) {
      const tf = count / industryCompanyCount[ind]; // how typical is term for this industry?
      const score = tf * idf;
      if (score > 0) scored.push([ind, score]);
    }

    scored.sort((a, b) => b[1] - a[1]);
    const topN = scored.slice(0, MAX_INDUSTRIES_PER_TERM);
    if (topN.length === 0) continue;

    const compact = Object.create(null);
    for (const [ind, score] of topN) {
      compact[ind] = Math.round(score * 1000) / 1000; // 3 decimals is plenty
    }
    terms[term] = compact;
  }

  const doc = {
    id: INDEX_DOC_ID,
    normalized_domain: INDEX_PARTITION_KEY,
    type: "industry_affinity_index",
    version: 1,
    generated_at: new Date().toISOString(),
    build_ms: Date.now() - startedAt,
    total_companies: totalCompanies,
    industry_count: numIndustries,
    industry_count_raw: Object.keys(industryCompanyCount).length,
    term_count: Object.keys(terms).length,
    terms,
  };

  return doc;
}

// ── Query-time lookup ────────────────────────────────────────────────────

// Module-level cache so each Function App instance only reads the doc every
// CACHE_TTL_MS. The cache is refreshed opportunistically inside load(); a
// stale cache is still served if a refresh fails, to keep search available.
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
let _cache = null;
let _cacheAt = 0;
let _inFlight = null;

async function loadIndustryAffinityIndex(container, { force = false } = {}) {
  if (!container || typeof container.item !== "function") return null;

  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_TTL_MS) return _cache;
  if (_inFlight) return _inFlight;

  _inFlight = (async () => {
    try {
      const { resource } = await container
        .item(INDEX_DOC_ID, INDEX_PARTITION_KEY)
        .read();
      if (resource && resource.terms && typeof resource.terms === "object") {
        _cache = resource;
        _cacheAt = Date.now();
      }
      return _cache;
    } catch (err) {
      // Doc not yet built, or Cosmos unreachable — return cached (possibly null).
      // Search still works; it just doesn't apply the affinity bonus/penalty.
      return _cache;
    } finally {
      _inFlight = null;
    }
  })();

  return _inFlight;
}

/**
 * Given a loaded index and an array of normalized query words, return the
 * industries with strongest affinity to ALL the query words (intersection
 * semantics for multi-word queries; single-word queries return that word's
 * top industries).
 */
function getAffinityIndustriesFromIndex(
  index,
  queryWords,
  { topK = 3, minPerWord = 0.05 } = {}
) {
  if (!index || !index.terms) return [];
  const words = (queryWords || [])
    .map((w) => String(w || "").toLowerCase().trim())
    .filter((w) => w.length >= MIN_TOKEN_LEN && !STOPWORDS.has(w));
  if (words.length === 0) return [];

  const perWord = words.map((w) => index.terms[w] || null);
  // If ANY query word has zero affinity data, the intersection is empty.
  // (Single-word case falls through to the initial-set filter below.)
  if (perWord.some((m) => !m)) return [];

  // Start with industries that meet the per-word threshold for the first word
  let candidates = new Set(
    Object.entries(perWord[0])
      .filter(([, s]) => s >= minPerWord)
      .map(([ind]) => ind)
  );

  // Intersect across remaining words
  for (let i = 1; i < perWord.length; i++) {
    const next = perWord[i];
    for (const ind of [...candidates]) {
      if ((next[ind] || 0) < minPerWord) candidates.delete(ind);
    }
    if (candidates.size === 0) return [];
  }

  // Rank survivors by total score across all query words
  return [...candidates]
    .map((ind) => ({
      industry: ind,
      score: perWord.reduce((sum, m) => sum + (m[ind] || 0), 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.industry);
}

// Test hook — allow tests to reset the module cache between cases.
function _resetCache() {
  _cache = null;
  _cacheAt = 0;
  _inFlight = null;
}

module.exports = {
  buildIndustryAffinityIndex,
  loadIndustryAffinityIndex,
  getAffinityIndustriesFromIndex,
  tokenize,
  INDEX_DOC_ID,
  INDEX_PARTITION_KEY,
  MIN_COMPANIES_PER_INDUSTRY,
  STOPWORDS,
  _resetCache,
};
