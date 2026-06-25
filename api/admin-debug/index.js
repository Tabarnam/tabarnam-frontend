const { app } = require('@azure/functions');

async function adminDebugHandler(req, context) {
  context.log("✅ xadminApiDebug handler successfully invoked!");
  return {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ok: true,
      message: "xadmin-api-debug endpoint is working!",
      route: "xadmin-api-debug",
      timestamp: new Date().toISOString(),
    }),
  };
}

app.http('adminDebug', {
  route: 'xadmin-api-debug',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: require("../_adminAuth").withAdminGuard(adminDebugHandler),
});

module.exports = { handler: adminDebugHandler };
