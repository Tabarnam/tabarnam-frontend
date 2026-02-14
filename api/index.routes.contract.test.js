const { test } = require("node:test");
const assert = require("node:assert/strict");

test("api/index.js registers refresh-company routes (routes-test mode)", () => {
  process.env.TABARNAM_API_INDEX_MODE = "routes-test";
  // Clear and reload the module cache to ensure ROUTES_TEST_MODE takes effect
  delete require.cache[require.resolve("./index.js")];
  const app = require("./index.js");
  const routes = app?._test?.listRoutes?.() || [];

  assert.ok(Array.isArray(routes), "expected listRoutes() to return an array");
  assert.ok(routes.includes("admin-refresh-company"), "missing route: admin-refresh-company");
  assert.ok(routes.includes("xadmin-api-refresh-company"), "missing route: xadmin-api-refresh-company");
  assert.ok(routes.includes("admin-refresh-reviews"), "missing route: admin-refresh-reviews");
  assert.ok(routes.includes("xadmin-api-refresh-reviews"), "missing route: xadmin-api-refresh-reviews");
  assert.ok(routes.includes("admin/companies/{company_id}/history"), "missing route: admin/companies/{company_id}/history");
  assert.ok(routes.includes("admin-company-history"), "missing route: admin-company-history");
  assert.ok(routes.includes("company-logo"), "missing route: company-logo");
  assert.ok(routes.includes("import-one"), "missing route: import-one");
});

test("api/index.js registers all core business routes (full mode)", () => {
  delete process.env.TABARNAM_API_INDEX_MODE;
  // Clear module cache for fresh load
  for (const key of Object.keys(require.cache)) {
    if (key.includes("api")) delete require.cache[key];
  }
  const app = require("./index.js");
  const routes = app?._test?.listRoutes?.() || [];

  assert.ok(Array.isArray(routes), "expected listRoutes() to return an array");
  assert.ok(routes.length >= 50, `expected at least 50 routes, got ${routes.length}`);

  // Core user-facing routes
  const coreRoutes = [
    "health",
    "ping",
    "version",
    "search-companies",
    "get-reviews",
    "save-companies",
    "companies-list",
    "import-start",
    "import-status",
    "import-one",
    "logo-scrape",
    "review-scrape",
    "keywords-list",
  ];

  for (const route of coreRoutes) {
    assert.ok(routes.includes(route), `missing core route: ${route}`);
  }
});
