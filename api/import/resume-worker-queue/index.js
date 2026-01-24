// Import app from the centralized app setup (api/_app.js) which handles fallbacks
const { app } = require("../_app");

const { resumeWorkerQueueHandler } = require("./handler");

const queueName = String(process.env.ENRICHMENT_QUEUE_NAME || "import-resume-worker").trim();
// For Azure Functions bindings, this is the *setting name* that holds the connection string.
const connection = String(process.env.ENRICHMENT_QUEUE_CONNECTION_SETTING || "AzureWebJobsStorage").trim();

if (app && typeof app.storageQueue === "function") {
  app.storageQueue("import-resume-worker-queue", {
    queueName,
    connection,
    handler: resumeWorkerQueueHandler,
  });
}

module.exports = {};
