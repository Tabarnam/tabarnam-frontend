// api/admin-test/index.js - v4 HTTP function
const { app } = require("@azure/functions");

function handleAdminTest(req, ctx, name) {
  ctx.log(`[${name}] v4 handler called`);

  if ((req.method || "").toUpperCase() === "OPTIONS") {
    return {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
      },
    };
  }

  return {
    status: 200,
    jsonBody: {
      ok: true,
      name,
      timestamp: new Date().toISOString(),
    },
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
  };
}

// Diagnostic endpoint (preferred)
app.http("adminTest", {
  route: "admin-test",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => handleAdminTest(req, ctx, "admin-test"),
});

// Legacy alias (kept for backwards compatibility / debugging)
app.http("xadminApiTest", {
  route: "xadmin-api-test",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => handleAdminTest(req, ctx, "xadmin-api-test"),
});
