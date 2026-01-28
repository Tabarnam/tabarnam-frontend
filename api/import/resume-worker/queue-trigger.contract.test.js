const { test } = require("node:test");
const assert = require("node:assert/strict");

test("import/resume-worker queue trigger moved to dedicated worker", () => {
  // Queue trigger has been moved to worker/functions/import-resume-worker/ (tabarnam-xai-dedicated Function App).
  // SWA-managed API only registers HTTP endpoints. This test documents that the queue trigger is NOT expected here.

  // Reload the module cache to ensure fresh registration
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
  // Reload the module cache to ensure fresh registration
  delete require.cache[require.resolve("../../index.js")];
  delete require.cache[require.resolve("../../_app.js")];
  
  const app = require("../../index.js");
  const routes = app?._test?.listRoutes?.() || [];

  assert.ok(Array.isArray(routes), "expected listRoutes() to return an array");
  assert.ok(routes.includes("import/resume-worker"), "missing route: import/resume-worker");
});
