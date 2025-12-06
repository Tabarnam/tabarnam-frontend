module.exports = async function (context, req) {
  context.log("[admin-test] v3 classic handler called");

  if ((req.method || "").toUpperCase() === "OPTIONS") {
    return {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization"
      }
    };
  }

  return {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify({
      ok: true,
      name: "admin-test",
      timestamp: new Date().toISOString()
    })
  };
};
