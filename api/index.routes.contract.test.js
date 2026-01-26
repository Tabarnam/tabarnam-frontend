import test from "node:test";
import assert from "node:assert/strict";

test("api/index.js registers refresh-company routes", async () => {
  process.env.TABARNAM_API_INDEX_MODE = "routes-test";
  // Import AFTER setting the environment variable
  const app = await import("./index.js");
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
