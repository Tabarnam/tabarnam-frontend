let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,authorization,x-functions-key",
    },
    body: JSON.stringify(obj),
  };
}

app.http("diag-xai-alias", {
  route: "diag/xai-alias",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req) => {
    const method = String(req?.method || "").toUpperCase();
    if (method === "OPTIONS") {
      return {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "content-type,authorization,x-functions-key",
        },
      };
    }

    return json({
      ok: true,
      route: "diag/xai-alias",
      note: "Use /api/diag/xai-v2 for the new hardened diagnostics until /api/diag/xai stops returning 500 in prod",
      timestamp: new Date().toISOString(),
    });
  },
});
