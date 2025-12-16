console.log("[keywords-list] Module loading started");
const { app } = require("@azure/functions");

let CosmosClientCtor = null;
function loadCosmosCtor() {
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

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
    },
    body: JSON.stringify(obj),
  };
}

function getCompaniesContainerInfo() {
  const endpoint = env("COSMOS_DB_ENDPOINT", "");
  const key = env("COSMOS_DB_KEY", "");

  const databaseEnvRaw = env("COSMOS_DB_DATABASE", "");
  const containerEnvRaw = env("COSMOS_DB_COMPANIES_CONTAINER", "");

  const database = env("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");

  const config = {
    hasEndpoint: Boolean(endpoint),
    hasKey: Boolean(key),
    hasDatabase: Boolean(databaseEnvRaw),
    hasContainer: Boolean(containerEnvRaw),
    effectiveDatabase: database,
    effectiveContainer: containerId,
  };

  const C = loadCosmosCtor();
  if (!C) {
    return { container: null, cosmosModuleAvailable: false, config };
  }

  if (!endpoint || !key || !databaseEnvRaw || !containerEnvRaw) {
    return { container: null, cosmosModuleAvailable: true, config };
  }

  try {
    const client = new C({ endpoint, key });
    return {
      container: client.database(database).container(containerId),
      cosmosModuleAvailable: true,
      config,
    };
  } catch (e) {
    console.error("[keywords-list] Failed to create Cosmos client", { error: e?.message });
    return { container: null, cosmosModuleAvailable: true, config, clientError: e?.message };
  }
}

async function keywordsListHandler(req, context) {
  context.log("keywords-list function invoked");

  const method = String(req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return json({}, 204);
  }

  const cosmos = getCompaniesContainerInfo();
  const container = cosmos.container;

  if (!container) {
    const cfg = cosmos.config || {};

    context.log("[keywords-list] Cosmos DB not configured", {
      hasEndpoint: Boolean(cfg.hasEndpoint),
      hasKey: Boolean(cfg.hasKey),
      hasDatabase: Boolean(cfg.hasDatabase),
      hasContainer: Boolean(cfg.hasContainer),
      cosmosModuleAvailable: Boolean(cosmos.cosmosModuleAvailable),
    });

    return json({ error: "Cosmos DB not configured" }, 503);
  }

  try {
    if (method === "GET") {
      try {
        context.log("[keywords-list] Reading industries document from Cosmos...");
        const { resource } = await container.item("industries", "industries").read();
        return json({ keywords: resource?.list || [] }, 200);
      } catch (e) {
        context.log("[keywords-list] Failed to read industries document (expected on first run)", { error: e?.message });
        return json({ keywords: [] }, 200);
      }
    }

    if (method === "PUT") {
      let body = {};

      try {
        try {
          body = await req.json();
        } catch (jsonErr) {
          const text = await req.text();
          if (text) body = JSON.parse(text);
        }
      } catch (e) {
        context.log("[keywords-list] JSON parse error on PUT", { error: e?.message });
        return json({ error: "Invalid JSON", detail: e?.message }, 400);
      }

      const keywords = Array.isArray(body.keywords) ? body.keywords : [];
      const docId = "industries";
      const doc = {
        id: docId,
        type: "industry",
        list: keywords
          .filter((k) => typeof k === "string" && k.trim())
          .map((k) => k.trim()),
        updated_at: new Date().toISOString(),
        actor: body.actor || null,
      };

      try {
        let result;
        try {
          result = await container.items.upsert(doc, { partitionKey: docId });
        } catch (upsertError) {
          context.log("[keywords-list] Upsert with partition key failed, retrying without...", { error: upsertError?.message });
          result = await container.items.upsert(doc);
        }

        return json({ ok: true, keywords: result?.resource?.list || doc.list }, 200);
      } catch (e) {
        context.log("[keywords-list] Upsert failed completely", { error: e?.message });
        return json({ error: "Failed to save keywords", detail: e?.message }, 500);
      }
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    context.log("[keywords-list] Unhandled error", { error: e?.message });
    return json({ error: e?.message || "Internal error" }, 500);
  }
}

console.log("[keywords-list] Registering with app.http...");
app.http("keywords-list", {
  route: "keywords-list",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  handler: keywordsListHandler,
});
console.log("[keywords-list] ✅ Successfully registered app.http with route: keywords-list");
