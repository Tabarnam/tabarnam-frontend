/**
 * VERIFICATION RUNBOOK FOR QUEUE MISMATCH FIX
 *
 * After setting AzureWebJobsStorage in Azure App Settings:
 *
 * A) Verify diagnostic shows no mismatch:
 *    - GET /api/diag/queue-mismatch
 *    - Confirm "detected" is false
 *    - Confirm both "enqueue_side" and "trigger_side" show same storage account (e.g., tabarnamstor2356)
 *
 * B) Start fresh import to test queue flow:
 *    - Initiate a new import session (new session_id)
 *
 * C) Verify worker is processing (within 120 seconds):
 *    - GET /api/import/status?session_id=<new_session_id>
 *    - Confirm "resume_worker.handler_entered_at" is non-null (was null before fix)
 *    - Confirm "last_finished_at" is non-null
 *    - Confirm "stage_beacon" has advanced OFF "enrichment_resume_queued"
 *
 * If step (A) passes but worker still doesn't fire:
 *    - Check Azure Functions "Monitor" tab for the queue-trigger function
 *    - Check Application Insights / log stream for queue trigger exceptions
 *    - Verify queue "import-resume-worker" shows dequeue activity (dequeueCount increases)
 *      in the storage account (Azure Portal > Storage account > Queues)
 */

let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}
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

async function diagQueueMismatchHandler(req, context) {
    if (req.method === "OPTIONS") {
      return {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
        },
      };
    }

    const queueTriggerMode = String(process.env.QUEUE_TRIGGER_MODE || "").trim().toLowerCase();
    const isExternalMode = queueTriggerMode === "external";
    const workerBaseUrl = String(process.env.WORKER_BASE_URL || "").trim();

    const queueConfig = resolveQueueConfig();
    const triggers = listTriggers();
    const queueTrigger = triggers.find(
      (t) => t.type === "storageQueue" && t.queueName === queueConfig.queueName
    );

    // What the enqueue side uses
    const enqueueConnSource = queueConfig.connection_source;
    const enqueueConnStr = queueConfig.connectionString;
    const enqueueAccount = extractAccountSuffix(enqueueConnStr);

    // In external mode, don't check SWA trigger binding (it doesn't exist)
    if (isExternalMode) {
      const workerConfigured = Boolean(workerBaseUrl);
      let workerHealthStatus = null;
      let workerHealthOk = false;

      // Attempt to check worker health if configured
      if (workerConfigured) {
        try {
          const healthUrl = `${workerBaseUrl}/api/health`;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          const healthResp = await fetch(healthUrl, {
            method: "GET",
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          if (healthResp.ok) {
            const healthData = await healthResp.json().catch(() => ({}));
            workerHealthStatus = "reachable";
            workerHealthOk = healthData?.ok === true;
          } else {
            workerHealthStatus = "unhealthy";
          }
        } catch (e) {
          workerHealthStatus = "unreachable";
        }
      }

      const riskLevel =
        !workerConfigured || !enqueueAccount
          ? "CRITICAL"
          : workerHealthStatus === "unreachable"
            ? "HIGH"
            : "LOW";

      return json({
        ok: true,
        timestamp: new Date().toISOString(),
        mode: "external_worker",
        issue: {
          title: "Queue Trigger Configuration (External Worker Mode)",
          description:
            "Trigger runs in dedicated external worker. SWA-managed Functions are HTTP-only.",
          detected: false,
          risk: riskLevel,
          explanation: workerConfigured
            ? `Queue trigger executes in dedicated worker app (tabarnam-xai-dedicated). Messages enqueued to '${enqueueAccount}' (via ${enqueueConnSource}). Worker health: ${workerHealthStatus || "unknown"}.`
            : `Queue trigger configured to run externally, but WORKER_BASE_URL is not set.`,
        },
        enqueue_side: {
          resolved_connection_source: enqueueConnSource,
          resolved_storage_account: enqueueAccount || "NOT RESOLVED",
          queue_name: queueConfig.queueName,
          connection_configured: Boolean(enqueueConnStr),
          env_vars_checked: {
            ENRICHMENT_QUEUE_CONNECTION_STRING: getStorageAccountFromEnvVar("ENRICHMENT_QUEUE_CONNECTION_STRING"),
            AzureWebJobsStorage: getStorageAccountFromEnvVar("AzureWebJobsStorage"),
            AZURE_STORAGE_CONNECTION_STRING: getStorageAccountFromEnvVar("AZURE_STORAGE_CONNECTION_STRING"),
          },
        },
        worker_side: {
          mode: "external",
          worker_base_url: workerBaseUrl || null,
          worker_configured: workerConfigured,
          worker_health_status: workerHealthStatus,
          worker_health_ok: workerHealthOk,
          queue_name: queueConfig.queueName,
          trigger_expected_in_swa: false,
          trigger_registered_in_swa: !!queueTrigger,
        },
        fix:
          riskLevel === "CRITICAL"
            ? !workerConfigured
              ? [
                  `QUEUE_TRIGGER_MODE=external requires WORKER_BASE_URL to be configured.`,
                  `Set WORKER_BASE_URL to the base URL of tabarnam-xai-dedicated (e.g., https://tabarnam-xai-dedicated.azurewebsites.net).`,
                  `If you have not configured external worker mode, see documentation on setting QUEUE_TRIGGER_MODE.`,
                ]
              : !enqueueAccount
                ? [
                    `Enqueue storage account could not be resolved. Check ENRICHMENT_QUEUE_CONNECTION_STRING or AzureWebJobsStorage.`,
                    `Ensure the connection string is properly set in SWA app settings.`,
                  ]
                : []
            : riskLevel === "HIGH"
              ? [
                  `Worker health check failed. Verify ${workerBaseUrl}/api/health is accessible.`,
                  `Check that the dedicated worker Function App (tabarnam-xai-dedicated) is running and configured.`,
                  `Review worker deployment logs if health endpoint is not responding.`,
                ]
              : ["External worker mode is properly configured. Queue processing is delegated to dedicated worker."],
      });
    }

    // Original SWA-managed trigger mode (default)
    // What the trigger side uses (hardcoded to AzureWebJobsStorage)
    const triggerConnSettingName = "AzureWebJobsStorage"; // hardcoded in import/resume-worker/index.js
    const triggerConnStr = process.env.AzureWebJobsStorage || null;
    const triggerAccount = extractAccountSuffix(triggerConnStr);

    const mismatch = enqueueAccount !== triggerAccount;

    return json({
      ok: true,
      timestamp: new Date().toISOString(),
      mode: "swa_managed",
      issue: {
        title: "Queue Enqueue vs Trigger Account Mismatch",
        description:
          "Messages are enqueued to one storage account but the trigger listens to another",
        detected: mismatch,
        risk: mismatch ? "CRITICAL" : "OK",
        explanation: mismatch
          ? `Enqueue resolves to '${enqueueAccount}' (via ${enqueueConnSource}). Trigger is hardcoded to 'AzureWebJobsStorage' which resolves to '${triggerAccount || "NOT SET (null)"}'. Messages will accumulate in wrong queue and trigger will never fire.`
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
            `Option C: Migrate to external worker mode by setting QUEUE_TRIGGER_MODE=external and configuring WORKER_BASE_URL.`,
            `Current state: Enqueue side uses '${enqueueConnSource}' pointing to account '${enqueueAccount}'. Trigger is hardcoded to 'AzureWebJobsStorage' pointing to account '${triggerAccount}' (null if not set).`,
          ]
        : ["System is properly configured. Both sides use same storage account."],
    });
}

app.http("diagQueueMismatch", {
  route: "diag/queue-mismatch",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: diagQueueMismatchHandler,
});

module.exports = { handler: diagQueueMismatchHandler };
