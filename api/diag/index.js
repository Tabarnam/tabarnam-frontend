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
    return json({
      ok: true,
      name: "diag",
      ts: new Date().toISOString(),
      handler_versions: getHandlerVersions(buildInfo),
      ...buildInfo,
    });
  },
});
