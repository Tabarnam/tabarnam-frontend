const endpoint = require("./index.js");

module.exports = async function adminCompanyHistoryLegacy(context, req) {
  try {
    const handler = typeof endpoint?.handler === "function" ? endpoint.handler : null;
    const result = handler ? await handler(req, context) : { status: 500, body: JSON.stringify({ error: "Handler not found" }) };

    context.res = {
      status: result?.status || 200,
      headers: result?.headers || { "Content-Type": "application/json" },
      body: result?.body,
    };
  } catch (e) {
    context.log("[admin-company-history] legacy wrapper error", e?.message || e);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal error" }),
    };
  }
};
