// api/ping/index.js
module.exports = async function (context, req) {
  if ((req.method || "").toUpperCase() === "OPTIONS") {
    context.res = {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "content-type,x-functions-key"
      }
    };
    return;
  }

  context.res = {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify({ ok: true, name: "ping", ts: new Date().toISOString() })
  };
};
