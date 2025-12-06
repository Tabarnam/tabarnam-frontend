const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

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

app.http('adminUndo', {
  route: 'admin-api-undo',
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
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

    if (!companiesContainer || !undoContainer) {
      return json({ error: "Cosmos DB not configured" }, 500);
    }

    try {
      let body = {};
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }

      const { id } = body;
      if (!id) {
        return json({ error: "id required" }, 400);
      }

      const historyRecord = await undoContainer.item(id, id).read().then(r => r.resource).catch(() => null);
      if (!historyRecord) {
        return json({ error: "History record not found" }, 404);
      }

      if (historyRecord.is_undone) {
        return json({ error: "Already undone" }, 400);
      }

      if (historyRecord.action_type === "delete" && historyRecord.old_doc) {
        const partitionKeyValue = String(historyRecord.old_doc.normalized_domain || "unknown").trim();
        await companiesContainer.items.upsert(historyRecord.old_doc, { partitionKey: partitionKeyValue });
      } else if (historyRecord.action_type === "update" && historyRecord.old_doc) {
        const partitionKeyValue = String(historyRecord.old_doc.normalized_domain || "unknown").trim();
        await companiesContainer.items.upsert(historyRecord.old_doc, { partitionKey: partitionKeyValue });
      } else if (historyRecord.action_type === "create") {
        try {
          const partitionKeyValue = String(historyRecord.old_doc?.normalized_domain || "unknown").trim();
          await companiesContainer.item(historyRecord.company_id, partitionKeyValue).delete();
        } catch (e) {
          console.warn("Could not delete company for undo:", e?.message);
        }
      }

      historyRecord.is_undone = true;
      historyRecord.undone_at = new Date().toISOString();
      historyRecord.undone_by = body.actor || null;
      await undoContainer.items.upsert(historyRecord);

      return json({ ok: true, message: "Action undone" }, 200);
    } catch (e) {
      context.log("Error in admin-undo:", e?.message || e);
      return json({ error: e?.message || "Internal error" }, 500);
    }
  }
});
