import { app } from "@azure/functions";

app.http("xai", {
  route: "xai",
  methods: ["POST", "OPTIONS", "GET"],
  authLevel: "function",
  handler: async (req) => {
    // CORS
    const origin = req.headers.get("origin") || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,x-functions-key"
    };
    if (req.method === "OPTIONS") return { status: 204, headers: cors };

    // Simple health for GET (lets you see 401 vs 200 quickly)
    if (req.method === "GET") {
      return { status: 200, headers: cors, jsonBody: { ok: true, route: "/api/xai" } };
    }

    // Echo stub for POST
    const body = await req.json().catch(() => ({}));
    return {
      status: 200,
      headers: cors,
      jsonBody: { ok: true, echo: body, companies: [] }
    };
  }
});
