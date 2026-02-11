const { test } = require("node:test");
const assert = require("node:assert/strict");

test("[CI] Startup imports resume-worker and registers HTTP route", () => {
  // Reload module cache to ensure fresh registration
  delete require.cache[require.resolve("./index.js")];
  delete require.cache[require.resolve("./_app.js")];
  delete require.cache[require.resolve("./import/resume-worker/index.js")];

  // Import the production startup file (same as Azure Functions runtime would)
  const app = require("./index.js");

  // Verify the app module is exported with test helpers
  assert.ok(app, "index.js should export the app module");
  assert.ok(app._test, "app._test should exist for introspection");

  // Verify HTTP endpoint is registered
  assert.ok(typeof app._test.listRoutes === "function", "app._test.listRoutes should be available");
  const routes = app._test.listRoutes?.() || [];
  assert.ok(Array.isArray(routes), "listRoutes() should return an array");
  assert.ok(routes.includes("import/resume-worker"), "HTTP route 'import/resume-worker' should be registered");
});

test("[CI] Queue trigger only registers in dedicated worker environment", () => {
  const app = require("./index.js");

  assert.ok(typeof app._test.listTriggers === "function", "app._test.listTriggers should be available");
  const triggers = app._test.listTriggers?.() || [];
  assert.ok(Array.isArray(triggers), "listTriggers() should return an array");

  // In CI/test (no WEBSITE_SITE_NAME), the queue trigger should NOT be registered
  // because resume-worker/index.js only registers it when IS_DEDICATED_WORKER is true.
  const isDedicated = String(process.env.WEBSITE_SITE_NAME || "").toLowerCase().includes("dedicated");
  const queueTrigger = triggers.find((t) => t.name === "import-resume-worker-queue-trigger");

  if (isDedicated) {
    assert.ok(queueTrigger, "queue trigger should be registered in dedicated worker");
    assert.strictEqual(queueTrigger.type, "storageQueue");
    assert.strictEqual(queueTrigger.queueName, "import-resume-worker");
  } else {
    assert.ok(!queueTrigger, "queue trigger should NOT be registered outside dedicated worker");
  }
});
