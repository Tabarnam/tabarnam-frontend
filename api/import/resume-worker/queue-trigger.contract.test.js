const { test } = require("node:test");
const assert = require("node:assert/strict");

test("import/resume-worker registers storage queue trigger", () => {
  // Reload the module cache to ensure fresh registration
  delete require.cache[require.resolve("../../index.js")];
  delete require.cache[require.resolve("../../_app.js")];
  
  const app = require("../../index.js");
  const triggers = app?._test?.listTriggers?.() || [];

  assert.ok(Array.isArray(triggers), "expected listTriggers() to return an array");
  
  const queueTrigger = triggers.find((t) => t.name === "import-resume-worker-queue-trigger");
  assert.ok(queueTrigger, "missing queue trigger: import-resume-worker-queue-trigger");
  assert.strictEqual(queueTrigger.type, "storageQueue", "queue trigger should have type 'storageQueue'");
  assert.strictEqual(queueTrigger.queueName, "import-resume-worker", "queue trigger should target 'import-resume-worker' queue");
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
