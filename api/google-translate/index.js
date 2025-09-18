// Azure Functions v4 HTTP trigger: POST /api/google/translate
import { app } from "@azure/functions";

app.http("googleTranslate", {
  route: "google/translate",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    let body = {};
    try { body = await req.json(); } catch {}
    let { q, target, source } = body || {};
    if (!q || !target) return json({ error: "Provide { q, target }" }, 400, req);

    const API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;
    if (!API_KEY) return json({ error: "GOOGLE_TRANSLATE_API_KEY not configured" }, 500, req);

    // Allow string or array for q
    const payload = { q: Array.isArray(q) ? q : [String(q)], target: String(target) };
    if (source) payload.source = String(source);

    try {
      const url = new URL("https://translation.googleapis.com/language/translate/v2");
      url.searchParams.set("key", API_KEY);

      const r = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (!r.ok) return json({ error: `Google error ${r.status}`, data }, r.status, req);

      const translations = data?.data?.translations || [];
      return json({ ok: true, translations, raw: data }, 200, req);
    } catch (e) {
      return json({ error: e.message || "Translate fetch failed" }, 500, req);
    }
  }
});

function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}
function json(obj, status = 200, req) {
  return { status, headers: { ...cors(req), "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
