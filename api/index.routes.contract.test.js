const test = require("node:test");
const assert = require("node:assert/strict");

test("api/index.js registers refresh-company routes", () => {
  process.env.TABARNAM_API_INDEX_MODE = "routes-test";
  const app = require("./index.js");
  const routes = app?._test?.listRoutes?.() || [];

  assert.ok(Array.isArray(routes), "expected listRoutes() to return an array");
  assert.ok(routes.includes("admin-refresh-company"), "missing route: admin-refresh-company");
  assert.ok(routes.includes("xadmin-api-refresh-company"), "missing route: xadmin-api-refresh-company");
});
