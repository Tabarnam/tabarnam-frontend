const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function getCorsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
  };
}

let cosmosClient = null;

function getCosmosClient() {
  const endpoint = env("COSMOS_DB_ENDPOINT", "");
  const key = env("COSMOS_DB_KEY", "");
  if (!endpoint || !key) return null;
  cosmosClient ||= new CosmosClient({ endpoint, key });
  return cosmosClient;
}

function getCompaniesContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const database = env("COSMOS_DB_DATABASE", "tabarnam-db");
  const container = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");
  return client.database(database).container(container);
}

async function adminCompaniesHandler(request, context) {
  context.log("admin-companies function invoked");

  const method = (request.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return {
      status: 204,
      headers: getCorsHeaders(),
    };
  }

  const container = getCompaniesContainer();
  if (!container) {
    return {
      status: 503,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: "Cosmos DB not configured" }),
    };
  }

  try {
    if (method === "GET") {
      const search = (request.query?.search || "").toString().toLowerCase().trim();
      const take = Math.min(500, Math.max(1, parseInt((request.query?.take || "200").toString())));

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
      return {
        status: 200,
        headers: getCorsHeaders(),
        body: JSON.stringify({ items, count: items.length }),
      };
    }

    if (method === "POST" || method === "PUT") {
      let body = {};
      try {
        body = typeof request.body === "string" ? JSON.parse(request.body) : (request.body || {});
      } catch (e) {
        return {
          status: 400,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "Invalid JSON", detail: e?.message }),
        };
      }

      const incoming = body.company || body;
      if (!incoming) {
        return {
          status: 400,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "company payload required" }),
        };
      }

      let id = incoming.id || incoming.company_id || incoming.company_name;
      if (!id) {
        id = `company_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      }

      const partitionKeyValue = String(id).trim();
      if (!partitionKeyValue) {
        return {
          status: 400,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "Unable to determine company ID" }),
        };
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

      context.log(`[admin-companies] Upserting company`, { id: partitionKeyValue, method, company_name: doc.company_name });

      try {
        let result;
        try {
          result = await container.items.upsert(doc, { partitionKey: partitionKeyValue });
        } catch (upsertError) {
          context.log(`[admin-companies] First upsert attempt failed, retrying without partition key`, { error: upsertError?.message });
          result = await container.items.upsert(doc);
        }
        context.log(`[admin-companies] Upsert completed successfully`, { id: partitionKeyValue, statusCode: result.statusCode });
        return {
          status: 200,
          headers: getCorsHeaders(),
          body: JSON.stringify({ ok: true, company: doc }),
        };
      } catch (e) {
        context.log("[admin-companies] Upsert failed completely", { id: partitionKeyValue, message: e?.message });
        return {
          status: 500,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "Failed to save company", detail: e?.message }),
        };
      }
    }

    if (method === "DELETE") {
      let body = {};
      try {
        body = typeof request.body === "string" ? JSON.parse(request.body) : (request.body || {});
      } catch {
        return {
          status: 400,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "Invalid JSON" }),
        };
      }

      const id = body.id || body.company_id;
      if (!id) {
        return {
          status: 400,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "id required" }),
        };
      }

      const partitionKeyValue = String(id).trim();
      if (!partitionKeyValue) {
        return {
          status: 400,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "Invalid company ID" }),
        };
      }

      context.log(`[admin-companies] Deleting company:`, { id: partitionKeyValue });

      try {
        await container.item(partitionKeyValue, partitionKeyValue).delete();
        context.log(`[admin-companies] Delete success:`, { id: partitionKeyValue });
        return {
          status: 200,
          headers: getCorsHeaders(),
          body: JSON.stringify({ ok: true }),
        };
      } catch (e) {
        context.log("[admin-companies] Delete error:", { id: partitionKeyValue, error: e?.message });
        return {
          status: 404,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "Company not found", detail: e?.message }),
        };
      }
    }

    return {
      status: 405,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  } catch (e) {
    context.log("[admin-companies] Error:", e?.message || e);
    return {
      status: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: e?.message || "Internal error" }),
    };
  }
}

app.http('admin-companies', {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'admin-companies',
  handler: adminCompaniesHandler,
});
