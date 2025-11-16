import { app } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

const cors = (req) => {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

function getUndoContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_UNDO_CONTAINER", "undo_history");
  return client.database(databaseId).container(containerId);
}

function getCompaniesContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_COMPANIES_CONTAINER", "companies");
  return client.database(databaseId).container(containerId);
}

app.http("adminUndoHistory", {
  route: "admin/undo-history",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return { status: 204, headers: cors(req) };
    }

    const undoContainer = getUndoContainer();
    if (!undoContainer) {
      return json({ error: "Cosmos DB not configured" }, 500, req);
    }

    try {
      if (method === "GET") {
        const url = new URL(req.url);
        const companyId = (url.searchParams.get("company_id") || "").trim();
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || "100")));

        const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

        const parameters = [
          { name: "@cutoff", value: cutoff },
        ];

        let where = "WHERE c.created_at >= @cutoff";
        if (companyId) {
          where += " AND c.company_id = @companyId";
          parameters.push({ name: "@companyId", value: companyId });
        }

        const query = {
          query: `SELECT TOP @limit * FROM c ${where} ORDER BY c.created_at DESC`,
          parameters: [
            ...parameters,
            { name: "@limit", value: limit },
          ],
        };

        const { resources } = await undoContainer.items
          .query(query, { enableCrossPartitionQuery: true })
          .fetchAll();

        return json({ items: resources || [] }, 200, req);
      }

      if (method === "POST") {
        let body = {};
        try {
          body = await req.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400, req);
        }

        const ids = Array.isArray(body.action_ids) ? body.action_ids : [];
        if (!ids.length) {
          return json({ error: "action_ids array required" }, 400, req);
        }

        const companiesContainer = getCompaniesContainer();
        if (!companiesContainer) {
          return json({ error: "Companies container not configured" }, 500, req);
        }

        const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

        let undone = 0;
        let skipped = 0;

        for (const id of ids) {
          try {
            const query = {
              query: "SELECT * FROM c WHERE c.id = @id AND c.created_at >= @cutoff",
              parameters: [
                { name: "@id", value: id },
                { name: "@cutoff", value: cutoff },
              ],
            };
            const { resources } = await undoContainer.items
              .query(query, { enableCrossPartitionQuery: true })
              .fetchAll();

            if (!resources || resources.length === 0) {
              skipped += 1;
              continue;
            }

            const action = resources[0];
            if (action.is_undone) {
              skipped += 1;
              continue;
            }

            const companyId = action.company_id;
            const oldDoc = action.old_doc;
            const newDoc = action.new_doc;

            if (!companyId) {
              skipped += 1;
              continue;
            }

            if (action.action_type === "create") {
              if (newDoc && typeof newDoc === "object") {
                const softDeleted = {
                  ...newDoc,
                  is_deleted: true,
                  deleted_at: new Date().toISOString(),
                };
                await companiesContainer.items.upsert(softDeleted);
              }
            } else if (oldDoc && typeof oldDoc === "object") {
              const restored = {
                ...oldDoc,
                updated_at: new Date().toISOString(),
              };
              await companiesContainer.items.upsert(restored);
            } else {
              skipped += 1;
              continue;
            }

            action.is_undone = true;
            action.undone_at = new Date().toISOString();
            await undoContainer.items.upsert(action);
            undone += 1;
          } catch (e) {
            context.log("Failed to undo action", id, e?.message || e);
            skipped += 1;
          }
        }

        return json({ ok: true, undone, skipped }, 200, req);
      }

      return json({ error: "Method not allowed" }, 405, req);
    } catch (e) {
      context.log("Error in admin-undo-history:", e?.message || e);
      return json({ error: e?.message || "Internal error" }, 500, req);
    }
  },
});
