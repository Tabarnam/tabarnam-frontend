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
