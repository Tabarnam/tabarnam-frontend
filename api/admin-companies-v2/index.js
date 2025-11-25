// Admin companies v2 API endpoint - diagnostic test function
// Same logic as admin-companies but on route admin-companies-v2
// Purpose: Test if SWA has a stale route mapping preventing admin-companies from being surfaced
console.log("[admin-companies-v2] Starting module load...");
const { app } = require("@azure/functions");
console.log("[admin-companies-v2] @azure/functions imported, app object created");

let CosmosClientCtor = null;
function loadCosmosCtor() {
  if (CosmosClientCtor !== null) return CosmosClientCtor;
  try {
    CosmosClientCtor = require("@azure/cosmos").CosmosClient;
  } catch {
    CosmosClientCtor = undefined;
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

function getCompaniesContainer() {
  const endpoint = env("COSMOS_DB_ENDPOINT", "");
  const key = env("COSMOS_DB_KEY", "");
  const database = env("COSMOS_DB_DATABASE", "tabarnam-db");
  const container = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");

  if (!endpoint || !key) return null;

  const C = loadCosmosCtor();
  if (!C) return null;

  try {
    const client = new C({ endpoint, key });
    return client.database(database).container(container);
  } catch (e) {
    console.error("[admin-companies-v2] Failed to create Cosmos client:", e?.message);
    return null;
  }
}

console.log("[admin-companies-v2] About to register app.http handler...");

app.http("adminCompaniesV2", {
  route: "admin-companies-v2",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    console.log("[admin-companies-v2-handler] Request received:", { method: req.method, url: req.url });
    context.log("admin-companies-v2 function invoked");

    const method = (req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return json({}, 204);
    }

    const container = getCompaniesContainer();
    if (!container) {
      return json({ error: "Cosmos DB not configured" }, 503);
    }

    try {
      if (method === "GET") {
        const search = (req.query?.search || "").toString().toLowerCase().trim();
        const take = Math.min(500, Math.max(1, parseInt((req.query?.take || "200").toString())));

        const parameters = [{ name: "@take", value: take }];
        let whereClause = "";

        if (search) {
          parameters.push({ name: "@q", value: search });
          whereClause =
            "WHERE (" +
            [
              "CONTAINS(LOWER(c.company_name), @q)",
              "CONTAINS(LOWER(c.name), @q)",
              "CONTAINS(LOWER(c.product_keywords), @q)",
              "CONTAINS(LOWER(c.normalized_domain), @q)",
            ].join(" OR ") +
            ")";
        }

        const sql = "SELECT TOP @take * FROM c " + whereClause + " ORDER BY c._ts DESC";

        const { resources } = await container.items
          .query({ query: sql, parameters }, { enableCrossPartitionQuery: true })
          .fetchAll();

        const items = resources || [];
        return json({ items, count: items.length }, 200);
      }

      if (method === "POST" || method === "PUT") {
        let body = {};
        try {
          body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
        } catch (e) {
          return json({ error: "Invalid JSON", detail: e?.message }, 400);
        }

        const incoming = body.company || body;
        if (!incoming) {
          return json({ error: "company payload required" }, 400);
        }

        let id = incoming.id || incoming.company_id || incoming.company_name;
        if (!id) {
          id = `company_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        }

        // Ensure id is a string for partition key
        const partitionKeyValue = String(id).trim();
        if (!partitionKeyValue) {
          return json({ error: "Unable to determine company ID" }, 400);
        }

        const now = new Date().toISOString();
        const doc = {
          ...incoming,
          id: partitionKeyValue,
          company_id: partitionKeyValue,
          company_name: incoming.company_name || incoming.name || "",
          name: incoming.name || incoming.company_name || "",
          updated_at: now,
          created_at: incoming.created_at || now,
        };

        context.log(`[admin-companies-v2] Upserting company`, { id: partitionKeyValue, method, company_name: doc.company_name });

        try {
          let result;
          try {
            result = await container.items.upsert(doc, { partitionKey: partitionKeyValue });
          } catch (upsertError) {
            context.log(`[admin-companies-v2] First upsert attempt failed, retrying without partition key`, { error: upsertError?.message });
            result = await container.items.upsert(doc);
          }
          context.log(`[admin-companies-v2] Upsert completed successfully`, { id: partitionKeyValue, statusCode: result.statusCode, resourceId: result.resource?.id });
          return json({ ok: true, company: doc }, 200);
        } catch (e) {
          context.log("[admin-companies-v2] Upsert failed completely", { id: partitionKeyValue, message: e?.message, code: e?.code, statusCode: e?.statusCode });
          return json({ error: "Failed to save company", detail: e?.message }, 500);
        }
      }

      if (method === "DELETE") {
        let body = {};
        try {
          body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        const id = body.id || body.company_id;
        if (!id) {
          return json({ error: "id required" }, 400);
        }

        const partitionKeyValue = String(id).trim();
        if (!partitionKeyValue) {
          return json({ error: "Invalid company ID" }, 400);
        }

        context.log(`[admin-companies-v2] Deleting company:`, { id: partitionKeyValue });

        try {
          await container.item(partitionKeyValue, partitionKeyValue).delete();
          context.log(`[admin-companies-v2] Delete success:`, { id: partitionKeyValue });
          return json({ ok: true }, 200);
        } catch (e) {
          context.log("[admin-companies-v2] Delete error:", { id: partitionKeyValue, error: e?.message });
          return json({ error: "Company not found", detail: e?.message }, 404);
        }
      }

      return json({ error: "Method not allowed" }, 405);
    } catch (e) {
      context.log("[admin-companies-v2] Error:", e?.message || e);
      return json({ error: e?.message || "Internal error" }, 500);
    }
  },
});

console.log("[admin-companies-v2] ✅ Handler registered successfully with app.http");
