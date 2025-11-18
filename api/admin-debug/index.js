const { app } = require("@azure/functions");

app.http("adminDebug", {
  route: "admin-debug",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    context.log("✅ adminDebug handler successfully invoked!");
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        message: "admin-debug endpoint is working!",
        route: "admin/debug",
        timestamp: new Date().toISOString(),
      }),
    };
  },
});
