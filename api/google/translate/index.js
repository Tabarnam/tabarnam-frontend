import { app } from "@azure/functions";

function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(body, status, req) {
  return {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

app.http("googleTranslate", {
  route: "google/translate",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req) => {
    if (req.method === "OPTIONS") {
      return { status: 204, headers: cors(req) };
    }

    let body = {};
    try {
      body = (await req.json()) || {};
    } catch {
      body = {};
    }

    const text = typeof body.text === "string" ? body.text : "";
    const target = typeof body.target === "string" ? body.target : "en";

    return json({ text, target, translatedText: text }, 200, req);
  },
});
