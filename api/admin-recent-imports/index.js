// api/admin-recent-imports/index.js

const { app } = require("@azure/functions");

app.http("adminRecentImports", {
  route: "admin-recent-imports", // /api/admin-recent-imports
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    context.log("[admin-recent-imports] v4 handler called");

    const method = (req.method || "").toUpperCase();

    // CORS preflight
    if (method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization"
        }
      };
    }

    // Read query params via URL in v4
    const url = new URL(req.url);
    const takeRaw =
      url.searchParams.get("take") ||
      url.searchParams.get("top") ||
      "25";

    const take = Number.parseInt(takeRaw, 10) || 25;

    const body = {
      ok: true,
      name: "admin-recent-imports",
      take,
      imports: [] // placeholder to be filled with real data later
    };

    return {
      status: 200,
      jsonBody: body,
      headers: {
        "Access-Control-Allow-Origin": "*"
      }
    };
  }
});
