// Entry point for tabarnam-dedicated-worker Azure Functions app
// Registers all queue trigger functions

require("./functions/import-resume-worker/index.js");

// Health check function if it exists
try {
  require("./functions/health/index.js");
} catch (e) {
  // Health function is optional
}
