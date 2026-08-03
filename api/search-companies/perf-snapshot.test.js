// Golden-query ranking snapshot — the guardrail for the search-perf work
// (workstreams #1-#4). A fixed synthetic corpus is run through the real
// handler for a set of representative queries; we snapshot the ordered result
// ids + _relevanceScore. Optimizations that are meant to preserve ranking
// (#1 slim projection, #2 score-raw/map-paged, #3 scoring micro-opts) MUST keep
// this identical; #4 (fallback parallelize/collapse) must keep the top-N
// identical. Run with SNAPSHOT_UPDATE=1 to (re)generate EXPECTED after an
// INTENTIONAL ranking change; otherwise the test asserts no drift.
const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("./index.js");
const { _resetCache: resetTypoCorrectionCache } = require("../_typoCorrection");
const { _resetCache: resetIndustryAffinityCache } = require("../_industryAffinityIndex");

// ── Fixed corpus ─────────────────────────────────────────────────────────
// Deterministic. Covers: brand-name hits, keyword hits, multi-word, a synonym
// case (fridge→refrigerator), two sub-brands sharing a domain (dedup), and
// noise. Fields are only what scoring/sort/dedup read.
function c(o) {
  return {
    company_id: o.id,
    product_keywords: "",
    industries: [],
    keywords: [],
    manufacturing_locations: [],
    manufacturing_geocodes: [],
    _ts: o._ts || 1700000000,
    ...o,
  };
}
const CORPUS = [
  c({ id: "patagonia", company_name: "Patagonia", normalized_domain: "patagonia.com", industries: ["Apparel", "Outdoor"], keywords: ["jackets", "fleece", "outdoor gear"], search_tokens: ["patagonia"], search_text_norm: "patagonia jackets fleece outdoor gear apparel", manufacturing_locations: ["Ventura, CA, US"] }),
  c({ id: "yeti", company_name: "YETI", normalized_domain: "yeti.com", industries: ["Outdoor", "Drinkware"], keywords: ["coolers", "tumblers", "insulated"], search_tokens: ["yeti"], search_text_norm: "yeti coolers tumblers insulated drinkware outdoor" }),
  c({ id: "bluebottle", company_name: "Blue Bottle Coffee", normalized_domain: "bluebottlecoffee.com", industries: ["Coffee", "Beverage"], keywords: ["coffee", "espresso", "beans"], search_tokens: ["blue", "bottle", "coffee"], search_text_norm: "blue bottle coffee espresso beans beverage", manufacturing_locations: ["Oakland, CA, US"] }),
  c({ id: "stumptown", company_name: "Stumptown Coffee Roasters", normalized_domain: "stumptowncoffee.com", industries: ["Coffee"], keywords: ["coffee", "roasters", "cold brew"], search_tokens: ["stumptown", "coffee", "roasters"], search_text_norm: "stumptown coffee roasters cold brew" }),
  c({ id: "deathwish", company_name: "Death Wish Coffee", normalized_domain: "deathwishcoffee.com", industries: ["Coffee"], keywords: ["coffee", "strong coffee", "beans"], search_tokens: ["death", "wish", "coffee"], search_text_norm: "death wish coffee strong beans" }),
  c({ id: "counterculture", company_name: "Counter Culture Coffee", normalized_domain: "counterculturecoffee.com", industries: ["Coffee"], keywords: ["coffee", "beans", "roasters"], search_tokens: ["counter", "culture", "coffee"], search_text_norm: "counter culture coffee beans roasters" }),
  c({ id: "subzero", company_name: "Sub-Zero", normalized_domain: "subzero.com", industries: ["Appliances"], keywords: ["refrigerator", "freezer", "wine cooler"], search_tokens: ["sub", "zero", "refrigerator"], search_text_norm: "sub zero refrigerator freezer wine cooler appliances" }),
  c({ id: "gehaus", company_name: "GE Appliances", normalized_domain: "geappliances.com", industries: ["Appliances"], keywords: ["refrigerator", "dishwasher", "oven"], search_tokens: ["ge", "appliances", "refrigerator"], search_text_norm: "ge appliances refrigerator dishwasher oven" }),
  c({ id: "hydroflask", company_name: "Hydro Flask", normalized_domain: "hydroflask.com", industries: ["Drinkware"], keywords: ["water bottle", "insulated", "tumbler"], search_tokens: ["hydro", "flask"], search_text_norm: "hydro flask water bottle insulated tumbler drinkware" }),
  c({ id: "acmesub_a", company_name: "Acme Outdoor", normalized_domain: "acme.com", industries: ["Outdoor"], keywords: ["tents", "outdoor gear"], search_tokens: ["acme", "outdoor"], search_text_norm: "acme outdoor tents gear", review_count: 10 }),
  c({ id: "acmesub_b", company_name: "Acme Coffee", normalized_domain: "acme.com", industries: ["Coffee"], keywords: ["coffee", "beans"], search_tokens: ["acme", "coffee"], search_text_norm: "acme coffee beans", review_count: 3 }),
  c({ id: "northface", company_name: "The North Face", normalized_domain: "thenorthface.com", industries: ["Apparel", "Outdoor"], keywords: ["jackets", "backpacks", "outdoor gear"], search_tokens: ["north", "face"], search_text_norm: "north face jackets backpacks outdoor gear apparel" }),
  c({ id: "widget", company_name: "Widget Industries", normalized_domain: "widget.com", industries: ["Manufacturing"], keywords: ["widgets", "gears", "bolts"], search_tokens: ["widget"], search_text_norm: "widget industries widgets gears bolts manufacturing" }),
  c({ id: "lavazza", company_name: "Lavazza", normalized_domain: "lavazza.com", industries: ["Coffee"], keywords: ["coffee", "espresso"], search_tokens: ["lavazza", "coffee"], search_text_norm: "lavazza coffee espresso" }),
  c({ id: "whirlpool", company_name: "Whirlpool", normalized_domain: "whirlpool.com", industries: ["Appliances"], keywords: ["refrigerator", "washer", "dryer"], search_tokens: ["whirlpool", "refrigerator"], search_text_norm: "whirlpool refrigerator washer dryer appliances" }),
  c({ id: "randomco", company_name: "Random Trading Co", normalized_domain: "random.com", industries: ["Wholesale"], keywords: ["imports", "misc"], search_tokens: ["random"], search_text_norm: "random trading imports misc wholesale" }),
];

// Responder: mimic Cosmos matching by returning corpus docs whose searchable
// blob contains any of the query's string parameter values. Deterministic and
// pass-shape-sensitive, so #4 union changes surface. Numeric/limit params are
// ignored. Honors the manufacturing has/no split expressions if present.
function blob(doc) {
  return [
    doc.company_name,
    (doc.search_tokens || []).join(" "),
    (doc.keywords || []).join(" "),
    (doc.industries || []).join(" "),
    doc.search_text_norm || "",
    doc.normalized_domain || "",
  ]
    .join(" ")
    .toLowerCase();
}
function makeCorpusContainer() {
  return {
    items: {
      query: (spec) => ({
        fetchAll: async () => {
          const q = String(spec?.query || "");
          const vals = (spec?.parameters || [])
            .map((p) => p && p.value)
            .filter((v) => typeof v === "string" && v.trim().length >= 2)
            .map((v) => v.toLowerCase());
          let rows = CORPUS;
          if (q.includes("ARRAY_LENGTH(c.manufacturing_locations) > 0")) {
            rows = rows.filter((d) => (d.manufacturing_locations || []).length > 0);
          } else if (q.includes("ARRAY_LENGTH(c.manufacturing_locations) = 0")) {
            rows = rows.filter((d) => (d.manufacturing_locations || []).length === 0);
          }
          if (vals.length === 0) return { resources: rows };
          return { resources: rows.filter((d) => vals.some((v) => blob(d).includes(v))) };
        },
      }),
    },
    item: () => ({ read: async () => ({ resource: null }) }),
  };
}

function makeReq(url) {
  return { method: "GET", url, headers: new Headers() };
}

const QUERIES = [
  "patagonia",
  "coffee",
  "coffee roasters",
  "yeti",
  "refrigerator",
  "blue bottle",
  "death wish coffee",
  "outdoor gear",
  "water bottle",
  "widget",
];

async function runQuery(raw) {
  const norm = raw.toLowerCase().trim();
  const compact = norm.replace(/\s+/g, "");
  const url = `https://x/api/search-companies?raw=${encodeURIComponent(raw)}&norm=${encodeURIComponent(norm)}&compact=${encodeURIComponent(compact)}&sort=manu&take=25`;
  const res = await _test.searchCompaniesHandler(makeReq(url), { log() {} }, { companiesContainer: makeCorpusContainer() });
  const body = JSON.parse(res.body);
  return (body.items || []).map((it) => `${it.id}:${it._relevanceScore}`);
}

// EXPECTED — regenerate with SNAPSHOT_UPDATE=1 after an intentional change.
const EXPECTED = {
  patagonia: ["patagonia:90", "yeti:20", "acmesub_a:20", "northface:20"],
  coffee: ["deathwish:131", "bluebottle:127", "stumptown:127", "counterculture:127", "acmesub_b:127", "lavazza:99"],
  "coffee roasters": ["stumptown:144", "counterculture:92", "bluebottle:52", "deathwish:52", "acmesub_b:52", "lavazza:52"],
  yeti: ["yeti:20", "patagonia:20", "hydroflask:20", "acmesub_a:20", "northface:20"],
  refrigerator: ["subzero:60", "gehaus:60", "whirlpool:60"],
  "blue bottle": ["bluebottle:83", "hydroflask:20", "stumptown:20", "deathwish:20", "counterculture:20", "acmesub_b:20", "lavazza:20"],
  "death wish coffee": ["bluebottle:39", "stumptown:20", "deathwish:20", "counterculture:20", "acmesub_b:20", "lavazza:20"],
  "outdoor gear": ["patagonia:20", "yeti:20", "acmesub_a:20", "northface:20"],
  "water bottle": ["hydroflask:20"],
  widget: ["widget:94"],
};

// Static guard for the slim projection (#1): SLIM_SELECT_FIELDS MUST contain
// every raw field the scoring / sort / filter / dedup / Pass-4 / meta paths read.
// The golden snapshot above can't catch a projection drop (the test container
// ignores SELECT), so this asserts the field set directly. If you add a field
// that ranking reads, add it here AND to SLIM_SELECT_FIELDS.
test("slim projection keeps every ranking-relevant field", () => {
  const slim = _test.SLIM_SELECT_FIELDS;
  const REQUIRED = [
    "c.id", "c.company_id", "c.company_name", "c.display_name", "c.name",
    "c.industries", "c.product_keywords", "c.keywords",
    "c.amazon_url", "c.normalized_domain",
    "c.manufacturing_locations", "c.manufacturing_geocodes",
    "c.headquarters", "c.headquarters_locations", "c.headquarters_location",
    "c.tagline",
    "c.rating", "c.avg_rating", "c.star_rating", "c.star_score", "c.confidence_score",
    "c.review_count", "c.review_count_approved", "c.profile_completeness",
    "c._ts", "c.created_at", "c.updated_at",
    "c.website_url",
  ];
  const missing = REQUIRED.filter((f) => !slim.split(/,\s*/).includes(f));
  assert.deepEqual(missing, [], `slim projection is missing ranking fields: ${missing.join(", ")}`);
});

test("lazy-hydrate enriches page display fields from full docs, preserves scores", async () => {
  resetTypoCorrectionCache();
  resetIndustryAffinityCache();
  // Query returns the SLIM shape (no logo_url); the point-read returns the FULL
  // doc. The response row must carry the hydrated display field AND the score.
  const slimDoc = { id: "acme", company_id: "acme", company_name: "Acme Coffee", normalized_domain: "acme.com", industries: ["Coffee"], keywords: ["coffee"], search_tokens: ["acme", "coffee"], search_text_norm: "acme coffee", _ts: 1700000000 };
  const fullDoc = { ...slimDoc, logo_url: "https://cdn.example/acme.png", review_count: 42 };
  const container = {
    items: { query: () => ({ fetchAll: async () => ({ resources: [slimDoc] }) }) },
    item: (id) => ({ read: async () => ({ resource: id === "acme" ? fullDoc : null }) }),
  };
  const res = await _test.searchCompaniesHandler(
    makeReq("https://x/api/search-companies?raw=coffee&norm=coffee&compact=coffee&take=25"),
    { log() {} },
    { companiesContainer: container }
  );
  const body = JSON.parse(res.body);
  const row = (body.items || []).find((it) => it.id === "acme");
  assert.ok(row, "acme present in results");
  assert.ok(typeof row._relevanceScore === "number" && row._relevanceScore > 0, "computed score preserved through hydration");
  assert.equal(row.logo_url, "https://cdn.example/acme.png", "display field hydrated from the full doc");
});

test("golden ranking snapshot is stable across the perf refactors", async () => {
  resetTypoCorrectionCache();
  resetIndustryAffinityCache();
  const actual = {};
  for (const query of QUERIES) {
    actual[query] = await runQuery(query);
  }
  if (process.env.SNAPSHOT_UPDATE) {
    // eslint-disable-next-line no-console
    console.log("SNAPSHOT=" + JSON.stringify(actual, null, 2));
    return;
  }
  assert.deepEqual(actual, EXPECTED);
});
