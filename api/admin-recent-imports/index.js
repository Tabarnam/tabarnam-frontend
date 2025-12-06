const { app } = require("@azure/functions");

app.http("adminRecentImports", {
  route: "admin-api-recent-imports",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    context.log("[admin-recent-imports] handler called");

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

    const takeRaw = req.query?.take || req.query?.top || "25";
    const take = Number.parseInt(takeRaw, 10) || 25;

    return {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({
        ok: true,
        name: "admin-recent-imports",
        take,
        imports: []
      })
    };
  }
});
