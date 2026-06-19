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

  // Anonymous health endpoint — expose only build_id (useful for verifying a
  // deploy). The runtime block (website_site_name, hostname, worker runtime,
  // swa_deployment_id) is infrastructure fingerprinting and is intentionally
  // NOT returned to anonymous callers.
  const bi = getBuildInfo();
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
      build_id: bi.build_id,
      build_id_source: bi.build_id_source,
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
