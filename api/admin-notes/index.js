const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

function getHeader(req, name) {
  if (!req || !req.headers) return "";
  const headers = req.headers;
  if (typeof headers.get === "function") {
    try {
      return headers.get(name) || headers.get(name.toLowerCase()) || "";
    } catch {
      return "";
    }
  }
  return headers[name] || headers[name.toLowerCase()] || "";
}

const cors = (req) => {
  const origin = getHeader(req, "origin") || "*";
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

async function getJson(req) {
  if (!req) return {};
  if (typeof req.json === "function") {
    try {
      const val = await req.json();
      if (val && typeof val === "object") return val;
    } catch {}
  }
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.rawBody === "string" && req.rawBody) {
    try {
      const parsed = JSON.parse(req.rawBody);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return {};
}

app.http('adminNotes', {
  route: 'xadmin-api-notes',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  authLevel: 'anonymous',
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

        const queryText = isPublic
          ? "SELECT * FROM c WHERE c.company_id = @companyId AND (NOT IS_DEFINED(c.is_public) OR c.is_public = true) ORDER BY c.created_at DESC"
          : "SELECT * FROM c WHERE c.company_id = @companyId ORDER BY c.created_at DESC";

        const query = {
          query: queryText,
          parameters: [{ name: "@companyId", value: companyId }],
        };

        const { resources } = await container.items
          .query(query, { enableCrossPartitionQuery: true })
          .fetchAll();

        return json({ items: resources || [] }, 200, req);
      }

      if (method === "POST" || method === "PUT") {
        const body = await getJson(req);

        const note = body.note || body;
        if (!note || !note.company_id) {
          return json({ error: "note.company_id required" }, 400, req);
        }

        const now = new Date().toISOString();
        const id =
          note.id ||
          `note_${note.company_id}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

        const doc = {
          id,
          company_id: note.company_id,
          text: note.text || "",
          is_public: isPublic ? Boolean(note.is_public ?? true) : Boolean(note.is_public ?? false),
          created_at: note.created_at || now,
          updated_at: now,
          actor: note.actor || null,
        };

        await container.items.upsert(doc);
        return json({ ok: true, note: doc }, method === "POST" ? 201 : 200, req);
      }

      if (method === "DELETE") {
        const body = await getJson(req);

        const id = body.id;
        const companyIdBody = body.company_id;
        if (!id || !companyIdBody) {
          return json({ error: "id and company_id required" }, 400, req);
        }

        try {
          await container.item(id, companyIdBody).delete();
        } catch (e) {
          if (context && typeof context.log === "function") {
            context.log("Failed to delete note", e?.message || e);
          }
        }

        return json({ ok: true }, 200, req);
      }

      return json({ error: "Method not allowed" }, 405, req);
    } catch (e) {
      if (context && typeof context.log === "function") {
        context.log("Error in admin-notes:", e?.message || e);
      }
      return json({ error: e?.message || "Internal error" }, 500, req);
    }
  }
});
