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

module.exports = async function (context, req) {
  context.log("admin-companies function invoked");
  
  const method = (req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    context.res = {
      status: 204,
      headers: getCorsHeaders(),
    };
    return;
  }

  const container = getCompaniesContainer();
  if (!container) {
    context.res = {
      status: 503,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: "Cosmos DB not configured" }),
    };
    return;
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
      context.res = {
        status: 200,
        headers: getCorsHeaders(),
        body: JSON.stringify({ items, count: items.length }),
      };
      return;
    }

    if (method === "POST" || method === "PUT") {
      let body = {};
      try {
        body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      } catch (e) {
        context.res = {
          status: 400,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "Invalid JSON", detail: e?.message }),
        };
        return;
      }

      const incoming = body.company || body;
      if (!incoming) {
        context.res = {
          status: 400,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "company payload required" }),
        };
        return;
      }

      let id = incoming.id || incoming.company_id || incoming.company_name;
      if (!id) {
        id = `company_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      }

      const partitionKeyValue = String(id).trim();
      if (!partitionKeyValue) {
        context.res = {
          status: 400,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "Unable to determine company ID" }),
        };
        return;
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
        context.res = {
          status: 200,
          headers: getCorsHeaders(),
          body: JSON.stringify({ ok: true, company: doc }),
        };
        return;
      } catch (e) {
        context.log("[admin-companies] Upsert failed completely", { id: partitionKeyValue, message: e?.message });
        context.res = {
          status: 500,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "Failed to save company", detail: e?.message }),
        };
        return;
      }
    }

    if (method === "DELETE") {
      let body = {};
      try {
        body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      } catch {
        context.res = {
          status: 400,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "Invalid JSON" }),
        };
        return;
      }

      const id = body.id || body.company_id;
      if (!id) {
        context.res = {
          status: 400,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "id required" }),
        };
        return;
      }

      const partitionKeyValue = String(id).trim();
      if (!partitionKeyValue) {
        context.res = {
          status: 400,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "Invalid company ID" }),
        };
        return;
      }

      context.log(`[admin-companies] Deleting company:`, { id: partitionKeyValue });

      try {
        await container.item(partitionKeyValue, partitionKeyValue).delete();
        context.log(`[admin-companies] Delete success:`, { id: partitionKeyValue });
        context.res = {
          status: 200,
          headers: getCorsHeaders(),
          body: JSON.stringify({ ok: true }),
        };
        return;
      } catch (e) {
        context.log("[admin-companies] Delete error:", { id: partitionKeyValue, error: e?.message });
        context.res = {
          status: 404,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: "Company not found", detail: e?.message }),
        };
        return;
      }
    }

    context.res = {
      status: 405,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  } catch (e) {
    context.log("[admin-companies] Error:", e?.message || e);
    context.res = {
      status: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: e?.message || "Internal error" }),
    };
  }
};
