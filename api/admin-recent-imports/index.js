module.exports = async function (context, req) {
  context.log("[admin-recent-imports] v3 handler called");

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    context.res = {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization"
      }
    };
    return;
  }

  const takeRaw =
    (req.query && (req.query.take || req.query.top)) ||
    (req.body && (req.body.take || req.body.top)) ||
    "25";

  const take = Number.parseInt(takeRaw, 10) || 25;

  const body = {
    ok: true,
    name: "admin-recent-imports",
    take,
    imports: []
  };

  context.res = {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body
  };
};
