const { getBuildInfo } = require("../../../_buildInfo");

const ROUTES = [
  "/api/admin-company-history",
  "/api/admin/companies/{company_id}/history",
];

function corsHeaders(req) {
  const origin = (req?.headers?.origin || req?.headers?.Origin || "*").toString();
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,x-functions-key",
  };
}

module.exports = async function adminRoutesHealth(context, req) {
  const method = String(req?.method || "GET").toUpperCase();

  if (method === "OPTIONS") {
    context.res = { status: 200, headers: corsHeaders(req) };
    return;
  }

  if (method !== "GET") {
    context.res = {
      status: 405,
      headers: { ...corsHeaders(req), "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Method not allowed" }),
    };
    return;
  }

  const build = getBuildInfo();

  context.res = {
    status: 200,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, routes: ROUTES, build_id: build?.build_id || null }),
  };
};
