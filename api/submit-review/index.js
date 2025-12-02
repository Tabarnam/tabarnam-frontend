// api/submit-review/index.js
const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");
const { randomUUID, randomBytes } = require("node:crypto");

// -------- helpers ----------
const E = (k, d = "") => (process.env[k] ?? d).toString().trim();
const cors = (req) => {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-client-request-id, x-session-id",
  };
};
const json = (obj, status = 200, req) => ({
  status,
  headers: { ...cors(req), "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});
const safeUuid = () => {
  try {
    return randomUUID();
  } catch {
    const a = randomBytes(16);
    return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
};

// -------- Cosmos (reuse client) ----------
let cosmosClient;
function getReviewsContainer() {
  const endpoint = E("COSMOS_DB_ENDPOINT");
  const key = E("COSMOS_DB_KEY");
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_REVIEWS_CONTAINER", "reviews");
  if (!endpoint || !key) return null;
  cosmosClient ||= new CosmosClient({ endpoint, key });
  return cosmosClient.database(databaseId).container(containerId);
}

app.http("submit-review", {
  route: "submit-review",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    const container = getReviewsContainer();
    if (!container) return json({ error: "Cosmos env not configured" }, 500, req);

    // ---- parse & validate
    let body = {};
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400, req);
    }

    const company_name = String(body?.company_name || "").trim();
    const rating = Number(body?.rating);
    const text = String(body?.text || "").trim();
    const user_name = String(body?.user_name || "").trim();
    const user_location = String(body?.user_location || "").trim();

    if (!company_name) return json({ error: "company_name required" }, 400, req);
    if (!(rating >= 1 && rating <= 5))
      return json({ error: "rating must be 1..5" }, 400, req);
    if (text.length < 10)
      return json({ error: "review text too short" }, 400, req);

    // ---- optional bot check (best effort)
    let flagged_bot = false,
      bot_reason = "";
    try {
      const XAI_API_KEY = E("XAI_API_KEY");
      if (XAI_API_KEY) {
        const prompt = `Return strictly JSON: {"likely_bot": true|false, "reason": "short reason"} for this review:
Review: ${JSON.stringify(text)}
Name: ${user_name || "(none)"} | Location: ${user_location || "(none)"} | Length: ${
          text.length
        }`;
        const r = await fetch("https://api.x.ai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${XAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "grok-4-latest",
            temperature: 0,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        const data = await r.json().catch(() => ({}));
        const content = data?.choices?.[0]?.message?.content || "{}";
        try {
          const parsed = JSON.parse(content);
          flagged_bot = !!parsed?.likely_bot;
          bot_reason = String(parsed?.reason || "");
        } catch {
          /* ignore parse errors */
        }
      }
    } catch (e) {
      ctx?.log?.warn?.(`Bot check failed: ${e?.message || e}`);
    }

    // ---- write
    const doc = {
      id: safeUuid(),
      // NOTE: our reviews container is assumed to use /company as the partition key.
      company: company_name,
      company_name,
      rating,
      text,
      user_name: user_name || null,
      user_location: user_location || null,
      flagged_bot,
      bot_reason,
      created_at: new Date().toISOString(),
    };

    try {
      await container.items.upsert(doc, {
        // If your container uses a different partition key, change this:
        partitionKey: doc.company || "reviews",
      });
      return json({ ok: true, review: doc }, 200, req);
    } catch (e) {
      return json({ error: e?.message || "Insert failed" }, 500, req);
    }
  },
});
