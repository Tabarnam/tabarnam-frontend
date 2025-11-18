const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

const cors = (req) => {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
};

const json = (obj, status = 200, req) => ({
  status,
  headers: { ...cors(req), "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

let cosmosClient = null;

function getCosmosClient() {
  const endpoint = E("COSMOS_DB_ENDPOINT");
  const key = E("COSMOS_DB_KEY");
  if (!endpoint || !key) return null;
  cosmosClient ||= new CosmosClient({ endpoint, key });
  return cosmosClient;
}

function getKeywordsContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = "keywords";
  return client.database(databaseId).container(containerId);
}

app.http("adminKeywords", {
  route: "admin/keywords",
  methods: ["GET", "PUT", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return { status: 204, headers: cors(req) };
    }

    const container = getKeywordsContainer();
    if (!container) {
      return json({ error: "Cosmos DB not configured" }, 500, req);
    }

    try {
      if (method === "GET") {
        try {
          const { resource } = await container.item("industries", "industries").read();
          return json({ keywords: resource.list || [] }, 200, req);
        } catch (e) {
          return json({ keywords: [] }, 200, req);
        }
      }

      if (method === "PUT") {
        let body = {};
        try {
          body = await req.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400, req);
        }

        const keywords = Array.isArray(body.keywords) ? body.keywords : [];
        const doc = {
          id: "industries",
          type: "industry",
          list: keywords.filter(k => typeof k === "string" && k.trim()).map(k => k.trim()),
          updated_at: new Date().toISOString(),
          actor: body.actor || null,
        };

        await container.items.upsert(doc);
        return json({ ok: true, keywords: doc.list }, 200, req);
      }

      return json({ error: "Method not allowed" }, 405, req);
    } catch (e) {
      context.log("Error in admin-keywords:", e?.message || e);
      return json({ error: e?.message || "Internal error" }, 500, req);
    }
  },
});
