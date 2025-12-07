const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

const json = (obj, status = 200) => ({
  status,
  headers: getCorsHeaders(),
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

function getConfigContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = "star_config";
  return client.database(databaseId).container(containerId);
}

const DEFAULT_CONFIG = {
  id: "default",
  hq_weight: 1,
  manufacturing_weight: 1,
  review_threshold: 4,
  min_reviews: 3,
};

app.http('adminStarConfig', {
  route: 'xadmin-api-star-config',
  methods: ['GET', 'PUT', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (req, context) => {
  const method = String(req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return {
      status: 204,
      headers: getCorsHeaders(),
    };
  }

  const container = getConfigContainer();
  if (!container) {
    return json({ error: "Cosmos DB not configured" }, 500);
  }

  try {
    if (method === "GET") {
      try {
        const { resource } = await container.item("default", "default").read();
        return json({ config: resource }, 200);
      } catch (e) {
        return json({ config: DEFAULT_CONFIG }, 200);
      }
    }

    if (method === "PUT") {
      let body = {};
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }

      const incoming = body.config || body;
      if (!incoming) {
        return json({ error: "config required" }, 400);
      }

      const config = {
        id: "default",
        hq_weight: Number(incoming.hq_weight ?? 1),
        manufacturing_weight: Number(incoming.manufacturing_weight ?? 1),
        review_threshold: Number(incoming.review_threshold ?? 4),
        min_reviews: Number(incoming.min_reviews ?? 3),
        updated_at: new Date().toISOString(),
        actor: body.actor || null,
      };

      await container.items.upsert(config);
      return json({ ok: true, config }, 200);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    context.log("Error in admin-star-config:", e?.message || e);
    return json({ error: e?.message || "Internal error" }, 500);
  }
  }
});
