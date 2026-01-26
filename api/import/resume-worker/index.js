const { app } = require("@azure/functions");
const { resumeWorkerHandler } = require("./handler");

/**
 * HTTP-triggered entrypoint for the resume worker.
 * IMPORTANT:
 * - This file must ONLY register the function.
 * - NO logic, NO side effects, NO imports that execute work.
 */

app.http("import-resume-worker", {
  route: "import/resume-worker",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: resumeWorkerHandler,
});

module.exports = {
  resumeWorkerHandler,
};
