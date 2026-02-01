const { test } = require("node:test");
const assert = require("node:assert/strict");

test("import/resume-worker queue trigger moved to dedicated worker", () => {
  // Queue trigger has been moved to worker/functions/import-resume-worker/ (tabarnam-xai-dedicated Function App).
  // SWA-managed API only registers HTTP endpoints. This test documents that the queue trigger is NOT expected here.

  // Ensure we're not in routes-test mode (may be set by other tests)
  delete process.env.TABARNAM_API_INDEX_MODE;

  // Reload the module cache to ensure fresh registration
  // Must also clear individual endpoint modules since they register routes on load
  delete require.cache[require.resolve("./index.js")];
  delete require.cache[require.resolve("../../index.js")];
  delete require.cache[require.resolve("../../_app.js")];

  const app = require("../../index.js");
  const triggers = app?._test?.listTriggers?.() || [];

  assert.ok(Array.isArray(triggers), "expected listTriggers() to return an array");

  // Queue trigger should NOT be registered in SWA
  const queueTrigger = triggers.find((t) => t.name === "import-resume-worker-queue-trigger");
  assert.strictEqual(queueTrigger, undefined, "queue trigger should NOT be in SWA API (runs in dedicated worker instead)");
});

test("import/resume-worker registers HTTP endpoint", () => {
  // This test verifies that the HTTP endpoint was registered when api/index.js was loaded.
  // The previous test already cleared and re-loaded the modules, so routes should already be registered.
  // We do NOT clear cache here because that would reset _app's registration arrays while
  // leaving endpoint modules cached (so they wouldn't re-register).

  const { listRoutes } = require("../../_app.js");
  const routes = typeof listRoutes === "function" ? listRoutes() : [];

  assert.ok(Array.isArray(routes), "expected listRoutes() to return an array");
  assert.ok(routes.includes("import/resume-worker"), "missing route: import/resume-worker");
});
