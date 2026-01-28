const { app } = require("../../_app");
const { resumeWorkerHandler } = require("./handler");

// HTTP endpoint for manual triggers or testing
app.http("import-resume-worker", {
  route: "import/resume-worker",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: resumeWorkerHandler,
});

// Queue trigger removed in favor of dedicated worker app.
// Storage Queue trigger now runs in tabarnam-xai-dedicated Function App only.
// SWA manages HTTP endpoints only.

// Export for test visibility
module.exports = {
  handler: resumeWorkerHandler,
  resumeWorkerHandler,
};
