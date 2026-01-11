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
