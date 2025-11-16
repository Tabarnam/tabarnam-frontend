import { app } from "@azure/functions";
import { app } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

const cors = (req) => {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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

function getNotesContainer(publicNotes) {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const envKey = publicNotes ? "COSMOS_DB_NOTES_CONTAINER" : "COSMOS_DB_NOTES_ADMIN_CONTAINER";
  const defaultName = publicNotes ? "notes" : "notes_admin";
  const containerId = E(envKey, defaultName);
  return client.database(databaseId).container(containerId);
}

app.http("adminNotes", {
  route: "admin/notes",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return { status: 204, headers: cors(req) };
    }

    const url = new URL(req.url);
    const companyId = (url.searchParams.get("company_id") || "").trim();
    const kind = (url.searchParams.get("kind") || "public").toLowerCase();
    const isPublic = kind !== "admin";

    const container = getNotesContainer(isPublic);
    if (!container) {
      return json({ error: "Cosmos DB not configured" }, 500, req);
    }

    try {
      if (method === "GET") {
        if (!companyId) {
          return json({ error: "company_id required" }, 400, req);
        }

        const query = {
          query: "SELECT * FROM c WHERE c.company_id = @companyId ORDER BY c.created_at DESC",
          parameters: [{ name: "@companyId", value: companyId }],
        };

        const { resources } = await container.items
          .query(query, { enableCrossPartitionQuery: true })
          .fetchAll();

        return json({ items: resources || [] }, 200, req);
      }

      if (method === "POST" || method === "PUT") {
        let body = {};
        try {
          body = await req.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400, req);
        }

        const note = body.note || body;
        if (!note || !note.company_id) {
          return json({ error: "note.company_id required" }, 400, req);
        }

        const now = new Date().toISOString();
        const id = note.id || `note_${note.company_id}_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2)}`;

        const doc = {
          id,
          company_id: note.company_id,
          text: note.text || "",
          is_public: isPublic ? Boolean(note.is_public ?? true) : false,
          created_at: note.created_at || now,
          updated_at: now,
          actor: note.actor || null,
        };

        await container.items.upsert(doc);
        return json({ ok: true, note: doc }, method === "POST" ? 201 : 200, req);
      }

      if (method === "DELETE") {
        let body = {};
        try {
          body = await req.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400, req);
        }

        const id = body.id;
        const companyIdBody = body.company_id;
        if (!id || !companyIdBody) {
          return json({ error: "id and company_id required" }, 400, req);
        }

        try {
          await container.item(id, companyIdBody).delete();
        } catch (e) {
          context.log("Failed to delete note", e?.message || e);
        }

        return json({ ok: true }, 200, req);
      }

      return json({ error: "Method not allowed" }, 405, req);
    } catch (e) {
      context.log("Error in admin-notes:", e?.message || e);
      return json({ error: e?.message || "Internal error" }, 500, req);
    }
  },
});
