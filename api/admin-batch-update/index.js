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
  cosmosClient ||= require("../_cosmosConfig").getCosmosClient();
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

async function adminBatchUpdateHandler(req, context) {
  const method = String(req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return {
      status: 200,
      headers: getCorsHeaders(),
    };
  }

  // ── Admin auth gate ──────────────────────────────────────────
  const { adminGuard } = require("../_adminAuth");
  const authError = adminGuard(req, context);
  if (authError) return authError;
  // ─────────────────────────────────────────────────────────────

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

    const { field, value, companyIds, actor, operation } = body;
    if (!field || value === undefined || !Array.isArray(companyIds) || companyIds.length === 0) {
      return json({ error: "field, value, and companyIds required" }, 400);
    }

    const op = String(operation || "set").trim();

    // Attribution fields store lowercased emails; normalize so the dashboard
    // filter's equality WHERE matches whatever a batch assign wrote.
    const normalizedValue =
      (field === "owner" || field === "imported_by") && typeof value === "string"
        ? value.trim().toLowerCase()
        : value;

    // Acting admin for the per-company edit-history entries. Prefer the
    // server-trusted identity from adminGuard over the client-supplied label.
    const actorEmail = String((req && req.__admin_email) || actor || "").trim().toLowerCase();
    // One batch_id across all entries so the Recent Activity feed can fold the
    // N per-company rows rather than flooding (same convention as bulk import).
    const batchId = `batch_update_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let historyWriter = null;
    try {
      historyWriter = require("../_companyEditHistory").writeCompanyEditHistoryEntry;
    } catch {
      historyWriter = null;
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

          if (op === "remove_from_array") {
            // Remove a value from an array field (case-insensitive match)
            if (Array.isArray(existing[field])) {
              const valLower = String(normalizedValue).toLowerCase();
              existing[field] = existing[field].filter((item) => String(item).toLowerCase() !== valLower);
            }
          } else if (op === "add_to_array") {
            // Add a value to an array field (skip if already present, case-insensitive)
            if (!Array.isArray(existing[field])) existing[field] = [];
            const valLower = String(normalizedValue).toLowerCase();
            if (!existing[field].some((item) => String(item).toLowerCase() === valLower)) {
              existing[field].push(normalizedValue);
            }
          } else {
            // Default: set the field to the value
            existing[field] = field === "star_rating" ? Number(normalizedValue) : normalizedValue;
          }

          existing.updated_at = now;

          const partitionKeyValue = String(existing.normalized_domain || "unknown").trim();
          await companiesContainer.items.upsert(existing, { partitionKey: partitionKeyValue });

          if (undoContainer) {
            const historyDoc = {
              id: `undo_batch_${id}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
              company_id: id,
              action_type: "update",
              description: op === "remove_from_array" ? `Batch remove "${value}" from ${field}` : op === "add_to_array" ? `Batch add "${value}" to ${field}` : `Batch update: ${field} = ${value}`,
              changed_fields: [field],
              old_doc: { ...existing, [field]: oldValue },
              new_doc: existing,
              actor: actor || null,
              created_at: now,
              is_undone: false,
            };
            await undoContainer.items.create(historyDoc);
          }

          // Per-company edit-history entry so the change (e.g. an owner
          // reassignment) shows on the company's Edit History page, attributed
          // to the acting admin. batch_id keeps the global feed to one summary.
          if (historyWriter) {
            try {
              await historyWriter({
                company_id: id,
                before: { ...existing, [field]: oldValue },
                after: existing,
                action: "update",
                source: "admin-batch-update",
                actor_email: actorEmail || undefined,
                batch_id: batchId,
              });
            } catch { /* history is best-effort; the update itself succeeded */ }
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
}

app.http('adminBatchUpdate', {
  route: 'xadmin-api-batch-update',
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: adminBatchUpdateHandler,
});

module.exports = { handler: adminBatchUpdateHandler };
