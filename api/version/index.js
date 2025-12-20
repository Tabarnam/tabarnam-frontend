const { app } = require("@azure/functions");
const { getBuildInfo } = require("../_buildInfo");

function detectSource() {
  const env = process.env || {};
  if (env.SWA_DEPLOYMENT_ID || env.SWA_CLOUD_ROLE_NAME || env.SWA_CLOUD_ROLE_INSTANCE_ID) {
    return "swa";
  }

  const site = String(env.WEBSITE_SITE_NAME || "").toLowerCase();
  if (site.includes("xai") || site.includes("dedicated")) return "linked-backend";

  return "unknown";
}

app.http("version", {
  route: "version",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req) => {
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

    const env = process.env || {};

    return {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        ok: true,
        source: "swa",
        ts: new Date().toISOString(),
        ...getBuildInfo(),
        runtime: {
          website_site_name: String(env.WEBSITE_SITE_NAME || ""),
          website_hostname: String(env.WEBSITE_HOSTNAME || ""),
          azure_functions_environment: String(env.AZURE_FUNCTIONS_ENVIRONMENT || ""),
          functions_worker_runtime: String(env.FUNCTIONS_WORKER_RUNTIME || ""),
          swa_deployment_id: String(env.SWA_DEPLOYMENT_ID || ""),
        },
      }),
    };
  },
});
