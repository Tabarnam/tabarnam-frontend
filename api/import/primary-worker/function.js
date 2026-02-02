const endpoint = require("./index.js");

module.exports = async function importPrimaryWorkerLegacy(context, req) {
  try {
    const handler = typeof endpoint?.handler === "function"
      ? endpoint.handler
      : typeof endpoint?._test?.handler === "function"
        ? endpoint._test.handler
        : null;

    if (!handler) {
      context.res = { status: 500, body: JSON.stringify({ error: "Handler not found" }) };
      return;
    }

    const result = await handler(req, context);
    context.res = {
      status: result?.status || 200,
      headers: result?.headers || { "Content-Type": "application/json" },
      body: result?.body,
    };
  } catch (e) {
    context.log("[import/primary-worker] legacy wrapper error", e?.message || e);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: e?.message || "Internal error" }),
    };
  }
};
