const { app } = require("@azure/functions");
const { resumeWorkerHandler } = require("./handler");

/**
 * Dedicated worker for import resume queue processing.
 * This function runs in tabarnam-xai-dedicated Function App only.
 */

/**
 * Storage Queue trigger for import resume worker.
 * Runs in the dedicated tabarnam-xai-dedicated Function App.
 *
 * Converts queue message to HTTP-like request and delegates to the same handler
 * that powers the HTTP endpoint in the SWA-managed API.
 *
 * NOTE: Connection setting name MUST match what enqueue() resolves in api/_enrichmentQueue.js.
 * enqueue uses: ENRICHMENT_QUEUE_CONNECTION_STRING > AzureWebJobsStorage > AZURE_STORAGE_CONNECTION_STRING
 * So trigger uses ENRICHMENT_QUEUE_CONNECTION_SETTING (default: AzureWebJobsStorage)
 */
const triggerConnectionSetting =
  String(process.env.ENRICHMENT_QUEUE_CONNECTION_SETTING || "").trim() || "AzureWebJobsStorage";

app.storageQueue("import-resume-worker-queue-trigger", {
  queueName: "import-resume-worker",
  connection: triggerConnectionSetting,
  handler: async (message, context) => {
    // Convert queue message to HTTP-like request structure
    const queueBody = typeof message === "string" ? JSON.parse(message) : message;

    // Mock HTTP request object that the handler expects
    const fakeReq = {
      method: "POST",
      url: new URL("https://localhost/api/import/resume-worker"),
      headers: {
        get: (name) => {
          if (name.toLowerCase() === "x-request-id") {
            return String(queueBody?.run_id || context?.invocationId || "");
          }
          return null;
        },
      },
      json: async () => queueBody,
      text: async () => JSON.stringify(queueBody),
      __in_process: true, // Trust queue trigger as internal
    };

    // Call the same handler with the queue message
    return await resumeWorkerHandler(fakeReq, context);
  },
});

module.exports = {
  resumeWorkerHandler,
};
