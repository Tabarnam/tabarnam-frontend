const { getBuildInfo } = require("../_buildInfo");

const BUILD_INFO = getBuildInfo();
const HANDLER_ID = "_diag-hello";

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,authorization,x-functions-key",
      "X-Api-Handler": HANDLER_ID,
      "X-Api-Build-Id": String(BUILD_INFO.build_id || ""),
      "X-Api-Build-Source": String(BUILD_INFO.build_id_source || ""),
    },
    body: JSON.stringify(obj),
  };
}

async function handler(req) {
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

  if (method !== "GET") return json({ error: "Method not allowed" }, 405);

  return json({
    ok: true,
    route: "_diag/hello",
    ts: new Date().toISOString(),
    ...BUILD_INFO,
  });
}

try {
  const { app, hasRoute } = require("../_app");

  const ROUTE = "_diag/hello";
  if (!hasRoute(ROUTE)) {
    app.http("_diagHello", {
      route: ROUTE,
      methods: ["GET", "OPTIONS"],
      authLevel: "anonymous",
      handler,
    });
  }
} catch {
  // no-op
}

module.exports.handler = handler;
