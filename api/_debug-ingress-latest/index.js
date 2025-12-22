// api/_debug-ingress-latest/index.js
// Route: /api/_debug/ingress/latest

const { app } = require("@azure/functions");

const {
  getLatestIngressSnapshot,
  isDebugAuthorized,
} = require("../_debugSnapshots");

function jsonResponse(status, obj) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,authorization,x-tabarnam-debug-key",
    },
    body: JSON.stringify(obj),
  };
}

app.http("_debug-ingress-latest", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "_debug/ingress/latest",
  handler: async (req) => {
    if (!isDebugAuthorized(req)) {
      return jsonResponse(401, { ok: false, error: "unauthorized" });
    }

    const snap = getLatestIngressSnapshot();
    if (!snap) {
      return jsonResponse(404, { ok: false, error: "no_ingress_captured" });
    }

    return jsonResponse(200, {
      ok: true,
      ts: snap.ts,
      handler_version: snap.handler_version,
      ingress: snap.ingress,
    });
  },
});
