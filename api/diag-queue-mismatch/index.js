const { app } = require("@azure/functions");
const { resolveQueueConfig } = require("../_enrichmentQueue");
const { listTriggers } = require("../_app");

function extractAccountSuffix(connectionString) {
  if (!connectionString) return null;
  // DefaultEndpointsProtocol=https://DefaultEndpointsProtocol=https://;AccountName=myaccount;AccountKey=...;EndpointSuffix=core.windows.net
  // OR BlobEndpoint=https://myaccount.blob.core.windows.net/;...
  try {
    if (connectionString.includes("AccountName=")) {
      const match = connectionString.match(/AccountName=([^;]+)/);
      if (match) return match[1];
    }
    if (connectionString.includes(".blob.core.windows.net")) {
      const match = connectionString.match(/\/\/([^.]+)\.blob\.core\.windows\.net/);
      if (match) return match[1];
    }
  } catch {}
  return "unknown";
}

function getStorageAccountFromEnvVar(envVarName) {
  const connStr = String(process.env[envVarName] || "").trim();
  if (!connStr) return null;
  return {
    set: true,
    account_suffix: extractAccountSuffix(connStr),
  };
}

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(obj),
  };
}

app.http("diagQueueMismatch", {
  route: "diag/queue-mismatch",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") {
      return {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
        },
      };
    }

    const queueConfig = resolveQueueConfig();
    const triggers = listTriggers();
    const queueTrigger = triggers.find(
      (t) => t.type === "storageQueue" && t.queueName === queueConfig.queueName
    );

    // What the enqueue side uses
    const enqueueConnSource = queueConfig.connection_source;
    const enqueueConnStr = queueConfig.connectionString;
    const enqueueAccount = extractAccountSuffix(enqueueConnStr);

    // What the trigger side uses (hardcoded to AzureWebJobsStorage)
    const triggerConnSettingName = "AzureWebJobsStorage"; // hardcoded in import/resume-worker/index.js
    const triggerConnStr = process.env.AzureWebJobsStorage || null;
    const triggerAccount = extractAccountSuffix(triggerConnStr);

    const mismatch = enqueueAccount !== triggerAccount;

    return json({
      ok: true,
      timestamp: new Date().toISOString(),
      issue: {
        title: "Queue Enqueue vs Trigger Account Mismatch",
        description:
          "Messages are enqueued to one storage account but the trigger listens to another",
        detected: mismatch,
        risk: mismatch ? "CRITICAL" : "OK",
        explanation: mismatch
          ? `Enqueue resolves to '${enqueueAccount}' (via ${enqueueConnSource}). Trigger is hardcoded to 'AzureWebJobsStorage'='${triggerAccount}'. Messages will accumulate in wrong queue.`
          : `Both enqueue and trigger use same account: '${enqueueAccount}'`,
      },
      enqueue_side: {
        resolved_connection_source: enqueueConnSource,
        resolved_storage_account: enqueueAccount,
        queue_name: queueConfig.queueName,
        env_vars_checked: {
          ENRICHMENT_QUEUE_CONNECTION_STRING: getStorageAccountFromEnvVar("ENRICHMENT_QUEUE_CONNECTION_STRING"),
          AzureWebJobsStorage: getStorageAccountFromEnvVar("AzureWebJobsStorage"),
          AZURE_STORAGE_CONNECTION_STRING: getStorageAccountFromEnvVar("AZURE_STORAGE_CONNECTION_STRING"),
        },
      },
      trigger_side: {
        hardcoded_connection_setting: triggerConnSettingName,
        resolved_storage_account: triggerAccount,
        queue_name: queueConfig.queueName,
        trigger_registered: !!queueTrigger,
        trigger_details: queueTrigger || { name: "NOT_FOUND" },
      },
      fix: mismatch
        ? [
            `Option A (recommended, simplest): Set AzureWebJobsStorage to the same connection string as ${enqueueConnSource} (which uses account '${enqueueAccount}'). This requires no code changes.`,
            `Option B: If you prefer to keep using ${enqueueConnSource} for enqueue, set ENRICHMENT_QUEUE_CONNECTION_SETTING="${enqueueConnSource}" and redeploy PR #644 (dynamic trigger connection) so the trigger listens on the same setting.`,
            `Current state: Enqueue side uses '${enqueueConnSource}' pointing to account '${enqueueAccount}'. Trigger is hardcoded to 'AzureWebJobsStorage' pointing to account '${triggerAccount}' (null if not set).`,
          ]
        : ["System is properly configured. Both sides use same storage account."],
    });
  },
});
