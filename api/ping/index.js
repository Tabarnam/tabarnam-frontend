let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}
const { getBuildInfo } = require("../_buildInfo");

async function pingHandler(req, context) {
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

  return {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({
      ok: true,
      name: "ping",
      ts: new Date().toISOString(),
      ...getBuildInfo(),
    }),
  };
}

app.http("ping", {
  route: "ping",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: pingHandler,
});

module.exports = { handler: pingHandler };
