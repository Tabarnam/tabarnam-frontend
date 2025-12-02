import { app } from '@azure/functions';

export default app.http('health', {
  route: 'health',
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
}, async (req, context) => {
  const method = String(req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return {
      status: 204,
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
    body: JSON.stringify({
      ok: true,
      name: "health",
      ts: new Date().toISOString(),
    }),
  };
});
