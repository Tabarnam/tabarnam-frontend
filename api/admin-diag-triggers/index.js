const { app } = require("@azure/functions");
const { resolveQueueConfig } = require("../_enrichmentQueue");
const { listTriggers } = require("../_app");

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
    },
    body: JSON.stringify(obj),
  };
}

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

app.http("adminDiagTriggers", {
  route: "admin/diag/triggers",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") {
      return {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "content-type",
        },
      };
    }

    try {
      const queueConfig = resolveQueueConfig();
      const triggers = listTriggers();

      const response = {
        ok: true,
        timestamp: new Date().toISOString(),
        triggers: {
          list: triggers,
          summary: {
            total: triggers.length,
            by_type: triggers.reduce((acc, t) => {
              acc[t.type] = (acc[t.type] || 0) + 1;
              return acc;
            }, {}),
          },
        },
        queue_configuration: {
          provider: queueConfig.provider,
          queue_name: queueConfig.queueName,
          connection_source: queueConfig.connection_source,
          connection_status: queueConfig.connectionString ? "configured" : "missing",
          binding_connection_setting_name: queueConfig.binding_connection_setting_name,
          environment_variables: {
            ENRICHMENT_QUEUE_CONNECTION_STRING: asString(process.env.ENRICHMENT_QUEUE_CONNECTION_STRING).trim() ? "SET" : "NOT SET",
            ENRICHMENT_QUEUE_NAME: asString(process.env.ENRICHMENT_QUEUE_NAME).trim() || "(default: import-resume-worker)",
            ENRICHMENT_QUEUE_CONNECTION_SETTING: asString(process.env.ENRICHMENT_QUEUE_CONNECTION_SETTING).trim() || "(default: AzureWebJobsStorage)",
            AzureWebJobsStorage: asString(process.env.AzureWebJobsStorage).trim() ? "SET" : "NOT SET",
            AZURE_STORAGE_CONNECTION_STRING: asString(process.env.AZURE_STORAGE_CONNECTION_STRING).trim() ? "SET" : "NOT SET",
          },
        },
        diagnostics: {
          has_queue_trigger: triggers.some((t) => t.type === "storageQueue" && t.queueName === queueConfig.queueName),
          queue_trigger_details: triggers.find((t) => t.type === "storageQueue" && t.queueName === queueConfig.queueName) || {
            name: "import-resume-worker-queue-trigger",
            type: "storageQueue",
            queueName: "import-resume-worker",
            status: "not_found",
          },
          connection_ready: Boolean(queueConfig.connectionString),
          recommendation: (() => {
            if (!queueConfig.connectionString) {
              return "⚠️ Queue connection not configured. Set ENRICHMENT_QUEUE_CONNECTION_STRING or AzureWebJobsStorage.";
            }
            if (!triggers.some((t) => t.type === "storageQueue" && t.queueName === queueConfig.queueName)) {
              return "⚠️ Queue trigger not found in registered triggers. Check if api/import/resume-worker/index.js is loaded.";
            }
            return "✅ Queue trigger is configured and registered.";
          })(),
        },
      };

      return json(response, 200);
    } catch (error) {
      return json(
        {
          ok: false,
          error: error.message || "Diagnostic check failed",
          timestamp: new Date().toISOString(),
        },
        500
      );
    }
  },
});
