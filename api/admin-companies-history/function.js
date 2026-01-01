const { handler } = require("../admin-company-history/index.js");

module.exports = async function adminCompanyHistoryParamLegacy(context, req) {
  try {
    const result = await handler(req, context);

    context.res = {
      status: result?.status || 200,
      headers: result?.headers || { "Content-Type": "application/json" },
      body: result?.body,
    };
  } catch (e) {
    context.log("[admin-companies-history] legacy wrapper error", e?.message || e);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal error" }),
    };
  }
};
