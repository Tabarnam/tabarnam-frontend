const { CosmosClient } = require("@azure/cosmos");

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

module.exports = async function (context, req) {
  context.log("admin-keywords function invoked");
  
  const method = String(req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    context.res = {
      status: 204,
      headers: getCorsHeaders(),
    };
    return;
  }

  const container = getKeywordsContainer();
  if (!container) {
    context.res = {
      status: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: "Cosmos DB not configured" }),
    };
    return;
  }

  try {
    if (method === "GET") {
      try {
        const { resource } = await container.item("industries", "industries").read();
        context.res = {
          status: 200,
          headers: getCorsHeaders(),
          body: JSON.stringify({ keywords: resource.list || [] }),
        };
        return;
      } catch (e) {
        context.res = {
          status: 200,
          headers: getCorsHeaders(),
          body: JSON.stringify({ keywords: [] }),
        };
        return;
      }
    }

    if (method === "PUT") {
      let body = {};
      try {
        body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      } catch {
        context.res = {
          status: 400,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "Invalid JSON" }),
        };
        return;
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
        context.log("[admin-keywords] Upserting keywords document", { id: docId });
        let result;
        try {
          result = await container.items.upsert(doc, { partitionKey: docId });
        } catch (upsertError) {
          context.log("[admin-keywords] First upsert attempt failed, retrying without partition key", { error: upsertError?.message });
          result = await container.items.upsert(doc);
        }
        context.log("[admin-keywords] Upsert successful", { id: docId });
        context.res = {
          status: 200,
          headers: getCorsHeaders(),
          body: JSON.stringify({ ok: true, keywords: doc.list }),
        };
        return;
      } catch (e) {
        context.log("[admin-keywords] Upsert failed", { error: e?.message });
        context.res = {
          status: 500,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "Failed to save keywords", detail: e?.message }),
        };
        return;
      }
    }

    context.res = {
      status: 405,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  } catch (e) {
    context.log("Error in admin-keywords:", e?.message || e);
    context.res = {
      status: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: e?.message || "Internal error" }),
    };
  }
};
