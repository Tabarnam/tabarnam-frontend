// This file re-exports the shared handler for the queue trigger.
// Both SWA HTTP endpoint (api/) and queue trigger (worker/) use the same implementation
// from shared/import/resume-worker/handler.js

const { resumeWorkerHandler } = require("../../../shared/import/resume-worker/handler");

module.exports = {
  resumeWorkerHandler,
};
