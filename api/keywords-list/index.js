console.log('[keywords-list] Module loading started');
const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");
console.log('[keywords-list] Dependencies imported, app object acquired');

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function getCorsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

let cosmosClient = null;

function getCosmosClient() {
  const endpoint = env("COSMOS_DB_ENDPOINT");
  const key = env("COSMOS_DB_KEY");
  if (!endpoint || !key) return null;
  cosmosClient ||= new CosmosClient({ endpoint, key });
  return cosmosClient;
}

function getKeywordsContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = env("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = "keywords";
  return client.database(databaseId).container(containerId);
}

async function keywordsListHandler(request, context) {
  context.log("keywords-list function invoked");

  const method = String(request.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return {
      status: 204,
      headers: getCorsHeaders(),
    };
  }

  const container = getKeywordsContainer();
  if (!container) {
    return {
      status: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: "Cosmos DB not configured" }),
    };
  }

  try {
    if (method === "GET") {
      try {
        const { resource } = await container.item("industries", "industries").read();
        return {
          status: 200,
          headers: getCorsHeaders(),
          body: JSON.stringify({ keywords: resource.list || [] }),
        };
      } catch (e) {
        return {
          status: 200,
          headers: getCorsHeaders(),
          body: JSON.stringify({ keywords: [] }),
        };
      }
    }

    if (method === "PUT") {
      let body = {};
      try {
        body = typeof request.body === "string" ? JSON.parse(request.body) : (request.body || {});
      } catch {
        return {
          status: 400,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "Invalid JSON" }),
        };
      }

      const keywords = Array.isArray(body.keywords) ? body.keywords : [];
      const docId = "industries";
      const doc = {
        id: docId,
        type: "industry",
        list: keywords.filter(k => typeof k === "string" && k.trim()).map(k => k.trim()),
        updated_at: new Date().toISOString(),
        actor: body.actor || null,
      };

      try {
        context.log("[keywords-list] Upserting keywords document", { id: docId });
        let result;
        try {
          result = await container.items.upsert(doc, { partitionKey: docId });
        } catch (upsertError) {
          context.log("[keywords-list] First upsert attempt failed, retrying without partition key", { error: upsertError?.message });
          result = await container.items.upsert(doc);
        }
        context.log("[keywords-list] Upsert successful", { id: docId });
        return {
          status: 200,
          headers: getCorsHeaders(),
          body: JSON.stringify({ ok: true, keywords: doc.list }),
        };
      } catch (e) {
        context.log("[keywords-list] Upsert failed", { error: e?.message });
        return {
          status: 500,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "Failed to save keywords", detail: e?.message }),
        };
      }
    }

    return {
      status: 405,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  } catch (e) {
    context.log("Error in keywords-list:", e?.message || e);
    return {
      status: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: e?.message || "Internal error" }),
    };
  }
}

console.log('[keywords-list] Registering with app.http...');
app.http('keywordsList', {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'keywords-list',
  handler: keywordsListHandler,
});
console.log('[keywords-list] ✅ Successfully registered with app.http');
