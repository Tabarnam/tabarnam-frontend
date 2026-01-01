const endpoint = require("../../admin-company-history/index.js");

module.exports = async function adminCompaniesHistory(context, req) {
  try {
    const handler = typeof endpoint?.handler === "function" ? endpoint.handler : null;
    const result = handler ? await handler(req, context) : { status: 500, body: JSON.stringify({ error: "Handler not found" }) };

    context.res = {
      status: result?.status || 200,
      headers: result?.headers || { "Content-Type": "application/json" },
      body: result?.body,
    };
  } catch (e) {
    context.log("[admin/companies/{company_id}/history] error", e?.message || e);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal error" }),
    };
  }
};
