const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("./index.js");

function makeReq(url) {
  return {
    method: "GET",
    url,
    headers: new Headers(),
  };
}

function makeContainer(queryResponder) {
  return {
    items: {
      query: (spec) => ({
        fetchAll: async () => ({ resources: await queryResponder(spec) }),
      }),
    },
  };
}

test("/api/search-companies maps keywords to public payload", async () => {
  const doc = {
    id: "company_1",
    company_name: "Wiley's Finest",
    normalized_domain: "wileysfinest.com",
    keywords: ["fish oil", "omega-3", "wild Alaskan", "Alaska"],
    product_keywords: "",
    industries: ["Supplements"],
    manufacturing_locations: ["Alaska, US"],
    _ts: 1700000000,
  };

  const companiesContainer = makeContainer(async (spec) => {
    const q = String(spec?.query || "");

    const hasManufacturingExpr =
      "IS_ARRAY(c.manufacturing_locations) AND ARRAY_LENGTH(c.manufacturing_locations) > 0";
    const noManufacturingExpr =
      "(NOT IS_ARRAY(c.manufacturing_locations) OR ARRAY_LENGTH(c.manufacturing_locations) = 0)";

    if (q.includes(hasManufacturingExpr)) return [doc];
    if (q.includes(noManufacturingExpr)) return [];

    return [doc];
  });

  const res = await _test.searchCompaniesHandler(
    makeReq("https://example.test/api/search-companies?q=wiley%27s&sort=manu&take=10"),
    { log() {} },
    { companiesContainer }
  );

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.items));
  assert.equal(body.items.length, 1);

  const item = body.items[0];
  assert.equal(item.id, "company_1");
  assert.equal(item.company_name, "Wiley's Finest");
  assert.ok(Array.isArray(item.keywords));
  assert.deepEqual(item.keywords, ["fish oil", "omega-3", "wild Alaskan", "Alaska"]);
});

test("/api/search-companies uses keywords in Cosmos filter when q is present", async () => {
  let lastSpec = null;
  const companiesContainer = makeContainer(async (spec) => {
    lastSpec = spec;
    return [];
  });

  const res = await _test.searchCompaniesHandler(
    makeReq("https://example.test/api/search-companies?q=alaska&sort=recent&take=10"),
    { log() {} },
    { companiesContainer }
  );

  assert.equal(res.status, 200);
  assert.ok(lastSpec);
  assert.ok(String(lastSpec.query || "").includes("c.keywords"));
});

test("/api/search-companies returns display_name and filters by it", async () => {
  const doc = {
    id: "company_2",
    company_name: "Acme Products",
    name: "RovR",
    normalized_domain: "acme.example",
    manufacturing_locations: ["CA, US"],
    _ts: 1700000001,
  };

  const companiesContainer = makeContainer(async (spec) => {
    const sql = String(spec?.query || "");
    // Filter now uses LOWER(IIF(IS_STRING(...), ..., "")) to avoid type errors on legacy docs.
    const hasDisplayFilter = sql.includes("IS_STRING(c.display_name)") || sql.includes("IS_STRING(c.name)");
    if (!hasDisplayFilter) return [];
    return [doc];
  });

  const res = await _test.searchCompaniesHandler(
    makeReq("https://example.test/api/search-companies?q=rovr&sort=recent&take=10"),
    { log() {} },
    { companiesContainer }
  );

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].company_name, "Acme Products");
  assert.equal(body.items[0].display_name, "RovR");
});

// ── computeNameMatchScore tests ──────────────────────────────────────────

test("computeNameMatchScore returns 100 for exact name match", () => {
  const score = _test.computeNameMatchScore({ company_name: "Alo" }, "alo", "alo", "alo");
  assert.equal(score, 100);
});

test("computeNameMatchScore returns 100 for exact match ignoring case", () => {
  const score = _test.computeNameMatchScore({ company_name: "ALO" }, "Alo", "alo", "alo");
  assert.equal(score, 100);
});

test("computeNameMatchScore returns 80 for starts-with match", () => {
  const score = _test.computeNameMatchScore({ company_name: "Aloha Collection" }, "alo", "alo", "alo");
  assert.equal(score, 80);
});

test("computeNameMatchScore returns 60 for word-boundary match", () => {
  const score = _test.computeNameMatchScore({ company_name: "Team Alo Yoga" }, "alo", "alo", "alo");
  assert.equal(score, 60);
});

test("computeNameMatchScore returns 40 for substring match", () => {
  const score = _test.computeNameMatchScore({ company_name: "Catalog Online" }, "alo", "alo", "alo");
  assert.equal(score, 40);
});

test("computeNameMatchScore returns 0 for no name match", () => {
  const score = _test.computeNameMatchScore({ company_name: "SunCare" }, "alo", "alo", "alo");
  assert.equal(score, 0);
});

test("computeNameMatchScore uses display_name when company_name does not match", () => {
  const score = _test.computeNameMatchScore({ company_name: "XYZ Corp", display_name: "Alo" }, "alo", "alo", "alo");
  assert.equal(score, 100);
});

test("computeNameMatchScore takes the best score across name fields", () => {
  const score = _test.computeNameMatchScore({ company_name: "Aloha", display_name: "Alo" }, "alo", "alo", "alo");
  assert.equal(score, 100);
});

test("computeNameMatchScore returns 0 for empty/null inputs", () => {
  assert.equal(_test.computeNameMatchScore(null, "alo", "alo", "alo"), 0);
  assert.equal(_test.computeNameMatchScore({ company_name: "Alo" }, "", "", ""), 0);
});

test("search-companies response includes _nameMatchScore", async () => {
  const doc = {
    id: "alo_1",
    company_name: "Alo",
    normalized_domain: "alo.com",
    keywords: ["yoga", "athleisure"],
    industries: ["Apparel"],
    _ts: 1700000000,
  };

  const companiesContainer = makeContainer(async () => [doc]);

  const res = await _test.searchCompaniesHandler(
    makeReq("https://example.test/api/search-companies?q=alo&sort=recent&take=10"),
    { log() {} },
    { companiesContainer }
  );

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]._nameMatchScore, 100);
});

// ── stemmer tests ────────────────────────────────────────────────────────

const { simpleStem, stemWords } = require("../_stemmer");

test("simpleStem strips trailing s", () => {
  assert.equal(simpleStem("icebreakers"), "icebreaker");
  assert.equal(simpleStem("products"), "product");
  assert.equal(simpleStem("candles"), "candle");
});

test("simpleStem strips ies to y", () => {
  assert.equal(simpleStem("companies"), "company");
  assert.equal(simpleStem("batteries"), "battery");
});

test("simpleStem strips es after sh/ch/x/z", () => {
  assert.equal(simpleStem("washes"), "wash");
  assert.equal(simpleStem("watches"), "watch");
  assert.equal(simpleStem("boxes"), "box");
});

test("simpleStem strips sses to ss", () => {
  assert.equal(simpleStem("grasses"), "grass");
});

test("simpleStem strips ses to se", () => {
  assert.equal(simpleStem("cases"), "case");
  assert.equal(simpleStem("bases"), "base");
});

test("simpleStem does not strip ss, us, is endings", () => {
  assert.equal(simpleStem("glass"), "glass");
  assert.equal(simpleStem("cactus"), "cactus");
  assert.equal(simpleStem("basis"), "basis");
});

test("simpleStem does not stem short words (< 4 chars)", () => {
  assert.equal(simpleStem("bus"), "bus");
  assert.equal(simpleStem("gas"), "gas");
});

test("simpleStem is idempotent", () => {
  const words = ["icebreakers", "companies", "washes", "candles", "grasses", "cases"];
  for (const w of words) {
    const once = simpleStem(w);
    const twice = simpleStem(once);
    assert.equal(once, twice, `simpleStem is not idempotent for "${w}": "${once}" != "${twice}"`);
  }
});

test("stemWords stems each word in a string", () => {
  assert.equal(stemWords("body washes"), "body wash");
  assert.equal(stemWords("ice breakers products"), "ice breaker product");
});

// ── fuzzy match tests ────────────────────────────────────────────────────

const { levenshtein, maxEditDistance, isFuzzyNameMatch, fuzzyScore } = require("../_fuzzyMatch");

test("levenshtein returns 0 for identical strings", () => {
  assert.equal(levenshtein("obrilo", "obrilo"), 0);
});

test("levenshtein returns correct distance for insertion", () => {
  assert.equal(levenshtein("obrilo", "obrilio"), 1);
});

test("levenshtein returns correct distance for substitution", () => {
  assert.equal(levenshtein("obrilo", "obrilo"), 0);
  assert.equal(levenshtein("obrilo", "obrila"), 1);
});

test("maxEditDistance scales with word length", () => {
  assert.equal(maxEditDistance(4), 0);
  assert.equal(maxEditDistance(6), 1);
  assert.equal(maxEditDistance(7), 1);
  assert.equal(maxEditDistance(10), 2);
});

test("isFuzzyNameMatch matches within edit distance", () => {
  assert.equal(isFuzzyNameMatch("Obrilo", "obrilio"), true);      // distance 1, max 1 for 7-char query
  assert.equal(isFuzzyNameMatch("Obrilo", "obrilioxxyz"), false);  // distance 5, max 2 for 11-char query
  assert.equal(isFuzzyNameMatch("Aloha", "alohx"), true);          // distance 1, max 1 for 5-char query
  assert.equal(isFuzzyNameMatch("Alo", "xyz"), false);             // distance 3, max 0 for 3-char query
});

test("fuzzyScore returns higher score for closer matches", () => {
  const exact = fuzzyScore("obrilo", "obrilo");
  const close = fuzzyScore("obrilo", "obrilio");
  assert.ok(exact > close, `exact (${exact}) should be > close (${close})`);
  assert.ok(close > 0, `close match should have positive score`);
});

// ── keyword relevance scoring tests ──────────────────────────────────────

test("computeKeywordMatchScore returns 125 for exact keyword match with multi-term coupling", () => {
  const company = { product_keywords: ["body wash", "soap"] };
  const score = _test.computeKeywordMatchScore(company, "body wash", "bodywash");
  // base 100 + coupling bonus 25 (both "body" and "wash" covered)
  assert.equal(score, 125);
});

test("computeKeywordMatchScore returns 85 for starts-with keyword match with coupling", () => {
  const company = { product_keywords: ["body wash gel", "soap"] };
  const score = _test.computeKeywordMatchScore(company, "body wash", "bodywash");
  // base 60 + coupling bonus 25
  assert.equal(score, 85);
});

test("computeKeywordMatchScore returns 95 for word-boundary substring match with coupling", () => {
  const company = { product_keywords: ["organic body wash formula"] };
  const score = _test.computeKeywordMatchScore(company, "body wash", "bodywash");
  // base 70 + coupling bonus 25
  assert.equal(score, 95);
});

test("computeKeywordMatchScore penalizes partial word coverage", () => {
  const company = { keywords: ["body"] };
  const score = _test.computeKeywordMatchScore(company, "body wash", "bodywash");
  // "body" covers only 1 of 2 query words → partial penalty: 60 × 0.6 = 36
  assert.equal(score, 36);
});

test("computeKeywordMatchScore returns 0 for no match", () => {
  const company = { product_keywords: ["hair care", "shampoo"] };
  const score = _test.computeKeywordMatchScore(company, "body wash", "bodywash");
  assert.equal(score, 0);
});

test("computeRelevanceScore combines name and keyword scores", () => {
  const company = { company_name: "Body Wash Co", product_keywords: ["body wash"] };
  const scores = _test.computeRelevanceScore(company, "body wash", "body wash", "bodywash");
  assert.equal(scores._nameMatchScore, 80); // starts-with
  assert.equal(scores._keywordMatchScore, 125); // exact match + coupling bonus
  assert.equal(scores._relevanceScore, Math.round(80 * 0.7 + 125 * 0.3) + 20); // 114 (includes +20 name bonus)
});

test("computeRelevanceScore: partial keyword match scores lower than exact", () => {
  const lotionCo = { company_name: "The Lotion Company", keywords: ["body lotion"] };
  const washCo = { company_name: "Pure Body Care", product_keywords: ["body wash"] };
  const lotionScores = _test.computeRelevanceScore(lotionCo, "body wash", "body wash", "bodywash");
  const washScores = _test.computeRelevanceScore(washCo, "body wash", "body wash", "bodywash");
  assert.ok(
    washScores._relevanceScore > lotionScores._relevanceScore,
    `wash co (${washScores._relevanceScore}) should rank above lotion co (${lotionScores._relevanceScore})`
  );
});

// ── search response includes new scoring fields ──────────────────────────

test("search-companies response includes _relevanceScore and _matchType", async () => {
  const doc = {
    id: "bw_1",
    company_name: "Body Wash Direct",
    normalized_domain: "bodywashdirect.com",
    product_keywords: ["body wash"],
    keywords: [],
    industries: ["Personal Care"],
    _ts: 1700000000,
  };

  const companiesContainer = makeContainer(async () => [doc]);

  const res = await _test.searchCompaniesHandler(
    makeReq("https://example.test/api/search-companies?q=body+wash&sort=recent&take=10"),
    { log() {} },
    { companiesContainer }
  );

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.items.length, 1);
  const item = body.items[0];
  assert.ok(typeof item._nameMatchScore === "number");
  assert.ok(typeof item._keywordMatchScore === "number");
  assert.ok(typeof item._relevanceScore === "number");
  assert.ok(item._matchType === "word_boundary" || item._matchType === "substring", `Expected word_boundary or substring but got: ${item._matchType}`);
});

// ── FTS query in SQL filter ──────────────────────────────────────────────

test("search SQL uses CONTAINS fallback while FTS is disabled", async () => {
  const specs = [];
  const companiesContainer = makeContainer(async (spec) => {
    specs.push(spec);
    return [];
  });

  await _test.searchCompaniesHandler(
    makeReq("https://example.test/api/search-companies?q=icebreakers&sort=recent&take=10"),
    { log() {} },
    { companiesContainer }
  );

  assert.ok(specs.length > 0, "at least one query should be issued");
  // While USE_FTS is false, the handler should fall back to CONTAINS-based search
  const primarySql = String(specs[0].query || "");
  assert.ok(primarySql.includes("CONTAINS"), "Primary SQL should use CONTAINS while FTS is disabled");
});

test("CONTAINS fallback includes synonym variant params (company → co)", async () => {
  const specs = [];
  const companiesContainer = makeContainer(async (spec) => {
    specs.push(spec);
    return [];
  });

  await _test.searchCompaniesHandler(
    makeReq("https://example.test/api/search-companies?q=acme+company&sort=recent&take=10"),
    { log() {} },
    { companiesContainer }
  );

  assert.ok(specs.length > 0, "at least one query should be issued");
  // With two-pass search, synonym variants appear in Pass 2 (substring fallback)
  const allParams = specs.flatMap((s) => s.parameters || []);
  const variantValues = allParams.filter((p) => p.name.startsWith("@q_v")).map((p) => p.value);
  assert.ok(
    variantValues.some((v) => v.includes("acme co")),
    `Variant params should include "acme co" but got: ${JSON.stringify(variantValues)}`
  );
});

test("CONTAINS fallback includes per-word params for multi-word queries", async () => {
  const specs = [];
  const companiesContainer = makeContainer(async (spec) => {
    specs.push(spec);
    return [];
  });

  await _test.searchCompaniesHandler(
    makeReq("https://example.test/api/search-companies?q=monster+beverage&sort=recent&take=10"),
    { log() {} },
    { companiesContainer }
  );

  assert.ok(specs.length > 0, "at least one query should be issued");
  // With two-pass search, per-word params appear in Pass 2 (substring fallback)
  const allParams = specs.flatMap((s) => s.parameters || []);
  const wordValues = allParams.filter((p) => p.name.startsWith("@q_w")).map((p) => p.value);
  assert.ok(
    wordValues.includes("monster"),
    `Per-word params should include "monster" but got: ${JSON.stringify(wordValues)}`
  );
  assert.ok(
    wordValues.includes("beverage"),
    `Per-word params should include "beverage" but got: ${JSON.stringify(wordValues)}`
  );
});

// ── fuzzy fallback integration ───────────────────────────────────────────

test("search-companies uses word-boundary CONTAINS in Pass 1", async () => {
  const specs = [];
  const companiesContainer = makeContainer(async (spec) => {
    specs.push(spec);
    return [];
  });

  await _test.searchCompaniesHandler(
    makeReq("https://example.test/api/search-companies?q=robes&sort=recent&take=10"),
    { log() {} },
    { companiesContainer }
  );

  assert.ok(specs.length >= 1, "at least one query should be issued");
  // First query should be word-boundary (Pass 1)
  const firstParams = specs[0].parameters || [];
  const wbParam = firstParams.find((p) => p.name === "@q_wb");
  assert.ok(wbParam, "Pass 1 should have @q_wb parameter");
  assert.equal(wbParam.value, " robes ", "Word boundary param should be space-padded");
});

test("search-companies issues Pass 2 substring query to fill remaining slots", async () => {
  const specs = [];
  const companiesContainer = makeContainer(async (spec) => {
    specs.push(spec);
    return [];
  });

  await _test.searchCompaniesHandler(
    makeReq("https://example.test/api/search-companies?q=robes&sort=recent&take=10"),
    { log() {} },
    { companiesContainer }
  );

  // Should have at least 2 queries: Pass 1 (word-boundary) + Pass 2 (substring)
  assert.ok(specs.length >= 2, `Should issue Pass 1 + Pass 2 queries, got ${specs.length}`);
  const pass2Params = specs[1].parameters || [];
  const qParam = pass2Params.find((p) => p.name === "@q");
  assert.ok(qParam, "Pass 2 should have @q parameter for substring matching");
  assert.equal(qParam.value, "robes");
});

test("search-companies skips word-boundary for short queries (< 3 chars)", async () => {
  const specs = [];
  const companiesContainer = makeContainer(async (spec) => {
    specs.push(spec);
    return [];
  });

  await _test.searchCompaniesHandler(
    makeReq("https://example.test/api/search-companies?q=3m&sort=recent&take=10"),
    { log() {} },
    { companiesContainer }
  );

  assert.ok(specs.length >= 1, "at least one query should be issued");
  // Short queries should skip word-boundary and go straight to substring
  const firstParams = specs[0].parameters || [];
  const wbParam = firstParams.find((p) => p.name === "@q_wb");
  assert.ok(!wbParam, "Short queries should NOT have word-boundary params");
  const qParam = firstParams.find((p) => p.name === "@q");
  assert.ok(qParam, "Short queries should use substring @q param");
});

// ── word-boundary keyword scoring tests ──────────────────────────────────

test("computeKeywordMatchScore returns 20 for compound substring (robes in bathrobes)", () => {
  const company = { product_keywords: ["bathrobes"] };
  const score = _test.computeKeywordMatchScore(company, "robes", "robes");
  assert.equal(score, 20, "robes inside bathrobes should score 20 (non-boundary substring)");
});

test("computeKeywordMatchScore returns 70 for word-boundary substring (robes in silk robes)", () => {
  const company = { product_keywords: ["silk robes collection"] };
  const score = _test.computeKeywordMatchScore(company, "robes", "robes");
  assert.equal(score, 70, "robes at word boundary in keyword should score 70");
});

test("computeKeywordMatchScore still returns 100 for exact match", () => {
  const company = { product_keywords: ["robes"] };
  const score = _test.computeKeywordMatchScore(company, "robes", "robes");
  assert.equal(score, 100, "exact keyword match should score 100");
});

test("computeRelevanceScore boosts keyword weight when no name match", () => {
  const company = { company_name: "Acme Corp", product_keywords: ["robes"] };
  const scores = _test.computeRelevanceScore(company, "robes", "robes", "robes");
  // No name match (name doesn't contain "robes") → keyword at 60% weight
  assert.equal(scores._nameMatchScore, 0);
  assert.equal(scores._keywordMatchScore, 100);
  assert.equal(scores._relevanceScore, 60, "keyword-only match should use 60% weight");
});

test("computeRelevanceScore: exact robes keyword ranks above bathrobes compound", () => {
  const robesCo = { company_name: "Robe Shop", product_keywords: ["robes"] };
  const bathrobesCo = { company_name: "Hotel Supplies", product_keywords: ["bathrobes"] };
  const robesScores = _test.computeRelevanceScore(robesCo, "robes", "robes", "robes");
  const bathrobesScores = _test.computeRelevanceScore(bathrobesCo, "robes", "robes", "robes");
  assert.ok(
    robesScores._relevanceScore > bathrobesScores._relevanceScore,
    `robes co (${robesScores._relevanceScore}) should rank above bathrobes co (${bathrobesScores._relevanceScore})`
  );
});

test("computeRelevanceScore: name-starts-with always beats keyword-only (dove scenario)", () => {
  // Dove (Unilever): name starts with "dove", no keyword match
  const doveCo = { company_name: "Dove (Unilever)", product_keywords: ["body wash"] };
  const doveScores = _test.computeRelevanceScore(doveCo, "dove", "dove", "dove");
  // Aireloom: no name match, exact keyword "dove"
  const aireloomCo = { company_name: "Aireloom", product_keywords: ["dove"] };
  const aireloomScores = _test.computeRelevanceScore(aireloomCo, "dove", "dove", "dove");
  assert.equal(doveScores._nameMatchScore, 80);
  assert.equal(doveScores._keywordMatchScore, 0);
  assert.equal(aireloomScores._nameMatchScore, 0);
  assert.equal(aireloomScores._keywordMatchScore, 100);
  assert.ok(
    doveScores._relevanceScore > aireloomScores._relevanceScore,
    `Dove (${doveScores._relevanceScore}) should rank above Aireloom (${aireloomScores._relevanceScore})`
  );
});

// ── buildWordBoundaryFilter unit tests ───────────────────────────────────

test("buildWordBoundaryFilter includes space-padded query params", () => {
  const params = [];
  const filter = _test.buildWordBoundaryFilter("robes", "robe", "robes", params);
  const wbParam = params.find((p) => p.name === "@q_wb");
  assert.ok(wbParam, "Should have @q_wb param");
  assert.equal(wbParam.value, " robes ", "Should be space-padded");
  const stemmedParam = params.find((p) => p.name === "@q_stemmed_wb");
  assert.ok(stemmedParam, "Should have stemmed param when stemmed differs");
  assert.equal(stemmedParam.value, " robe ");
  assert.ok(filter.includes("CONTAINS"), "Filter should use CONTAINS");
});

test("buildWordBoundaryFilter skips stemmed when same as norm", () => {
  const params = [];
  _test.buildWordBoundaryFilter("robe", "robe", "robe", params);
  const stemmedParam = params.find((p) => p.name === "@q_stemmed_wb");
  assert.ok(!stemmedParam, "Should NOT have stemmed param when stemmed equals norm");
});

test("buildWordBoundaryFilter adds per-word AND for multi-word queries", () => {
  const params = [];
  const filter = _test.buildWordBoundaryFilter("silk robes", "silk robe", "silkrobes", params);
  const mw0 = params.find((p) => p.name === "@q_mw0");
  const mw1 = params.find((p) => p.name === "@q_mw1");
  assert.ok(mw0, "Should have per-word param @q_mw0");
  assert.ok(mw1, "Should have per-word param @q_mw1");
  assert.equal(mw0.value, " silk ");
  assert.equal(mw1.value, " robes ");
  // Filter should include AND logic for multi-word
  assert.ok(filter.includes("AND"), "Multi-word filter should use AND logic");
});

// ── fuzzy fallback integration ───────────────────────────────────────────

test("search-companies triggers fuzzy fallback when primary search returns 0 results", async () => {
  const doc = {
    id: "obrilo",
    company_name: "Obrilo",
    normalized_domain: "obrilo.com",
    keywords: [],
    industries: [],
    _ts: 1700000000,
  };

  let queryCount = 0;
  const companiesContainer = makeContainer(async (spec) => {
    queryCount++;
    const sql = String(spec?.query || "");
    // The fuzzy fallback query uses @prefix and @fuzzyTake — distinguish it from the primary query
    const isFuzzyQuery = spec?.parameters?.some((p) => p.name === "@fuzzyTake");
    if (isFuzzyQuery) return [doc];
    // Primary search returns nothing for "obrilio"
    return [];
  });

  const res = await _test.searchCompaniesHandler(
    makeReq("https://example.test/api/search-companies?q=obrilio&sort=recent&take=10"),
    { log() {} },
    { companiesContainer }
  );

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  // The fuzzy fallback should have fired
  assert.ok(queryCount >= 2, "Should have made at least 2 queries (primary + fuzzy fallback)");
  assert.ok(body.items.length > 0, "Should have found obrilo via fuzzy fallback");
  assert.equal(body.items[0].id, "obrilo");
  assert.equal(body.items[0]._matchType, "fuzzy");
});

// ── companyMatchesAllConcepts (comma-separated AND semantics) ────────────

test("companyMatchesAllConcepts passes when all concepts match", () => {
  const company = {
    company_name: "Viair",
    tagline: "#1 Brand For Tire Inflators & Air Compressors",
    keywords: ["tire inflators", "air compressor", "portable compressor"],
    industries: ["Compressors"],
    search_text_norm: " viair tire inflators air compressors ",
    search_text_stemmed: " viair tire inflator air compressor ",
  };
  assert.equal(_test.companyMatchesAllConcepts(company, ["air compressor", "tire"]), true);
});

test("companyMatchesAllConcepts drops companies missing any concept", () => {
  const vevor = {
    company_name: "Vevor",
    tagline: "Upgrade. The Home Creator Way",
    keywords: ["tire", "vacuum seal", "power tools"],
    industries: ["Power Tools", "Vacuum Seal"],
    search_text_norm: " vevor tire vacuum seal power tools ",
    search_text_stemmed: " vevor tire vacuum seal power tool ",
  };
  // Vevor has "tire" but no "air compressor" phrase anywhere → filtered.
  assert.equal(_test.companyMatchesAllConcepts(vevor, ["air compressor", "tire"]), false);
});

test("companyMatchesAllConcepts stems concepts so 'tires' matches 'tire' fields", () => {
  const viair = {
    company_name: "Viair",
    keywords: ["tire inflator", "air compressor"],
    industries: ["Compressors"],
    search_text_norm: " viair tire inflator air compressor ",
    search_text_stemmed: " viair tire inflator air compressor ",
  };
  // Concept "tires" (plural) should still match via stemming — without this,
  // Pass 1 retrieves the company but the concept filter would incorrectly drop it.
  assert.equal(_test.companyMatchesAllConcepts(viair, ["air compressor", "tires"]), true);
});

test("companyMatchesAllConcepts stems plural concept phrases", () => {
  const viair = {
    company_name: "Viair",
    tagline: "Air Compressors and inflators",
    keywords: ["air compressor"],
    search_text_norm: " viair air compressors and inflators ",
    search_text_stemmed: " viair air compressor and inflator ",
  };
  // "air compressors" (plural) concept should stem to "air compressor" and match.
  assert.equal(_test.companyMatchesAllConcepts(viair, ["air compressors", "tire"]), false); // no tire
  assert.equal(_test.companyMatchesAllConcepts(viair, ["air compressors"]), true);
});

test("companyMatchesAllConcepts returns true for empty concepts (no-op)", () => {
  const anything = { company_name: "Anything" };
  assert.equal(_test.companyMatchesAllConcepts(anything, []), true);
  assert.equal(_test.companyMatchesAllConcepts(anything, null), true);
});

test("companyMatchesAllConcepts folds diacritics consistently", () => {
  const beis = {
    company_name: "Béis",
    keywords: ["travel bags", "luggage"],
    search_text_norm: " beis travel bags luggage ",
    search_text_stemmed: " bei travel bag luggage ",
  };
  // Concepts are already normalized (lowercase + folded) by the caller, but
  // the matcher also folds the stored fields so data with leftover accents
  // (pre-backfill records) still matches.
  assert.equal(_test.companyMatchesAllConcepts(beis, ["beis", "luggage"]), true);
});

// ── stars sort: exact-name-match promotion ───────────────────────────────

test("stars sort: exact name match ranks above higher-rated non-exact matches", async () => {
  // Both companies land in tier 0 under the old scoring (Nesco has keyword
  // matches + Food industry affinity, Jerky & Spice has an exact name match
  // plus keywords). Nesco outrates Jerky & Spice — before the fix it won;
  // after the fix, the exact name match is promoted to its own pre-tier-0
  // bucket and ranks first regardless of stars.
  const jerkySpice = {
    id: "jerky-spice",
    company_name: "Jerky & Spice",
    normalized_domain: "jerkyandspice.com",
    keywords: ["jerky", "spice"],
    industries: ["Snack foods"],
    search_text_norm: " jerky spice jerky spice snack foods ",
    search_text_stemmed: " jerky spice jerky spice snack food ",
    rating: 3.0,
    star_rating: 3.0,
    auto_star_rating: 3.0,
    _ts: 1700000000,
  };
  const nesco = {
    id: "nesco",
    company_name: "Nesco",
    normalized_domain: "nesco.com",
    keywords: ["jerky dehydrator", "spice rub"],
    industries: ["Food Preservation"],
    search_text_norm: " nesco jerky dehydrator spice rub food preservation ",
    search_text_stemmed: " nesco jerky dehydrator spice rub food preservation ",
    rating: 3.5,
    star_rating: 3.5,
    auto_star_rating: 3.5,
    _ts: 1700000000,
  };

  const companiesContainer = makeContainer(async () => [nesco, jerkySpice]);
  const res = await _test.searchCompaniesHandler(
    makeReq(
      "https://example.test/api/search-companies?raw=Jerky+%26+Spice&norm=jerky+spice&compact=jerkyspice&sort=stars&take=10"
    ),
    { log() {} },
    { companiesContainer }
  );

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.items.length >= 2, "Both companies should be returned");
  assert.equal(
    body.items[0].id,
    "jerky-spice",
    "Exact name match should rank first despite lower star rating"
  );
});

// ── substring-coverage bug fix ───────────────────────────────────────────

test("computeKeywordMatchScore: 'bluetooth' no longer counts as covering 'tooth' (word-boundary)", () => {
  // Pre-fix: kw.includes(w) treated "bluetooth" as covering "tooth",
  // avoiding the ×0.6 weak-match penalty. Post-fix: we require a word
  // boundary, so a keyword like "bluetooth enabled" does NOT cover "tooth"
  // and the partial-coverage penalty correctly fires.
  const companyBuggy = { keywords: ["bluetooth enabled", "scraper mixer pro"] };
  const companyFull  = { keywords: ["tooth whitener",    "tongue scraper"] };

  const scoreBuggy = _test.computeKeywordMatchScore(companyBuggy, "tooth scraper", "toothscraper");
  const scoreFull  = _test.computeKeywordMatchScore(companyFull,  "tooth scraper", "toothscraper");

  // A company that only has "scraper" at a word boundary (and "bluetooth" as
  // a red herring) should score strictly lower than a company that genuinely
  // covers BOTH "tooth" and "scraper" at word boundaries.
  assert.ok(
    scoreBuggy < scoreFull,
    `bluetooth red-herring company (${scoreBuggy}) should score below genuine-match company (${scoreFull})`
  );
  // And crucially, the red-herring company should be in the weak-match range,
  // not the coupling-bonus range.
  assert.ok(scoreBuggy < 60, `bluetooth red-herring score should be < 60 (weak match), got ${scoreBuggy}`);
});

test("computeKeywordMatchScore: real-word 'tooth' in keyword still covers", () => {
  // Sanity check: a keyword that legitimately contains "tooth" as a word
  // (e.g. "tooth whitener") still covers the query word.
  const company = { keywords: ["tooth whitener", "tongue scraper"] };
  const score = _test.computeKeywordMatchScore(company, "tooth scraper", "toothscraper");
  // Both words covered at word boundaries → coupling bonus kicks in.
  assert.ok(score >= 60, `expected score >= 60 with both words covered, got ${score}`);
});

// ── industry-affinity bonus via caller-supplied list ─────────────────────

test("computeRelevanceScore applies +25 affinity bonus for matching industry", () => {
  // search_text_norm must include the query phrase to avoid the synonym-only
  // ×0.4 penalty (which is an unrelated rank-adjusting mechanism).
  const company = {
    company_name: "Toothpro",
    industries: ["Personal care"],
    keywords: ["tooth scraper"],
    search_text_norm: " toothpro tooth scraper personal care ",
  };
  const withAffinity = _test.computeRelevanceScore(
    company, "tooth scraper", "tooth scraper", "toothscraper",
    ["personal care"]
  );
  const withoutAffinity = _test.computeRelevanceScore(
    company, "tooth scraper", "tooth scraper", "toothscraper",
    []
  );
  // +25 boost when the company's industry is in the affinity list
  assert.equal(
    withAffinity._relevanceScore - withoutAffinity._relevanceScore,
    25,
    "affinity-aligned company gets +25"
  );
});

test("computeRelevanceScore applies −15 affinity penalty for non-matching industry", () => {
  const company = {
    company_name: "Breville",
    industries: ["Kitchen"],
    keywords: ["scraper mixer pro"],
    // Include the query phrase in search_text_norm so isSynonymOnlyMatch is
    // false — we're isolating the affinity-bonus behaviour.
    search_text_norm: " breville scraper mixer pro tooth scraper kitchen ",
  };
  const withAffinity = _test.computeRelevanceScore(
    company, "tooth scraper", "tooth scraper", "toothscraper",
    ["personal care"]
  );
  const withoutAffinity = _test.computeRelevanceScore(
    company, "tooth scraper", "tooth scraper", "toothscraper",
    []
  );
  // −15 penalty when there IS an affinity set but the company isn't in it
  assert.equal(
    withAffinity._relevanceScore - withoutAffinity._relevanceScore,
    -15,
    "non-aligned company gets −15"
  );
});

// ── isSynonymOnlyMatch: partial-match rule for multi-word queries ─────────

test("isSynonymOnlyMatch: company with a direct word-boundary match on ONE query word is NOT synonym-only", () => {
  // Breville-style: has "scraper" as a keyword but no "tooth" anywhere, and the
  // full phrase "tooth scraper" also doesn't appear. Pre-fix this was flagged
  // synonym-only (×0.4 penalty), which combined with other penalties kicked it
  // under MIN_RELEVANCE and filtered it out of results entirely.
  const breville = {
    company_name: "Breville",
    keywords: ["scraper mixer pro", "bluetooth enabled"],
    industries: ["Kitchen"],
  };
  assert.equal(_test.isSynonymOnlyMatch(breville, "tooth scraper", "toothscraper"), false);
});

test("isSynonymOnlyMatch: company with no word-boundary match on any query word IS synonym-only", () => {
  // A company that only matched via synonym expansion — e.g., a "pullover"
  // keyword matching "hoodie" query. Neither "hoodie" nor "sweatshirt" appear
  // as words in its data.
  const company = {
    company_name: "MerinoCo",
    keywords: ["pullover", "merino wool"],
    industries: ["Apparel"],
  };
  assert.equal(_test.isSynonymOnlyMatch(company, "hoodie sweatshirt", "hoodiesweatshirt"), true);
});

test("isSynonymOnlyMatch: full phrase match short-circuits immediately", () => {
  // If the full q_norm appears, we never reach the multi-word partial rule.
  const company = {
    company_name: "Tongue Scraper Co",
    keywords: ["tongue scraper"],
    industries: ["Personal care"],
  };
  assert.equal(_test.isSynonymOnlyMatch(company, "tongue scraper", "tonguescraper"), false);
});

test("isSynonymOnlyMatch: single-word query with no data match returns true (unchanged)", () => {
  const company = {
    company_name: "Something Unrelated",
    keywords: ["pullover"],
    industries: ["Apparel"],
  };
  // "hoodie" (single word) has no boundary match in "pullover" / "apparel" /
  // "something unrelated" — still synonym-only.
  assert.equal(_test.isSynonymOnlyMatch(company, "hoodie", "hoodie"), true);
});

// ── fuzzy fallback gating: typo correction even when Pass 2 returns decoys ──

test("fuzzy fallback fires for typo when Pass 2 returns substring decoys ('Cliff Bar' → Clif Bar)", async () => {
  // Realistic decoy: a Cliffside Bakery whose search_text_norm contains BOTH
  // "cliff" AND "bar" as substrings, satisfying Pass 2's per-word AND. Without
  // the gate change, Pass 2 returns this and items.length === 1 prevents fuzzy
  // fallback — Clif Bar never surfaces.
  const clifBar = {
    id: "clif-bar",
    company_name: "Clif Bar",
    normalized_domain: "clifbar.com",
    search_text_norm: " clif bar energy bars organic ingredients ",
    keywords: ["energy bars", "organic"],
    industries: ["Food"],
    _ts: 1700000000,
  };
  const decoy = {
    id: "cliffside-bakery",
    company_name: "Cliffside Bakery",
    normalized_domain: "cliffsidebakery.com",
    search_text_norm: " cliffside bakery granola bar pastries ",
    keywords: ["granola bar", "pastries"],
    industries: ["Food"],
    _ts: 1700000001,
  };

  const companiesContainer = makeContainer(async (spec) => {
    const isFuzzyQuery = spec?.parameters?.some((p) => p.name === "@fuzzyTake");
    if (isFuzzyQuery) {
      // Fuzzy SQL: STARTSWITH(name|domain, "clif"). Both Clif Bar and the decoy
      // could match "clif" prefix (Cliffside also starts with "clif"), but the
      // post-filter isFuzzyNameMatch only accepts edit-distance <= 2.
      return [clifBar, decoy];
    }
    // Primary search returns the decoy (Pass 2 substring AND on cliff+bar).
    return [decoy];
  });

  const res = await _test.searchCompaniesHandler(
    makeReq(
      "https://example.test/api/search-companies?raw=Cliff+Bar&norm=cliff+bar&compact=cliffbar&sort=stars&take=10"
    ),
    { log() {} },
    { companiesContainer }
  );

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  const ids = body.items.map((i) => i.id);
  assert.ok(ids.includes("clif-bar"), `expected Clif Bar in results, got: ${ids.join(", ")}`);
  const clif = body.items.find((i) => i.id === "clif-bar");
  assert.equal(clif._matchType, "fuzzy", "Clif Bar should be tagged as a fuzzy match");

  // Clif Bar should rank ABOVE the decoy. Before the fuzzy-rescoring fix,
  // fuzzy matches were capped at 50 (50 − dist×15 = 35 for distance 1) which
  // lost to the decoy's substring keyword score. Now fuzzy matches are scored
  // as if the user had typed the corrected name, giving Clif Bar an exact-name
  // match score (~100) minus a small per-edit penalty.
  const clifIdx = ids.indexOf("clif-bar");
  const decoyIdx = ids.indexOf("cliffside-bakery");
  assert.ok(
    clifIdx >= 0 && (decoyIdx < 0 || clifIdx < decoyIdx),
    `Clif Bar (idx ${clifIdx}) should rank above Cliffside Bakery decoy (idx ${decoyIdx})`
  );
  // And the relevance score should be in the strong-match range, not the
  // capped-at-50 fuzzy range it used to be.
  assert.ok(
    clif._relevanceScore >= 80,
    `Clif Bar relevance should be in the exact-name-match range, got ${clif._relevanceScore}`
  );
});

test("fuzzy fallback does NOT fire when a strong name match already exists", async () => {
  // Red Bull is in the catalog and matches "red bull" exactly by name —
  // computeNameMatchScore returns 100, so the gate (hasStrongNameMatch) is true
  // and the fuzzy SQL must not be issued. We assert by counting that no query
  // with @fuzzyTake parameter ran.
  const redBull = {
    id: "red-bull",
    company_name: "Red Bull",
    normalized_domain: "redbull.com",
    search_text_norm: " red bull energy drink ",
    keywords: ["energy drink"],
    industries: ["Beverages"],
    _ts: 1700000000,
  };

  let fuzzyQueriesIssued = 0;
  const companiesContainer = makeContainer(async (spec) => {
    if (spec?.parameters?.some((p) => p.name === "@fuzzyTake")) {
      fuzzyQueriesIssued++;
      return [];
    }
    return [redBull];
  });

  const res = await _test.searchCompaniesHandler(
    makeReq(
      "https://example.test/api/search-companies?raw=Red+Bull&norm=red+bull&compact=redbull&sort=stars&take=10"
    ),
    { log() {} },
    { companiesContainer }
  );

  assert.equal(res.status, 200);
  assert.equal(fuzzyQueriesIssued, 0, "fuzzy fallback must not fire when a strong name match already exists");
});

test("fuzzy fallback does NOT fire for queries shorter than 4 chars", async () => {
  let fuzzyQueriesIssued = 0;
  const companiesContainer = makeContainer(async (spec) => {
    if (spec?.parameters?.some((p) => p.name === "@fuzzyTake")) {
      fuzzyQueriesIssued++;
      return [];
    }
    return []; // primary returns nothing — the gate must still block fuzzy on short queries
  });

  const res = await _test.searchCompaniesHandler(
    makeReq("https://example.test/api/search-companies?raw=abc&norm=abc&compact=abc&sort=stars&take=10"),
    { log() {} },
    { companiesContainer }
  );

  assert.equal(res.status, 200);
  assert.equal(fuzzyQueriesIssued, 0, "fuzzy fallback must not fire for queries < 4 chars even with zero results");
});

// ── Pass 3: broadening — multi-word OR retrieval surfaces related companies ──

test("broadening pass: 'Hobbs Pickles' surfaces other pickle companies below the brand match", async () => {
  // Brand: matches both "hobbs" AND "pickles" → returned by Pass 1/2.
  const hobbsPickles = {
    id: "hobbs-pickles",
    company_name: "Hobbs Pickles",
    normalized_domain: "hobbspickles.com",
    search_text_norm: " hobbs pickles new york style deli pickles ",
    search_text_stemmed: " hobb pickle new york style deli pickle ",
    keywords: ["dill pickles", "kosher dill pickles"],
    industries: ["Pickles", "Food"],
    _ts: 1700000000,
  };
  // Three other pickle companies — only "pickles" matches, "hobbs" doesn't.
  // Pass 1 AND pass 2 won't return them; only the broadening pass will.
  const pete = {
    id: "pickle-pete",
    company_name: "Pickle Pete's",
    normalized_domain: "picklepete.com",
    search_text_norm: " pickle petes artisan pickles ",
    search_text_stemmed: " pickle pete artisan pickle ",
    keywords: ["artisan pickles"],
    industries: ["Pickles", "Food"],
    _ts: 1700000001,
  };
  const sour = {
    id: "sour-stuff",
    company_name: "Sour Stuff",
    normalized_domain: "sourstuff.com",
    search_text_norm: " sour stuff fermented pickles ",
    search_text_stemmed: " sour stuff ferment pickle ",
    keywords: ["fermented pickles"],
    industries: ["Pickles", "Food"],
    _ts: 1700000002,
  };
  const brine = {
    id: "brine-co",
    company_name: "Brine Co.",
    normalized_domain: "brineco.com",
    search_text_norm: " brine co craft pickles ",
    search_text_stemmed: " brine co craft pickle ",
    keywords: ["craft pickles"],
    industries: ["Pickles", "Food"],
    _ts: 1700000003,
  };
  // Floyd has neither word — should not appear.
  const floyd = {
    id: "floyd",
    company_name: "Floyd Furniture",
    normalized_domain: "floyd.com",
    search_text_norm: " floyd furniture modular sofa table ",
    search_text_stemmed: " floyd furniture modular sofa table ",
    keywords: ["modular sofa", "table"],
    industries: ["Furniture"],
    _ts: 1700000004,
  };

  const companiesContainer = makeContainer(async (spec) => {
    const isFuzzy = spec?.parameters?.some((p) => p.name === "@fuzzyTake");
    if (isFuzzy) return [];
    const isBroaden = spec?.parameters?.some((p) => p.name === "@broadenTake");
    if (isBroaden) {
      // Returns every company whose search_text_norm contains " hobbs " or
      // " pickles " (or stemmed equivalents).
      return [hobbsPickles, pete, sour, brine];
    }
    // Pass 1 + Pass 2 (strict AND) — only Hobbs matches both words.
    return [hobbsPickles];
  });

  const res = await _test.searchCompaniesHandler(
    makeReq(
      "https://example.test/api/search-companies?raw=Hobbs+Pickles&norm=hobbs+pickles&compact=hobbspickles&sort=stars&take=10"
    ),
    { log() {} },
    { companiesContainer }
  );

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  const ids = body.items.map((i) => i.id);
  assert.ok(ids.includes("hobbs-pickles"), "Hobbs Pickles must be in results");
  assert.equal(ids[0], "hobbs-pickles", `Hobbs Pickles must rank #1, got: ${ids.join(", ")}`);
  assert.ok(ids.includes("pickle-pete"), "Pickle Pete's must surface via broadening");
  assert.ok(ids.includes("sour-stuff"), "Sour Stuff must surface via broadening");
  assert.ok(ids.includes("brine-co"), "Brine Co. must surface via broadening");
  assert.ok(!ids.includes("floyd"), "Floyd Furniture must NOT appear (no query-word match)");
});

test("broadening pass is skipped for single-word queries", async () => {
  let broadenIssued = 0;
  const lone = {
    id: "lone",
    company_name: "Pickle Co",
    search_text_norm: " pickle co pickles ",
    search_text_stemmed: " pickle co pickle ",
    industries: ["Pickles"],
    _ts: 1700000000,
  };

  const companiesContainer = makeContainer(async (spec) => {
    if (spec?.parameters?.some((p) => p.name === "@broadenTake")) {
      broadenIssued++;
      return [];
    }
    return [lone];
  });

  const res = await _test.searchCompaniesHandler(
    makeReq("https://example.test/api/search-companies?raw=pickles&norm=pickles&compact=pickles&sort=stars&take=10"),
    { log() {} },
    { companiesContainer }
  );

  assert.equal(res.status, 200);
  assert.equal(broadenIssued, 0, "broadening pass must not fire for single-word queries");
});

test("broadening: 'bone broth' doesn't elevate single-word incidental matches", async () => {
  // Bone Broth Co matches both words → tier 0.
  const broth = {
    id: "bone-broth-co",
    company_name: "Bone Broth Co",
    normalized_domain: "bonebrothco.com",
    search_text_norm: " bone broth co organic bone broth ",
    search_text_stemmed: " bone broth co organic bone broth ",
    keywords: ["bone broth", "organic broth"],
    industries: ["Food"],
    _ts: 1700000000,
  };
  // Dog Toys Inc matches only "bone" — broadening pulls it in, but the
  // partial-coverage ×0.6 penalty in computeKeywordMatchScore should keep it
  // far below the real bone-broth match.
  const dogToys = {
    id: "dog-toys",
    company_name: "Dog Toys Inc",
    normalized_domain: "dogtoys.com",
    search_text_norm: " dog toys inc rawhide bone chew toys ",
    search_text_stemmed: " dog toy inc rawhide bone chew toy ",
    keywords: ["bone chew toys", "rawhide"],
    industries: ["Pets"],
    _ts: 1700000001,
  };

  const companiesContainer = makeContainer(async (spec) => {
    if (spec?.parameters?.some((p) => p.name === "@fuzzyTake")) return [];
    if (spec?.parameters?.some((p) => p.name === "@broadenTake")) {
      return [broth, dogToys]; // both match (broth has both words; dog has "bone" only)
    }
    // Pass 1+2 strict AND finds only the broth co.
    return [broth];
  });

  const res = await _test.searchCompaniesHandler(
    makeReq(
      "https://example.test/api/search-companies?raw=bone+broth&norm=bone+broth&compact=bonebroth&sort=stars&take=10"
    ),
    { log() {} },
    { companiesContainer }
  );

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  const ids = body.items.map((i) => i.id);
  assert.equal(ids[0], "bone-broth-co", `Bone Broth Co must rank #1, got: ${ids.join(", ")}`);
  if (ids.includes("dog-toys")) {
    const brothIdx = ids.indexOf("bone-broth-co");
    const dogIdx = ids.indexOf("dog-toys");
    assert.ok(brothIdx < dogIdx, "Dog Toys Inc must rank below Bone Broth Co");
  }
});
