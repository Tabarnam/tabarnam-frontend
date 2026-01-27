let app;
try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {}, storageQueue() {} };
}

const { resumeWorkerHandler } = require("./handler");

// HTTP endpoint for manual triggers or testing
app.http("import-resume-worker", {
  route: "import/resume-worker",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: resumeWorkerHandler,
});

// Storage Queue trigger for production queue-driven execution
// Converts queue message to HTTP-like request and delegates to the same handler
// NOTE: Connection setting name MUST match what enqueue() resolves.
// enqueue uses: ENRICHMENT_QUEUE_CONNECTION_STRING > AzureWebJobsStorage > AZURE_STORAGE_CONNECTION_STRING
// So trigger uses ENRICHMENT_QUEUE_CONNECTION_SETTING (default: AzureWebJobsStorage)
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
      __in_process: true, // Trust internal queue trigger
    };

    // Call the same handler with the queue message
    return await resumeWorkerHandler(fakeReq, context);
  },
});

module.exports = {
  resumeWorkerHandler,
};
