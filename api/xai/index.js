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

    const bodyObj = await req.json().catch(() => ({}));
    console.log(`[xai] Received XAI request:`, JSON.stringify(bodyObj));

    console.warn(`[xai] ERROR: This endpoint (/api/xai) is not implemented!`);
    console.warn(`[xai] FUNCTION_URL is currently pointing to this endpoint, which creates a loop.`);
    console.warn(`[xai] Please update FUNCTION_URL to point to the actual XAI API endpoint.`);

    return json(
      {
        error: "XAI endpoint not implemented",
        message: "The /api/xai endpoint is not configured properly. FUNCTION_URL should point to the actual XAI service, not to this local endpoint.",
        note: "Update FUNCTION_URL environment variable to point to your XAI API endpoint (e.g., external API or XAI service)",
        configuration: {
          FUNCTION_URL: (process.env.FUNCTION_URL || "").trim() || "not set",
          FUNCTION_KEY: (process.env.FUNCTION_KEY || "").trim() ? "configured" : "not set",
        },
      },
      501,
      req
    );
  },
});
