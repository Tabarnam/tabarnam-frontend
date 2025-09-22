// POST /api/submit-review
import { app } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";

app.http("submitReview", {
  route: "submit-review",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    const endpoint   = process.env.COSMOS_DB_ENDPOINT;
    const key        = process.env.COSMOS_DB_KEY;
    const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
    const containerId= process.env.COSMOS_DB_REVIEWS_CONTAINER || "reviews";

    if (!endpoint || !key) return json({ error: "Cosmos env not configured" }, 500, req);

    let body = {};
    try { body = await req.json(); } catch {}
    const company_name = String(body?.company_name || "").trim();
    const rating       = Number(body?.rating);
    const text         = String(body?.text || "").trim();
    const user_name    = String(body?.user_name || "").trim();
    const user_location= String(body?.user_location || "").trim();

    if (!company_name)                   return json({ error: "company_name required" }, 400, req);
    if (!(rating >= 1 && rating <= 5))   return json({ error: "rating must be 1..5" }, 400, req);
    if (text.length < 10)                return json({ error: "review text too short" }, 400, req);

    // Optional bot check via x.ai — best effort, non-blocking
    let flagged_bot = false, bot_reason = "";
    try {
      const XAI_API_KEY = process.env.XAI_API_KEY;
      if (XAI_API_KEY) {
        const prompt = `Return strictly JSON: {"likely_bot": true|false, "reason": "short reason"} for this review:
Review: ${JSON.stringify(text)}
Name: ${user_name || "(none)"} | Location: ${user_location || "(none)"} | Length: ${text.length}`;
        const r = await fetch("https://api.x.ai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${XAI_API_KEY}` },
          body: JSON.stringify({ model: "grok-4-latest", temperature: 0, messages: [{ role: "user", content: prompt }] })
        });
        const data    = await r.json().catch(() => ({}));
        const content = data?.choices?.[0]?.message?.content || "{}";
        const parsed  = JSON.parse(content);
        flagged_bot = !!parsed?.likely_bot;
        bot_reason  = String(parsed?.reason || "");
      }
    } catch (e) {
      ctx?.warn?.(`Bot check failed: ${e?.message || e}`);
    }

    const client    = new CosmosClient({ endpoint, key });
    const container = client.database(databaseId).container(containerId);

    const doc = {
      id: safeUuid(),
      company: company_name,          // <-- matches partition key /company
      company_name,                   // <-- duplicate for UI/back-compat
      rating,
      text,
      user_name: user_name || null,
      user_location: user_location || null,
      flagged_bot,
      bot_reason,
      created_at: new Date().toISOString()
    };

    try {
      // Partition key is taken from doc.company because the container’s pk is /company
      await container.items.create(doc);
      return json({ ok: true, review: doc }, 200, req);
    } catch (e) {
      return json({ error: e.message || "Insert failed" }, 500, req);
    }
  }
});

function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-request-id, x-session-id"
  };
}
function json(obj, status = 200, req) {
  return { status, headers: { ...cors(req), "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
function safeUuid() {
  try { return crypto.randomUUID(); }
  catch {
    const a = (globalThis.crypto || require("crypto")).randomBytes?.(16) || new Uint8Array(16).map(()=>Math.random()*256|0);
    return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
  }
}
