const { app } = require("@azure/functions");
const axios = require("axios");

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

    const apiBase = String(process.env.VITE_API_BASE || process.env.API_BASE || "").trim();
    const proxyUrl = apiBase
      ? `${apiBase}/proxy-xai`
      : "http://localhost:7071/api/proxy-xai";

    console.log(`[xai] Proxying to: ${proxyUrl}`);

    try {
      const response = await axios.post(proxyUrl, bodyObj, {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 600000,
      });

      console.log(`[xai] Proxy response received with status: ${response.status}`);
      return json(response.data, response.status, req);
    } catch (err) {
      console.error(`[xai] Proxy request failed:`, err.message);
      console.error(`[xai] Error details:`, err.response?.data || err.toString());

      return json(
        {
          error: `XAI proxy failed: ${err.message}`,
          detail: err.response?.data,
        },
        err.response?.status || 502,
        req
      );
    }
  },
});
