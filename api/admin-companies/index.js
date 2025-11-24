const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");

function env(key, defaultValue = "") {
  const val = process.env[key];
  return val ? String(val).trim() : defaultValue;
}

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

function getCompaniesContainer() {
  const endpoint = env("COSMOS_DB_ENDPOINT");
  const key = env("COSMOS_DB_KEY");
  const database = env("COSMOS_DB_DATABASE", "tabarnam-db");
  const container = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");

  if (!endpoint || !key) {
    return null;
  }

  try {
    const client = new CosmosClient({ endpoint, key });
    return client.database(database).container(container);
  } catch (e) {
    console.error("[admin-companies] Failed to create Cosmos client:", e?.message);
    return null;
  }
}

app.http("adminCompanies", {
  route: "admin-companies",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const method = (req.method || "").toUpperCase();

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
        const url = new URL(req.url);
        const search = (url.searchParams.get("search") || "").toLowerCase().trim();
        const take = Math.min(500, Math.max(1, parseInt(url.searchParams.get("take") || "200")));

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
          body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
        } catch {
          return {
            status: 400,
            headers: getCorsHeaders(),
            body: JSON.stringify({ error: "Invalid JSON" }),
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

        const now = new Date().toISOString();
        const doc = {
          ...incoming,
          id,
          company_name: incoming.company_name || incoming.name || "",
          name: incoming.name || incoming.company_name || "",
          updated_at: now,
          created_at: incoming.created_at || now,
        };

        await container.items.upsert(doc);

        return {
          status: 200,
          headers: getCorsHeaders(),
          body: JSON.stringify({ ok: true, company: doc }),
        };
      }

      if (method === "DELETE") {
        let body = {};
        try {
          body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
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

        try {
          await container.item(id).delete();
          return {
            status: 200,
            headers: getCorsHeaders(),
            body: JSON.stringify({ ok: true }),
          };
        } catch (e) {
          return {
            status: 404,
            headers: getCorsHeaders(),
            body: JSON.stringify({ error: "Company not found" }),
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
  },
});
