const { app } = require("@azure/functions");

function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
  };
}

function json(obj, status = 200, req) {
  return {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

app.http("xai", {
  route: "xai",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") {
      return { status: 204, headers: cors(req) };
    }

    console.warn(`[xai] Deprecated endpoint: /api/xai should not be called directly`);
    console.warn(`[xai] Use /api/xadmin-api-bulk-import-config for configuration diagnostics instead`);

    return json(
      {
        error: "Endpoint deprecated",
        message: "The /api/xai endpoint is deprecated and should not be used",
        note: "Use /api/xadmin-api-bulk-import-config for configuration status or call /api/proxy-xai for XAI operations",
        configuration: {
          XAI_EXTERNAL_BASE: (process.env.XAI_EXTERNAL_BASE || "").trim() || "not set",
          XAI_EXTERNAL_KEY: (process.env.XAI_EXTERNAL_KEY || "").trim() ? "configured" : "not set",
          FUNCTION_URL: (process.env.FUNCTION_URL || "").trim() ? "legacy (deprecated)" : "not set",
        },
      },
      410,
      req
    );
  },
});
