let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

async function _pingHandler(req, context) {
  if ((req.method || "").toUpperCase() === "OPTIONS") {
    return {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "content-type,x-functions-key",
      },
    };
  }

  // Extract backend name from WEBSITE_INSTANCE_ID
  // Format is typically: tabarnam-xai-dedicated1a2b3c or tabarnam-xai-externalapi1a2b3c
  const websiteInstanceId = process.env.WEBSITE_INSTANCE_ID || "unknown";
  const backendName = websiteInstanceId
    .match(/^[a-z\-]+/)?.[0] || websiteInstanceId || "unknown";

  // Extract request host and path
  const host = req?.headers?.host || "unknown";
  const path = req?.originalUrl || req?.url || "unknown";

  return {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({
      ok: true,
      backend_name: backendName,
      timestamp: new Date().toISOString(),
      request: {
        host: host,
        path: path,
      },
    }),
  };
}

app.http("_ping", {
  route: "_ping",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: _pingHandler,
});

module.exports = { handler: _pingHandler };
