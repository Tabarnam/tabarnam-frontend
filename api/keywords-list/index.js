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
        context.log("[keywords-list] Reading industries document from Cosmos...");
        const { resource } = await container.item("industries", "industries").read();
        context.log("[keywords-list] Successfully read industries document");
        return {
          status: 200,
          headers: getCorsHeaders(),
          body: JSON.stringify({ keywords: resource.list || [] }),
        };
      } catch (e) {
        context.log("[keywords-list] Failed to read industries document (expected on first run)", { error: e?.message });
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
        context.log("[keywords-list] JSON parse error on PUT");
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
        context.log("[keywords-list] Upserting keywords document", { id: docId, keywordCount: doc.list.length });
        let result;
        try {
          result = await container.items.upsert(doc, { partitionKey: docId });
          context.log("[keywords-list] Upsert with partition key successful", { id: docId, statusCode: result?.statusCode });
        } catch (upsertError) {
          context.log("[keywords-list] Upsert with partition key failed, retrying without...", { error: upsertError?.message });
          result = await container.items.upsert(doc);
          context.log("[keywords-list] Fallback upsert successful", { id: docId });
        }
        return {
          status: 200,
          headers: getCorsHeaders(),
          body: JSON.stringify({ ok: true, keywords: (result?.resource?.list || doc.list) }),
        };
      } catch (e) {
        context.log("[keywords-list] Upsert failed completely", { error: e?.message, stack: e?.stack });
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
app.http('keywords-list', {
  methods: ['GET', 'PUT', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'keywords-list',
  handler: keywordsListHandler,
});
console.log('[keywords-list] ✅ Successfully registered app.http with route: keywords-list');
