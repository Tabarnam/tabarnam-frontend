const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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

function getCompaniesContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_COMPANIES_CONTAINER", "companies");
  return client.database(databaseId).container(containerId);
}

function getUndoContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = "undo_history";
  return client.database(databaseId).container(containerId);
}

app.http("adminBatchUpdate", {
  route: "admin-batch-update",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return {
        status: 204,
        headers: getCorsHeaders(),
      };
    }

    const companiesContainer = getCompaniesContainer();
    const undoContainer = getUndoContainer();

    if (!companiesContainer) {
      return json({ error: "Cosmos DB not configured" }, 500);
    }

    try {
      let body = {};
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }

      const { field, value, companyIds, actor } = body;
      if (!field || !value || !Array.isArray(companyIds) || companyIds.length === 0) {
        return json({ error: "field, value, and companyIds required" }, 400);
      }

      let updated = 0;
      const now = new Date().toISOString();

      for (const id of companyIds) {
        try {
          const query = {
            query: "SELECT * FROM c WHERE c.id = @id",
            parameters: [{ name: "@id", value: id }],
          };
          const { resources } = await companiesContainer.items
            .query(query, { enableCrossPartitionQuery: true })
            .fetchAll();

          if (resources && resources.length > 0) {
            const existing = resources[0];
            const oldValue = existing[field];
            existing[field] = field === "star_rating" ? Number(value) : value;
            existing.updated_at = now;

            await companiesContainer.items.upsert(existing);

            if (undoContainer) {
              const historyDoc = {
                id: `undo_batch_${id}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                company_id: id,
                action_type: "update",
                description: `Batch update: ${field} = ${value}`,
                changed_fields: [field],
                old_doc: { ...existing, [field]: oldValue },
                new_doc: existing,
                actor: actor || null,
                created_at: now,
                is_undone: false,
              };
              await undoContainer.items.create(historyDoc);
            }

            updated += 1;
          }
        } catch (e) {
          console.warn(`Failed to update company ${id}:`, e?.message);
        }
      }

      return json({ ok: true, updated }, 200);
    } catch (e) {
      context.log("Error in admin-batch-update:", e?.message || e);
      return json({ error: e?.message || "Internal error" }, 500);
    }
  },
});
