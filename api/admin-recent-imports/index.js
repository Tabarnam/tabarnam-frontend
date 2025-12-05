const { app } = require("@azure/functions");

app.http("admin-recent-imports", {
  route: "admin-recent-imports",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "content-type,x-functions-key",
        },
      };
    }

    if (method !== "GET") {
      return {
        status: 405,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ ok: false, error: "Method Not Allowed" }),
      };
    }

    const url = new URL(req.url);
    const takeRaw = url.searchParams.get("take") || url.searchParams.get("top") || "25";
    const take = Math.max(1, Math.min(1000, Number.parseInt(takeRaw, 10) || 25));

    return {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        ok: true,
        name: "admin-recent-imports",
        take,
        imports: [],
      }),
    };
  },
});
