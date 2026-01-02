const endpoint = require("../admin-company-history/index.js");

function safeLog(context, payload) {
  try {
    const line = JSON.stringify(payload);
    if (typeof context?.log === "function") {
      context.log(line);
    } else {
      console.log(line);
    }
  } catch {
    // ignore
  }
}

module.exports = async function adminCompanyHistoryParamLegacy(context, req) {
  safeLog(context, {
    stage: "admin_companies_history",
    kind: "entry",
    method: String(req?.method || "").toUpperCase(),
    url: req?.url || null,
    build_id: process.env.BUILD_ID || null,
    bindingData: context?.bindingData || null,
  });

  try {
    const handler = typeof endpoint?.handler === "function" ? endpoint.handler : null;

    safeLog(context, {
      stage: "admin_companies_history",
      kind: "before_delegate",
      has_handler: Boolean(handler),
    });

    const result = handler
      ? await handler(req, context)
      : { status: 500, body: JSON.stringify({ error: "Handler not found" }) };

    safeLog(context, {
      stage: "admin_companies_history",
      kind: "delegate_return",
      status: result?.status || 200,
    });

    context.res = {
      status: result?.status || 200,
      headers: result?.headers || { "Content-Type": "application/json" },
      body: result?.body,
    };

    safeLog(context, {
      stage: "admin_companies_history",
      kind: "success",
      status: context?.res?.status || 200,
    });
  } catch (e) {
    safeLog(context, {
      stage: "admin_companies_history",
      kind: "wrapper_error",
      message: e?.message || String(e),
    });

    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal error" }),
    };
  }
};
