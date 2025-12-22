let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const { getBuildInfo } = require("../_buildInfo");
const { getHandlerVersions } = require("../_handlerVersions");

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

function pickEnv(env) {
  const e = env && typeof env === "object" ? env : {};
  return {
    website_site_name: String(e.WEBSITE_SITE_NAME || ""),
    website_hostname: String(e.WEBSITE_HOSTNAME || ""),
    scm_commit_id: String(e.SCM_COMMIT_ID || ""),
    website_commit_hash: String(e.WEBSITE_COMMIT_HASH || ""),
    build_sourceversion: String(e.BUILD_SOURCEVERSION || ""),
    github_sha: String(e.GITHUB_SHA || ""),
    node_version: String(e.WEBSITE_NODE_DEFAULT_VERSION || process.version || ""),
  };
}

app.http("diag", {
  route: "diag",
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

    const buildInfo = getBuildInfo();
    const handler_versions = getHandlerVersions(buildInfo);

    let routes = [];
    try {
      const appMod = require("../_app");
      routes = typeof appMod?.listRoutes === "function" ? appMod.listRoutes() : [];
    } catch {
      routes = [];
    }

    return json({
      ok: true,
      now: new Date().toISOString(),
      env: pickEnv(process.env),
      routes,
      handler_version: handler_versions.import_start,
      handler_versions,
      ...buildInfo,
    });
  },
});
