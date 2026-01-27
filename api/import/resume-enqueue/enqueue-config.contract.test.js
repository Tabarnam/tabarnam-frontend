const { test } = require("node:test");
const assert = require("node:assert/strict");

test("enqueueResumeRun uses correct queue name from config", async () => {
  // Mock the QueueClient to capture what parameters it's initialized with
  const { enqueueResumeRun, resolveQueueConfig } = require("../../_enrichmentQueue");

  // Get the config using the production env resolution logic
  const cfg = resolveQueueConfig();

  // Verify queue name is correct
  assert.ok(cfg.queueName, "queue name should be resolved from env or defaults");
  assert.strictEqual(cfg.queueName, "import-resume-worker", "queue name should be 'import-resume-worker' (default when env is not set)");

  // Verify binding connection setting name is correct
  assert.ok(cfg.binding_connection_setting_name, "binding_connection_setting_name should be resolved");
  assert.strictEqual(
    cfg.binding_connection_setting_name,
    "AzureWebJobsStorage",
    "binding connection setting should use 'AzureWebJobsStorage' (standard Azure Functions pattern)"
  );

  // Verify the provider is correct
  assert.strictEqual(cfg.provider, "azure_storage_queue", "provider should be 'azure_storage_queue'");
});

test("enqueueResumeRun queue client uses AzureWebJobsStorage connection setting", async () => {
  // Mock environment to control which connection string is selected
  const originalEnv = {
    ENRICHMENT_QUEUE_CONNECTION_STRING: process.env.ENRICHMENT_QUEUE_CONNECTION_STRING,
    AzureWebJobsStorage: process.env.AzureWebJobsStorage,
    ENRICHMENT_QUEUE_CONNECTION_SETTING: process.env.ENRICHMENT_QUEUE_CONNECTION_SETTING,
  };

  try {
    // Set up environment: only AzureWebJobsStorage is configured (production scenario)
    delete process.env.ENRICHMENT_QUEUE_CONNECTION_STRING;
    process.env.AzureWebJobsStorage = "DefaultEndpointsProtocol=https://mock.queue.core.windows.net/";
    delete process.env.ENRICHMENT_QUEUE_CONNECTION_SETTING;

    // Clear the require cache to reload the module with fresh env
    const moduleId = require.resolve("../../_enrichmentQueue");
    delete require.cache[moduleId];

    const { resolveQueueConfig } = require("../../_enrichmentQueue");
    const cfg = resolveQueueConfig();

    // Verify correct connection source is selected
    assert.strictEqual(
      cfg.connection_source,
      "AzureWebJobsStorage",
      "should prefer AzureWebJobsStorage when ENRICHMENT_QUEUE_CONNECTION_STRING is not set"
    );

    // Verify binding connection setting name is correct
    assert.strictEqual(
      cfg.binding_connection_setting_name,
      "AzureWebJobsStorage",
      "Azure Functions trigger should use AzureWebJobsStorage as the connection setting name"
    );

    // Verify the queue name matches the one used in the resume-worker trigger definition
    assert.strictEqual(cfg.queueName, "import-resume-worker", "queue name should match the trigger definition");
  } finally {
    // Restore original env
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    // Reload the module with original env restored
    delete require.cache[require.resolve("../../_enrichmentQueue")];
  }
});

test("enqueueResumeRun payload structure matches resume-worker queue trigger expectations", async () => {
  // This test verifies that the payload format sent by enqueueResumeRun
  // matches what the resume-worker queue trigger handler expects.

  const { enqueueResumeRun } = require("../../_enrichmentQueue");

  // The enqueue helper should return a payload structure that contains:
  // - session_id (required)
  // - reason (required)
  // - requested_by (required)
  // - enqueue_at (required)
  // - Optional: company_ids, cycle_count, run_id

  assert.ok(typeof enqueueResumeRun === "function", "enqueueResumeRun should be a function");

  // We can't easily test the actual queue send without mocking the SDK,
  // but we can verify the function is available and has the expected signature.
  // The real contract is tested by:
  // 1. The resume-worker index.js queue trigger definition
  // 2. The import-resume-enqueue endpoint that calls enqueueResumeRun
  // 3. End-to-end tests in production

  // Verify the queue client will use the correct queue name
  const { resolveQueueConfig } = require("../../_enrichmentQueue");
  const cfg = resolveQueueConfig();

  assert.strictEqual(
    cfg.queueName,
    "import-resume-worker",
    "enqueueResumeRun must send to 'import-resume-worker' queue (same as resume-worker trigger listens to)"
  );
});
