const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, DELETE, OPTIONS",
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

function getUndoContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = "undo_history";
  return client.database(databaseId).container(containerId);
}

app.http('adminUndoHistory', {
  route: 'admin-undo-history',
  methods: ['GET', 'DELETE', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return {
        status: 204,
        headers: getCorsHeaders(),
      };
    }

    const container = getUndoContainer();
    if (!container) {
      return json({ error: "Cosmos DB not configured" }, 500);
    }

    try {
      if (method === "GET") {
        const { resources } = await container.items
          .query({ query: "SELECT * FROM c ORDER BY c.created_at DESC" })
          .fetchAll();

        const history = resources.map(h => ({
          id: h.id,
          company_id: h.company_id,
          action_type: h.action_type,
          description: h.description,
          changed_fields: h.changed_fields || [],
          actor: h.actor,
          created_at: h.created_at,
          is_undone: h.is_undone || false,
        }));

        return json({ history }, 200);
      }

      if (method === "DELETE") {
        const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

        const { resources } = await container.items
          .query({
            query: "SELECT * FROM c WHERE c.created_at < @cutoff",
            parameters: [{ name: "@cutoff", value: fortyEightHoursAgo }],
          })
          .fetchAll();

        let deleted = 0;
        for (const item of resources) {
          await container.item(item.id, item.id).delete();
          deleted += 1;
        }

        return json({ ok: true, deleted }, 200);
      }

      return json({ error: "Method not allowed" }, 405);
    } catch (e) {
      context.log("Error in admin-undo-history:", e?.message || e);
      return json({ error: e?.message || "Internal error" }, 500);
    }
  }
});
