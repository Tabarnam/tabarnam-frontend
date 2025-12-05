module.exports = async function (context, req) {
  context.log("[admin-test] v3 handler called");

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

  const body = {
    ok: true,
    name: "admin-test",
    timestamp: new Date().toISOString()
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
