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

// Helper: normalize domain from URL
const toNormalizedDomain = (s = "") => {
  try {
    const u = s.startsWith("http") ? new URL(s) : new URL(`https://${s}`);
    let h = u.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h || "unknown";
  } catch {
    return "unknown";
  }
};

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
        let whereClauses = [
          "(NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)"
        ];

        if (search) {
          parameters.push({ name: "@q", value: search });
          whereClauses.push(
            "(" +
            [
              "CONTAINS(LOWER(c.company_name), @q)",
              "CONTAINS(LOWER(c.name), @q)",
              "CONTAINS(LOWER(c.product_keywords), @q)",
              "CONTAINS(LOWER(c.normalized_domain), @q)",
            ].join(" OR ") +
            ")"
          );
        }

        const whereClause = whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : "";
        const sql = "SELECT TOP @take * FROM c " + whereClause + " ORDER BY c._ts DESC";

        const { resources } = await container.items
          .query({ query: sql, parameters }, { enableCrossPartitionQuery: true })
          .fetchAll();

        const items = resources || [];
        context.log("[admin-companies-v2] GET count after soft-delete filter:", items.length);
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

        // Compute normalized_domain for partition key (Cosmos DB partition key is /normalized_domain)
        const urlForDomain = incoming.canonical_url || incoming.url || incoming.website || "unknown";
        const normalizedDomain = incoming.normalized_domain || toNormalizedDomain(urlForDomain);

        if (!normalizedDomain) {
          return json({ error: "Unable to determine company domain for partition key" }, 400);
        }

        // Use normalized_domain as partition key value
        const partitionKeyValue = String(normalizedDomain).trim();

        const now = new Date().toISOString();
        const doc = {
          ...incoming,
          id: String(id).trim(),
          company_id: String(id).trim(),
          normalized_domain: normalizedDomain,
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

        const requestedId = String(id).trim();
        if (!requestedId) {
          return json({ error: "Invalid company ID" }, 400);
        }

        context.log(`[admin-companies-v2] DELETE: Deleting company with id:`, { id: requestedId });

        try {
          context.log("[admin-companies-v2] DELETE: Querying for document with id:", requestedId);
          const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @id",
            parameters: [{ name: "@id", value: requestedId }],
          };

          const queryResult = await container.items
            .query(querySpec, { enableCrossPartitionQuery: true })
            .fetchAll();

          const { resources } = queryResult;

          context.log("[admin-companies-v2] DELETE query result count:", resources.length);

          if (!resources || resources.length === 0) {
            context.log("[admin-companies-v2] DELETE no document found for id:", requestedId);
            return json({ error: "Company not found", id: requestedId }, 404);
          }

          let doc = resources[0];

          // CRITICAL: Extract partition key value directly from the retrieved document
          // The Cosmos DB container partition key is /normalized_domain
          const documentNormalizedDomain = doc.normalized_domain;

          if (!documentNormalizedDomain || String(documentNormalizedDomain).trim() === "") {
            context.log("[admin-companies-v2] DELETE ERROR: Document missing normalized_domain", {
              id: doc.id,
              company_name: doc.company_name,
              normalized_domain: documentNormalizedDomain,
              docKeys: Object.keys(doc).slice(0, 20)
            });
            return json({
              error: "Cannot delete company: missing partition key field (normalized_domain)",
              id: requestedId
            }, 500);
          }

          const partitionKeyValue = String(documentNormalizedDomain).trim();
          context.log("[admin-companies-v2] DELETE: Partition key extracted from document", {
            itemId: doc.id,
            partitionKeyValue: partitionKeyValue,
            typeOf: typeof partitionKeyValue,
            length: partitionKeyValue.length
          });

          const now = new Date().toISOString();
          const actor = (body && body.actor) || "admin_ui";

          const updatedDoc = {
            ...doc,
            is_deleted: true,
            deleted_at: now,
            deleted_by: actor
          };

          context.log("[admin-companies-v2] SOFT DELETE prepared:", {
            id: doc.id,
            company_id: doc.company_id,
            company_name: doc.company_name,
            is_deleted: updatedDoc.is_deleted,
            deleted_at: updatedDoc.deleted_at,
            deleted_by: updatedDoc.deleted_by,
            partitionKeyValue: partitionKeyValue,
            normalized_domain: doc.normalized_domain
          });

          try {
            context.log("[admin-companies-v2] SOFT DELETE attempting upsert with partition key:", {
              itemId: doc.id,
              partitionKeyValue: partitionKeyValue,
              docId: updatedDoc.id,
              updatedDocNormalizedDomain: updatedDoc.normalized_domain
            });

            const upsertResult = await container.items.upsert(updatedDoc, { partitionKey: partitionKeyValue });

            context.log(`[admin-companies-v2] DELETE soft-delete succeeded:`, {
              id: requestedId,
              itemId: doc.id,
              deletedAt: now,
              deletedBy: actor,
              statusCode: upsertResult?.statusCode,
              returnedId: upsertResult?.resource?.id,
              returnedIsDeleted: upsertResult?.resource?.is_deleted,
              returnedNormalizedDomain: upsertResult?.resource?.normalized_domain
            });
            return json({ ok: true, softDeleted: true }, 200);
          } catch (upsertError) {
            context.log("[admin-companies-v2] SOFT DELETE upsert with partition key failed:", {
              requestedId: requestedId,
              itemId: doc.id,
              partitionKeyValue: partitionKeyValue,
              code: upsertError?.code,
              statusCode: upsertError?.statusCode,
              message: upsertError?.message,
              errorBody: upsertError?.body
            });

            context.log("[admin-companies-v2] SOFT DELETE: Attempting direct item replace with partition key...");
            try {
              const itemRef = container.item(doc.id, partitionKeyValue);
              const replaceResult = await itemRef.replace(updatedDoc);

              context.log("[admin-companies-v2] SOFT DELETE direct replace succeeded:", {
                requestedId: requestedId,
                itemId: doc.id,
                partitionKeyValue: partitionKeyValue,
                statusCode: replaceResult?.statusCode,
                returnedId: replaceResult?.resource?.id,
                returnedIsDeleted: replaceResult?.resource?.is_deleted,
                returnedNormalizedDomain: replaceResult?.resource?.normalized_domain
              });
              return json({ ok: true, softDeleted: true }, 200);
            } catch (replaceError) {
              context.log("[admin-companies-v2] SOFT DELETE direct replace also failed:", {
                error: replaceError?.message,
                code: replaceError?.code,
                statusCode: replaceError?.statusCode
              });

              context.log("[admin-companies-v2] SOFT DELETE: Attempting fallback upsert without explicit partition key parameter...");
              try {
                const fallbackResult = await container.items.upsert(updatedDoc);

                context.log("[admin-companies-v2] SOFT DELETE fallback upsert succeeded:", {
                  requestedId: requestedId,
                  itemId: doc.id,
                  statusCode: fallbackResult?.statusCode,
                  returnedId: fallbackResult?.resource?.id,
                  returnedIsDeleted: fallbackResult?.resource?.is_deleted
                });
                return json({ ok: true, softDeleted: true }, 200);
              } catch (fallbackError) {
                context.log("[admin-companies-v2] SOFT DELETE all methods failed:", {
                  partitionKeyValue: partitionKeyValue,
                  upsertWithKeyError: upsertError?.message,
                  replaceError: replaceError?.message,
                  fallbackError: fallbackError?.message
                });
                throw upsertError;
              }
            }
          }
        } catch (e) {
          context.log("[admin-companies-v2] DELETE error:", {
            id: requestedId,
            code: e?.code,
            statusCode: e?.statusCode,
            message: e?.message,
            stack: e?.stack
          });

          if (e?.statusCode === 404) {
            return json({ error: "Company not found", id: requestedId }, 404);
          }

          return json({ error: "Failed to delete company", detail: e?.message }, 500);
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
