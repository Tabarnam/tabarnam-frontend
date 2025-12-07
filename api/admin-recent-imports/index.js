// api/admin-recent-imports/index.js - v4 HTTP function
const { app } = require("@azure/functions");

app.http("adminRecentImports", {
  // New safe prefix
  route: "xadmin-api-recent-imports",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    ctx.log("[xadmin-api-recent-imports] v4 handler called");

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

    const query = req.query || new URLSearchParams();
    const takeRaw =
      query.get("take") ||
      query.get("top") ||
      "25";

    const take = Number.parseInt(takeRaw, 10) || 25;

    return {
      status: 200,
      jsonBody: {
        ok: true,
        name: "xadmin-api-recent-imports",
        take,
        imports: []
      },
      headers: {
        "Access-Control-Allow-Origin": "*"
      }
    };
  }
});
