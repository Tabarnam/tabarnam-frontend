const { app } = require("@azure/functions");

async function helloHandler(req, context) {
  const method = String(req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "content-type,x-functions-key",
      },
    };
  }

  return {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({ ok: true, message: "hello" }),
  };
}

app.http("hello", {
  route: "hello",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: helloHandler,
});

module.exports = { handler: helloHandler };
