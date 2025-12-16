console.log('[keywords-list] Module loading started');
const { app } = require("@azure/functions");

let CosmosClientCtor = null;
function loadCosmosClientCtor() {
  if (CosmosClientCtor !== null) return CosmosClientCtor;
  try {
    CosmosClientCtor = require("@azure/cosmos").CosmosClient;
  } catch (e) {
    CosmosClientCtor = undefined;
    console.error("[keywords-list] Failed to load @azure/cosmos; Cosmos DB queries will be unavailable", {
      error: e?.message,
    });
  }
  return CosmosClientCtor;
}
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
  };
}

let cosmosClient = null;

function getCosmosClientInfo() {
  const endpoint = env("COSMOS_DB_ENDPOINT", "");
  const key = env("COSMOS_DB_KEY", "");

  const databaseEnvRaw = env("COSMOS_DB_DATABASE", "");
  const companiesContainerEnvRaw = env("COSMOS_DB_COMPANIES_CONTAINER", "");
  const keywordsContainerEnvRaw = env("COSMOS_DB_KEYWORDS_CONTAINER", "");

  const databaseId = env("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = env(
    "COSMOS_DB_KEYWORDS_CONTAINER",
    companiesContainerEnvRaw || "keywords"
  );

  const config = {
    hasEndpoint: Boolean(endpoint),
    hasKey: Boolean(key),
    hasDatabase: Boolean(databaseEnvRaw),
    hasContainer: Boolean(keywordsContainerEnvRaw || companiesContainerEnvRaw),
    effectiveDatabase: databaseId,
    effectiveContainer: containerId,
  };

  const C = loadCosmosClientCtor();
  if (!C) return { client: null, cosmosModuleAvailable: false, config };

  if (!endpoint || !key) return { client: null, cosmosModuleAvailable: true, config };

  try {
    cosmosClient ||= new C({ endpoint, key });
    return { client: cosmosClient, cosmosModuleAvailable: true, config };
  } catch (e) {
    console.error("[keywords-list] Failed to create Cosmos client", { error: e?.message });
    return { client: null, cosmosModuleAvailable: true, config, clientError: e?.message };
  }
}

function getKeywordsContainerInfo() {
  const cosmos = getCosmosClientInfo();
  if (!cosmos.client) return { container: null, ...cosmos };

  const db = cosmos.config?.effectiveDatabase;
  const containerId = cosmos.config?.effectiveContainer;

  try {
    return {
      ...cosmos,
      container: cosmos.client.database(db).container(containerId),
    };
  } catch (e) {
    console.error("[keywords-list] Failed to access database/container", { error: e?.message });
    return { container: null, ...cosmos, containerError: e?.message };
  }
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

  const cosmos = getKeywordsContainerInfo();
  const container = cosmos.container;

  if (!container) {
    const cfg = cosmos.config || {};
    const missing = {
      endpoint: !cfg.hasEndpoint,
      key: !cfg.hasKey,
      database: !cfg.hasDatabase,
      container: !cfg.hasContainer,
    };

    context.log("[keywords-list] Cosmos config missing", {
      missing,
      cosmosModuleAvailable: Boolean(cosmos.cosmosModuleAvailable),
      effectiveDatabase: cfg.effectiveDatabase,
      effectiveContainer: cfg.effectiveContainer,
      hasClientError: Boolean(cosmos.clientError),
      hasContainerError: Boolean(cosmos.containerError),
    });

    if (!cosmos.cosmosModuleAvailable) {
      console.error("[keywords-list] @azure/cosmos unavailable; returning 503");
    }

    return {
      status: 503,
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
