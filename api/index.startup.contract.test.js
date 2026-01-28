const { test } = require("node:test");
const assert = require("node:assert/strict");

test("[CI] Startup imports resume-worker and registers queue trigger", () => {
  // Reload module cache to ensure fresh registration
  delete require.cache[require.resolve("./index.js")];
  delete require.cache[require.resolve("./_app.js")];
  delete require.cache[require.resolve("./import/resume-worker/index.js")];

  // Import the production startup file (same as Azure Functions runtime would)
  const app = require("./index.js");

  // Verify the app module is exported with test helpers
  assert.ok(app, "index.js should export the app module");
  assert.ok(app._test, "app._test should exist for introspection");
  assert.ok(typeof app._test.listTriggers === "function", "app._test.listTriggers should be available");

  // List all registered triggers
  const triggers = app._test.listTriggers?.() || [];
  assert.ok(Array.isArray(triggers), "listTriggers() should return an array");

  // Verify the queue trigger is registered
  const queueTrigger = triggers.find((t) => t.name === "import-resume-worker-queue-trigger");
  assert.ok(queueTrigger, "queue trigger 'import-resume-worker-queue-trigger' must be registered at startup");
  assert.strictEqual(queueTrigger.type, "storageQueue", "trigger type should be 'storageQueue'");
  assert.strictEqual(queueTrigger.queueName, "import-resume-worker", "queue trigger should target 'import-resume-worker' queue");

  // Verify HTTP endpoint is also present (backward compatibility)
  assert.ok(typeof app._test.listRoutes === "function", "app._test.listRoutes should be available");
  const routes = app._test.listRoutes?.() || [];
  assert.ok(Array.isArray(routes), "listRoutes() should return an array");
  assert.ok(routes.includes("import/resume-worker"), "HTTP route 'import/resume-worker' should also be registered");
});
