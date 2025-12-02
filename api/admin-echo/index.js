const { app } = require('@azure/functions');

app.http('adminEcho', {
  route: 'admin-echo',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    return {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "content-type,x-functions-key",
      },
      body: JSON.stringify({
        ok: true,
        name: "admin-echo",
        message: "Admin echo endpoint is working correctly!",
        timestamp: new Date().toISOString(),
      }),
    };
  }
});
