const { app } = require("@azure/functions");
const { resumeWorkerHandler } = require("./handler");

app.http("import-resume-worker", {
  route: "import/resume-worker",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: resumeWorkerHandler,
});

module.exports = {
  resumeWorkerHandler,
};
