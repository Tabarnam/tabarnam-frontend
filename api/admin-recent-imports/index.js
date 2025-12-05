// api/admin-recent-imports/index.js

// IMPORTANT: reuse the shared app instance exported from ../index.js
const app = require("..");

app.http("adminRecentImports", {
  route: "admin-recent-imports", // final URL: /api/admin-recent-imports
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    context.log("[admin-recent-imports] handler called");

    // CORS preflight
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization"
        }
      };
    }

    const url = new URL(request.url);
    const takeRaw =
      url.searchParams.get("take") ||
      url.searchParams.get("top") ||
      "25";
    const take = Number.parseInt(takeRaw, 10) || 25;

    const body = {
      ok: true,
      name: "admin-recent-imports",
      take,
      imports: [] // TODO: populate with real data later
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
