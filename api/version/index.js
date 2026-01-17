const { app } = require("@azure/functions");
const { getBuildInfo } = require("../_buildInfo");
const { getInternalJobSecretInfo, getAcceptableInternalSecretsInfo } = require("../_internalJobAuth");

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

    const buildInfo = getBuildInfo();
    const internalSecretInfo = getInternalJobSecretInfo();
    const acceptableSecretsInfo = getAcceptableInternalSecretsInfo();

    const functionKeyConfigured = Boolean(String(env.FUNCTION_KEY || "").trim());
    const internalJobSecretConfigured = Boolean(String(env.X_INTERNAL_JOB_SECRET || "").trim());

    return {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        ok: true,
        source: detectSource(),
        ts: new Date().toISOString(),
        ...buildInfo,
        runtime: {
          ...(buildInfo && buildInfo.runtime ? buildInfo.runtime : null),
          website_site_name: String(env.WEBSITE_SITE_NAME || ""),
          website_slot_name: String(env.WEBSITE_SLOT_NAME || ""),
          website_hostname: String(env.WEBSITE_HOSTNAME || ""),
          region_name: String(env.REGION_NAME || ""),
          azure_functions_environment: String(env.AZURE_FUNCTIONS_ENVIRONMENT || ""),
          functions_worker_runtime: String(env.FUNCTIONS_WORKER_RUNTIME || ""),
          functions_extension_version: String(env.FUNCTIONS_EXTENSION_VERSION || ""),
          swa_deployment_id: String(env.SWA_DEPLOYMENT_ID || ""),
        },
        config: {
          function_key_configured: functionKeyConfigured,
          internal_job_secret_configured: internalJobSecretConfigured,
          acceptable_secret_sources: acceptableSecretsInfo.map((c) => c.source),
          internal_secret_source: internalSecretInfo ? internalSecretInfo.secret_source : null,
        },
      }),
    };
  },
});
