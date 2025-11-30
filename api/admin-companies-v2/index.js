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

          let pkPaths = undefined;
          let pkFieldName = null;

          try {
            const containerResponse = await container.read();
            const containerDef = containerResponse.resource;
            pkPaths = containerDef && containerDef.partitionKey && containerDef.partitionKey.paths;
            context.log("[admin-companies-v2] DELETE container definition read successfully:", {
              partitionKeyPaths: pkPaths
            });
          } catch (readErr) {
            context.log("[admin-companies-v2] DELETE warning: failed to read container definition:", {
              error: readErr?.message
            });
          }

          let partitionKeyValue = doc.id;
          const potentialPkValues = [];

          if (pkPaths && pkPaths.length > 0) {
            const primaryPkPath = pkPaths[0];
            pkFieldName = primaryPkPath.replace(/^\//, "");
            context.log("[admin-companies-v2] DELETE container partition key path:", {
              pkPath: primaryPkPath,
              pkFieldName: pkFieldName
            });

            let pkFromDoc = doc[pkFieldName];

            if (pkFromDoc !== undefined && pkFromDoc !== null) {
              partitionKeyValue = pkFromDoc;
              potentialPkValues.push(pkFromDoc);
              context.log("[admin-companies-v2] DELETE extracted partition key value from document:", {
                pkFieldName: pkFieldName,
                pkValue: pkFromDoc
              });
            } else {
              context.log("[admin-companies-v2] DELETE warning: partition key field '" + pkFieldName + "' is missing or null in document, will use fallbacks:", {
                pkFieldName: pkFieldName,
                hasField: pkFieldName in doc,
                fieldValue: pkFromDoc,
                docKeys: Object.keys(doc).slice(0, 15)
              });
            }
          } else {
            context.log("[admin-companies-v2] DELETE warning: unable to read container partition key paths");
          }

          if (doc.id !== undefined && doc.id !== null && !potentialPkValues.includes(doc.id)) {
            potentialPkValues.push(doc.id);
          }

          if (doc.company_id !== undefined && doc.company_id !== null && !potentialPkValues.includes(doc.company_id)) {
            potentialPkValues.push(doc.company_id);
          }

          context.log("[admin-companies-v2] SOFT DELETE prepared:", {
            id: doc.id,
            company_id: doc.company_id,
            company_name: doc.company_name,
            is_deleted: doc.is_deleted,
            partitionKeyValue: partitionKeyValue,
            pkFieldName: pkFieldName,
            potentialPkValues: potentialPkValues
          });

          const now = new Date().toISOString();
          const actor = (body && body.actor) || "admin_ui";

          const updatedDoc = {
            ...doc,
            is_deleted: true,
            deleted_at: now,
            deleted_by: actor
          };

          let replaceError = null;
          let replacedSuccessfully = false;

          for (const pkValue of potentialPkValues) {
            if (replacedSuccessfully) break;

            try {
              context.log("[admin-companies-v2] SOFT DELETE attempting replace with partition key:", {
                itemId: doc.id,
                partitionKeyValue: pkValue,
                isRetry: potentialPkValues.indexOf(pkValue) > 0
              });

              const replaceResult = await container.item(doc.id, pkValue).replace(updatedDoc);
              context.log(`[admin-companies-v2] DELETE soft-delete succeeded:`, {
                id: requestedId,
                itemId: doc.id,
                partitionKeyValue: pkValue,
                deletedAt: now,
                deletedBy: actor,
                statusCode: replaceResult?.statusCode
              });
              replacedSuccessfully = true;
              return json({ ok: true, softDeleted: true }, 200);
            } catch (err) {
              replaceError = err;
              context.log("[admin-companies-v2] SOFT DELETE replace failed with partition key:", {
                attemptedPkValue: pkValue,
                code: err?.code,
                statusCode: err?.statusCode,
                message: err?.message,
                isLastAttempt: potentialPkValues.indexOf(pkValue) === potentialPkValues.length - 1
              });
            }
          }

          context.log("[admin-companies-v2] SOFT DELETE failed with all partition key attempts:", {
            requestedId: requestedId,
            itemId: doc.id,
            attemptedPartitionKeys: potentialPkValues,
            finalError: replaceError?.message,
            errorCode: replaceError?.code,
            errorStatusCode: replaceError?.statusCode
          });
          throw replaceError;
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
