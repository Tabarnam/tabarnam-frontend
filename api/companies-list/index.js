// Companies list API endpoint - v4 modern runtime with app.http()
console.log("[companies-list] Starting module load...");
const { app } = require("@azure/functions");
const axios = require("axios");
console.log("[companies-list] @azure/functions imported, app object created");

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
    console.error("[companies-list] Failed to create Cosmos client:", e?.message);
    return null;
  }
}

// Helper: geocode a headquarters location string to get lat/lng
async function geocodeHQLocation(headquarters_location) {
  if (!headquarters_location || headquarters_location.trim() === "") {
    return { hq_lat: undefined, hq_lng: undefined };
  }

  try {
    const proxyBase = (process.env.XAI_EXTERNAL_BASE || process.env.XAI_PROXY_BASE || "").trim();
    const baseUrl = proxyBase ? `${proxyBase.replace(/\/api$/, '')}/api` : '/api';

    const geocodeUrl = `${baseUrl}/google/geocode`;

    const response = await axios.post(geocodeUrl,
      {
        address: headquarters_location,
        ipLookup: false
      },
      {
        timeout: 5000,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    if (response.data && response.data.best && response.data.best.location) {
      const { lat, lng } = response.data.best.location;
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return { hq_lat: lat, hq_lng: lng };
      }
    }
  } catch (e) {
    console.log(`[companies-list] Geocoding failed for "${headquarters_location}": ${e.message}`);
  }

  return { hq_lat: undefined, hq_lng: undefined };
}

console.log("[companies-list] About to register app.http handler...");

app.http("companiesList", {
  route: "companies-list",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    console.log("[companies-list-handler] Request received:", { method: req.method, url: req.url });
    context.log("companies-list function invoked");

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

        context.log(`[companies-list] Upserting company:`, { id: partitionKeyValue, method, nameCheck: doc.company_name });

        try {
          // Cosmos DB upsert with explicit partition key
          // The partition key value must match the document's partition key field
          context.log(`[companies-list] Upserting document`, {
            id: partitionKeyValue,
            company_name: doc.company_name,
            method: method
          });

          // Try with the id as partition key (most common case)
          let result;
          try {
            result = await container.items.upsert(doc, { partitionKey: partitionKeyValue });
          } catch (upsertError) {
            // If that fails, try without explicit partition key
            context.log(`[companies-list] First upsert attempt failed, retrying without partition key option`, {
              error: upsertError?.message
            });
            result = await container.items.upsert(doc);
          }

          context.log(`[companies-list] Upsert completed successfully`, {
            id: partitionKeyValue,
            statusCode: result.statusCode,
            resourceId: result.resource?.id
          });
          return json({ ok: true, company: doc }, 200);
        } catch (e) {
          context.log("[companies-list] Upsert failed completely", {
            id: partitionKeyValue,
            message: e?.message,
            code: e?.code,
            statusCode: e?.statusCode
          });
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

        context.log(`[companies-list] Deleting company:`, { id: partitionKeyValue });

        try {
          await container.item(partitionKeyValue, partitionKeyValue).delete();
          context.log(`[companies-list] Delete success:`, { id: partitionKeyValue });
          return json({ ok: true }, 200);
        } catch (e) {
          context.log("[companies-list] Delete error:", { id: partitionKeyValue, error: e?.message });
          return json({ error: "Company not found", detail: e?.message }, 404);
        }
      }

      return json({ error: "Method not allowed" }, 405);
    } catch (e) {
      context.log("[companies-list] Error:", e?.message || e);
      return json({ error: e?.message || "Internal error" }, 500);
    }
  },
});

console.log("[companies-list] ✅ Handler registered successfully with app.http");
