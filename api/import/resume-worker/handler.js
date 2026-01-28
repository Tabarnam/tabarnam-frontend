// This file re-exports the shared handler for backward compatibility.
// The actual implementation lives in shared/import/resume-worker/handler.js
// Both SWA HTTP endpoint (api/) and queue trigger (worker/) use this single source of truth.

const { resumeWorkerHandler } = require("../../shared/import/resume-worker/handler");

module.exports = {
  resumeWorkerHandler,
};
