const { app } = require("@azure/functions");

console.log("[test-echo] Module loaded");

app.http("testEcho", {
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "test-echo",
  handler: async (req, context) => {
    console.log("[test-echo] Handler invoked");
    context.log("test-echo function called");

    return {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: JSON.stringify({
        ok: true,
        message: "test-echo is working",
        timestamp: new Date().toISOString(),
        url: req.url,
        method: req.method,
      }),
    };
  },
});

console.log("[test-echo] Handler registered successfully");
