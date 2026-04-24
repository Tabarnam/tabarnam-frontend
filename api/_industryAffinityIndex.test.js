const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  buildIndustryAffinityIndex,
  getAffinityIndustriesFromIndex,
  loadIndustryAffinityIndex,
  tokenize,
  _resetCache,
  INDEX_DOC_ID,
  INDEX_PARTITION_KEY,
} = require("./_industryAffinityIndex");

// ── tokenize ────────────────────────────────────────────────────────────

test("tokenize drops stopwords, diacritics, short tokens", () => {
  assert.deepEqual(tokenize("The Scraper Mixer Pro™"), ["scraper", "mixer", "pro"]);
  assert.deepEqual(tokenize("Béis Tongue Scraper"), ["beis", "tongue", "scraper"]);
  assert.deepEqual(tokenize("a an is"), []); // all stopwords
  assert.deepEqual(tokenize("  "), []);
  assert.deepEqual(tokenize(null), []);
});

test("tokenize keeps meaningful 3+ char tokens", () => {
  // "tea" is 3 chars and meaningful — the tokenizer should NOT drop it
  assert.deepEqual(tokenize("tea chocolate"), ["tea", "chocolate"]);
});

// ── buildIndustryAffinityIndex ──────────────────────────────────────────

function makeContainer(companies) {
  return {
    items: {
      query: () => ({
        getAsyncIterator: async function* () {
          yield { resources: companies };
        },
      }),
    },
  };
}

test("buildIndustryAffinityIndex computes TF-IDF style affinity", async () => {
  // Fixture: 8 companies across 3 industries. "tooth" appears as a token in 3+
  // Personal care companies so it passes the MIN_COMPANIES_PER_TERM=3 noise
  // filter; "scraper" appears in all three industries (so idf=0, dropped);
  // "mixer" appears only in Kitchen (3 companies).
  const companies = [
    { id: "a", company_name: "Tongue Pro",  industries: ["Personal care"], keywords: ["tongue scraper", "tooth tool"] },
    { id: "b", company_name: "Smile Co",    industries: ["Personal care"], keywords: ["tooth cleaner", "scraper"] },
    { id: "c", company_name: "Floss Corp",  industries: ["Personal care"], keywords: ["floss", "tooth whitener"] },
    { id: "d", company_name: "Breville",    industries: ["Kitchen"],       keywords: ["scraper mixer pro", "mixer"] },
    { id: "e", company_name: "CookCo",      industries: ["Kitchen"],       keywords: ["mixer", "dough scraper"] },
    { id: "g", company_name: "StandMix",    industries: ["Kitchen"],       keywords: ["mixer bowl", "stand mixer"] },
    { id: "f", company_name: "Otis",        industries: ["Firearms"],      keywords: ["brass scraper", "cleaning"] },
    { id: "h", company_name: "Remy Cleans", industries: ["Firearms"],      keywords: ["bore scraper", "lube"] },
  ];
  const container = makeContainer(companies);

  const doc = await buildIndustryAffinityIndex(container, { log: () => {} });
  assert.equal(doc.id, INDEX_DOC_ID);
  assert.equal(doc.normalized_domain, INDEX_PARTITION_KEY);
  assert.equal(doc.total_companies, 8);
  assert.equal(doc.industry_count, 3);

  // "tooth" only appears in Personal care companies → strong affinity
  assert.ok(doc.terms.tooth, "tooth should be indexed");
  assert.ok(doc.terms.tooth["personal care"] > 0, "tooth → personal care affinity present");
  assert.equal(doc.terms.tooth["kitchen"], undefined, "tooth should not map to kitchen");
  assert.equal(doc.terms.tooth["firearms"], undefined, "tooth should not map to firearms");

  // "scraper" appears in all 3 industries — idf = log(3/3) = 0, so the term
  // is skipped entirely (correctly marked as non-discriminating).
  assert.equal(doc.terms.scraper, undefined, "non-discriminating terms are skipped");

  // "mixer" only in Kitchen (3 companies) → strong Kitchen affinity
  assert.ok(doc.terms.mixer, "mixer should be indexed");
  assert.ok(doc.terms.mixer["kitchen"] > 0);
  assert.equal(doc.terms.mixer["personal care"], undefined);
});

test("buildIndustryAffinityIndex drops terms appearing in < 3 companies", async () => {
  // "unique" appears in only 1 company — should be filtered as noise.
  const companies = [
    { id: "a", company_name: "A", industries: ["Food"], keywords: ["unique_term_xyz", "coffee"] },
    { id: "b", company_name: "B", industries: ["Food"], keywords: ["coffee"] },
    { id: "c", company_name: "C", industries: ["Food"], keywords: ["coffee"] },
    { id: "d", company_name: "D", industries: ["Apparel"], keywords: ["shirt"] },
    { id: "e", company_name: "E", industries: ["Apparel"], keywords: ["shirt"] },
    { id: "f", company_name: "F", industries: ["Apparel"], keywords: ["shirt"] },
  ];
  const doc = await buildIndustryAffinityIndex(makeContainer(companies), { log: () => {} });
  assert.equal(doc.terms.unique_term_xyz, undefined, "unique rare term filtered as noise");
  assert.ok(doc.terms.coffee, "coffee (3 companies) survives");
  assert.ok(doc.terms.shirt, "shirt (3 companies) survives");
});

test("buildIndustryAffinityIndex ignores companies with no industries", async () => {
  const companies = [
    { id: "a", company_name: "A", industries: ["Food"], keywords: ["coffee"] },
    { id: "b", company_name: "B", industries: ["Food"], keywords: ["coffee"] },
    { id: "c", company_name: "C", industries: ["Food"], keywords: ["coffee"] },
    { id: "x", company_name: "X", industries: [],       keywords: ["coffee"] }, // skipped
    { id: "y", company_name: "Y",                        keywords: ["coffee"] }, // no industries field
  ];
  const doc = await buildIndustryAffinityIndex(makeContainer(companies), { log: () => {} });
  assert.equal(doc.total_companies, 3);
});

// ── getAffinityIndustriesFromIndex ──────────────────────────────────────

test("getAffinityIndustriesFromIndex: single-word query returns top industries", () => {
  const index = {
    terms: {
      tooth: { "personal care": 1.5, "pet care": 0.3 },
    },
  };
  const result = getAffinityIndustriesFromIndex(index, ["tooth"]);
  assert.deepEqual(result, ["personal care", "pet care"]);
});

test("getAffinityIndustriesFromIndex: multi-word query uses intersection (core fix for 'tooth scraper')", () => {
  const index = {
    terms: {
      tooth:   { "personal care": 1.5, "pet care": 0.3 },
      scraper: { "personal care": 0.6, "auto": 0.5, "kitchen": 0.4, "firearms": 0.1 },
    },
  };
  // Only "personal care" has non-zero score for BOTH words. Auto/Kitchen/Firearms
  // are dominant for "scraper" alone but shouldn't surface because "tooth" doesn't
  // map to them.
  const result = getAffinityIndustriesFromIndex(index, ["tooth", "scraper"]);
  assert.deepEqual(result, ["personal care"]);
});

test("getAffinityIndustriesFromIndex: returns [] when any query word is unknown", () => {
  const index = { terms: { tooth: { "personal care": 1.0 } } };
  // "xyzzy" has no affinity data → intersection collapses to empty
  assert.deepEqual(getAffinityIndustriesFromIndex(index, ["tooth", "xyzzy"]), []);
});

test("getAffinityIndustriesFromIndex: returns [] for empty inputs", () => {
  assert.deepEqual(getAffinityIndustriesFromIndex(null, ["tooth"]), []);
  assert.deepEqual(getAffinityIndustriesFromIndex({ terms: {} }, ["tooth"]), []);
  assert.deepEqual(getAffinityIndustriesFromIndex({ terms: { tooth: {} } }, []), []);
});

test("getAffinityIndustriesFromIndex: drops stopwords and short tokens from query", () => {
  const index = {
    terms: {
      hoodie: { apparel: 1.8 },
    },
  };
  // "a" and "the" are stopwords; "hoodie" is the real term — result should treat
  // this as a single-word query for "hoodie".
  const result = getAffinityIndustriesFromIndex(index, ["a", "the", "hoodie"]);
  assert.deepEqual(result, ["apparel"]);
});

test("getAffinityIndustriesFromIndex: respects minPerWord threshold", () => {
  const index = {
    terms: {
      foo: { "cat a": 1.0, "cat b": 0.01 }, // cat b is below 0.05
      bar: { "cat a": 0.5, "cat b": 0.5 },
    },
  };
  const result = getAffinityIndustriesFromIndex(index, ["foo", "bar"]);
  // "cat b" is below threshold for "foo" → filtered. Only "cat a" intersects.
  assert.deepEqual(result, ["cat a"]);
});

// ── loadIndustryAffinityIndex (cache + graceful failure) ─────────────────

function makeContainerWithRead(doc, { fail = false } = {}) {
  return {
    item(_id, _pk) {
      return {
        read: async () => {
          if (fail) throw new Error("Cosmos unreachable");
          return { resource: doc };
        },
      };
    },
  };
}

test("loadIndustryAffinityIndex caches results", async () => {
  _resetCache();
  let reads = 0;
  const doc = { id: INDEX_DOC_ID, terms: { foo: { bar: 1.0 } } };
  const container = {
    item() {
      return {
        read: async () => {
          reads++;
          return { resource: doc };
        },
      };
    },
  };
  const first = await loadIndustryAffinityIndex(container);
  const second = await loadIndustryAffinityIndex(container);
  assert.equal(first, doc);
  assert.equal(second, doc);
  assert.equal(reads, 1, "second call should hit the cache");
});

test("loadIndustryAffinityIndex returns null when index not yet built", async () => {
  _resetCache();
  const container = makeContainerWithRead(null, { fail: true });
  const result = await loadIndustryAffinityIndex(container);
  assert.equal(result, null);
});

test("loadIndustryAffinityIndex returns null for bad container", async () => {
  _resetCache();
  assert.equal(await loadIndustryAffinityIndex(null), null);
  assert.equal(await loadIndustryAffinityIndex({}), null);
});
