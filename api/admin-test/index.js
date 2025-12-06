// api/admin-test/index.js - v4 HTTP function
const { app } = require("@azure/functions");

app.http("adminTest", {
  route: "admin-api-test",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    ctx.log("[admin-api-test] v4 handler called");

    // CORS preflight
    if ((req.method || "").toUpperCase() === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization"
        }
      };
    }

    return {
      status: 200,
      jsonBody: {
        ok: true,
        name: "admin-api-test",
        timestamp: new Date().toISOString()
      },
      headers: {
        "Access-Control-Allow-Origin": "*"
      }
    };
  }
});
