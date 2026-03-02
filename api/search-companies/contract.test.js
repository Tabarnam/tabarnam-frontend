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
  assert.equal(maxEditDistance(3), 0);
  assert.equal(maxEditDistance(5), 1);
  assert.equal(maxEditDistance(7), 2);
  assert.equal(maxEditDistance(10), 3);
});

test("isFuzzyNameMatch matches within edit distance", () => {
  assert.equal(isFuzzyNameMatch("Obrilo", "obrilio"), true);     // distance 1, max 2 for 7-char query
  assert.equal(isFuzzyNameMatch("Obrilo", "obrilioxxyz"), false); // distance 5, max 3 for 11-char query
  assert.equal(isFuzzyNameMatch("Alo", "alox"), true);           // distance 1, max 1 for 4-char query
  assert.equal(isFuzzyNameMatch("Alo", "xyz"), false);           // distance 3, max 0 for 3-char query
});

test("fuzzyScore returns higher score for closer matches", () => {
  const exact = fuzzyScore("obrilo", "obrilo");
  const close = fuzzyScore("obrilo", "obrilio");
  assert.ok(exact > close, `exact (${exact}) should be > close (${close})`);
  assert.ok(close > 0, `close match should have positive score`);
});

// ── keyword relevance scoring tests ──────────────────────────────────────

test("computeKeywordMatchScore returns 100 for exact keyword match", () => {
  const company = { product_keywords: ["body wash", "soap"] };
  const score = _test.computeKeywordMatchScore(company, "body wash", "bodywash");
  assert.equal(score, 100);
});

test("computeKeywordMatchScore returns 60 for starts-with keyword match", () => {
  const company = { product_keywords: ["body wash gel", "soap"] };
  const score = _test.computeKeywordMatchScore(company, "body wash", "bodywash");
  assert.equal(score, 60);
});

test("computeKeywordMatchScore returns 70 for word-boundary substring match", () => {
  const company = { product_keywords: ["organic body wash formula"] };
  const score = _test.computeKeywordMatchScore(company, "body wash", "bodywash");
  assert.equal(score, 70);
});

test("computeKeywordMatchScore returns 60 when query starts with keyword", () => {
  const company = { keywords: ["body"] };
  const score = _test.computeKeywordMatchScore(company, "body wash", "bodywash");
  // "body wash" starts with "body" → 60 (starts-with match)
  assert.equal(score, 60);
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
  assert.equal(scores._keywordMatchScore, 100); // exact match
  assert.equal(scores._relevanceScore, Math.round(80 * 0.7 + 100 * 0.3)); // 86
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

test("computeKeywordMatchScore returns 35 for compound substring (robes in bathrobes)", () => {
  const company = { product_keywords: ["bathrobes"] };
  const score = _test.computeKeywordMatchScore(company, "robes", "robes");
  assert.equal(score, 35, "robes inside bathrobes should score 35 (non-boundary substring)");
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
