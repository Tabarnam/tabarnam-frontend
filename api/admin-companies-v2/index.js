const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");

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

  try {
    const client = new CosmosClient({ endpoint, key });
    return client.database(database).container(container);
  } catch (e) {
    console.error("[admin-companies-v2] Failed to create Cosmos client:", e?.message);
    return null;
  }
}

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

function slugifyCompanyId(value) {
  const s = String(value || "").trim().toLowerCase();
  if (!s) return "";
  const slug = s
    .replace(/['\u001a]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug;
}

function sqlContainsString(fieldExpr) {
  return `(IS_DEFINED(${fieldExpr}) AND IS_STRING(${fieldExpr}) AND CONTAINS(LOWER(${fieldExpr}), @q))`;
}

function sqlContainsStringOrArray(fieldExpr) {
  return `(
    IS_DEFINED(${fieldExpr}) AND (
      (IS_STRING(${fieldExpr}) AND CONTAINS(LOWER(${fieldExpr}), @q)) OR
      (IS_ARRAY(${fieldExpr}) AND ARRAY_LENGTH(
        ARRAY(SELECT VALUE v FROM v IN ${fieldExpr} WHERE IS_STRING(v) AND CONTAINS(LOWER(v), @q))
      ) > 0)
    )
  )`;
}

function sqlLocationObjectContains(alias) {
  const parts = [
    "address",
    "full_address",
    "formatted",
    "location",
    "city",
    "region",
    "state",
    "country",
  ];

  return (
    "(" +
    parts
      .map(
        (p) =>
          `(IS_DEFINED(${alias}.${p}) AND IS_STRING(${alias}.${p}) AND CONTAINS(LOWER(${alias}.${p}), @q))`
      )
      .join(" OR ") +
    ")"
  );
}

function sqlContainsLocationArray(fieldExpr) {
  return `(
    IS_DEFINED(${fieldExpr}) AND IS_ARRAY(${fieldExpr}) AND ARRAY_LENGTH(
      ARRAY(
        SELECT VALUE l
        FROM l IN ${fieldExpr}
        WHERE
          (IS_STRING(l) AND CONTAINS(LOWER(l), @q)) OR
          (IS_OBJECT(l) AND ${sqlLocationObjectContains("l")})
      )
    ) > 0
  )`;
}

function sqlContainsNotesArray(fieldExpr) {
  return `(
    IS_DEFINED(${fieldExpr}) AND IS_ARRAY(${fieldExpr}) AND ARRAY_LENGTH(
      ARRAY(
        SELECT VALUE n
        FROM n IN ${fieldExpr}
        WHERE
          (IS_STRING(n) AND CONTAINS(LOWER(n), @q)) OR
          (IS_OBJECT(n) AND IS_DEFINED(n.text) AND IS_STRING(n.text) AND CONTAINS(LOWER(n.text), @q))
      )
    ) > 0
  )`;
}

function sqlContainsRatingNotes() {
  const stars = ["star1", "star2", "star3", "star4", "star5"];
  const clauses = stars.map((s) => sqlContainsNotesArray(`c.rating.${s}.notes`));
  return `(IS_DEFINED(c.rating) AND IS_OBJECT(c.rating) AND (${clauses.join(" OR ")}))`;
}

function buildSearchWhereClause() {
  const clauses = [
    sqlContainsString("c.company_name"),
    sqlContainsString("c.name"),
    sqlContainsString("c.normalized_domain"),
    sqlContainsString("c.website_url"),
    sqlContainsString("c.url"),
    sqlContainsString("c.canonical_url"),
    sqlContainsString("c.website"),
    sqlContainsStringOrArray("c.product_keywords"),
    sqlContainsStringOrArray("c.keywords"),
    `(
      IS_DEFINED(c.industries) AND IS_ARRAY(c.industries) AND ARRAY_LENGTH(
        ARRAY(SELECT VALUE i FROM i IN c.industries WHERE IS_STRING(i) AND CONTAINS(LOWER(i), @q))
      ) > 0
    )`,
    sqlContainsString("c.headquarters_location"),
    sqlContainsLocationArray("c.headquarters_locations"),
    sqlContainsLocationArray("c.headquarters"),
    sqlContainsStringOrArray("c.manufacturing_locations"),
    sqlContainsLocationArray("c.manufacturing_locations"),
    sqlContainsLocationArray("c.manufacturing_geocodes"),
    sqlContainsString("c.notes"),
    sqlContainsNotesArray("c.star_notes"),
    sqlContainsRatingNotes(),
  ];

  return `(${clauses.join(" OR ")})`;
}

async function doesCompanyIdExist(container, id) {
  if (!id) return false;
  try {
    const { resources } = await container.items
      .query(
        {
          query: "SELECT TOP 1 c.id FROM c WHERE c.id = @id",
          parameters: [{ name: "@id", value: String(id).trim() }],
        },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll();
    return Array.isArray(resources) && resources.length > 0;
  } catch {
    return false;
  }
}

app.http("adminCompanies", {
  route: "xadmin-api-companies",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    console.log("[admin-companies-v2-handler] Request received:", { method: req.method, url: req.url });
    context.log("admin-companies-v2 function invoked");

    const method = (req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return json({}, 200);
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
        const whereClauses = ["(NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)"];

        if (search) {
          parameters.push({ name: "@q", value: search });
          whereClauses.push(buildSearchWhereClause());
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
          body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
        } catch (e) {
          return json({ error: "Invalid JSON", detail: e?.message }, 400);
        }

        const incoming = body.company || body;
        if (!incoming) {
          return json({ error: "company payload required" }, 400);
        }

        const incomingName = String(incoming.company_name || incoming.name || "").trim();
        const incomingUrl = String(
          incoming.website_url || incoming.canonical_url || incoming.url || incoming.website || ""
        ).trim();

        let id = String(incoming.company_id || incoming.id || "").trim();
        const generatedFromName = !id && Boolean(incomingName);

        if (!id) {
          id = slugifyCompanyId(incomingName);
        }
        if (!id) {
          id = `company_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        }

        if (method === "POST" && generatedFromName) {
          const exists = await doesCompanyIdExist(container, id);
          if (exists) {
            id = `${id}-${Date.now().toString(36)}`;
          }
        }

        let existingDoc = null;
        if (method === "PUT") {
          try {
            const querySpec = {
              query: "SELECT TOP 1 * FROM c WHERE c.id = @id ORDER BY c._ts DESC",
              parameters: [{ name: "@id", value: String(id).trim() }],
            };

            const { resources } = await container.items
              .query(querySpec, { enableCrossPartitionQuery: true })
              .fetchAll();

            existingDoc = resources?.[0] || null;
          } catch (e) {
            context.log("[admin-companies-v2] PUT: Failed to lookup existing document", {
              id: String(id).trim(),
              error: e?.message,
            });
          }
        }

        const base = existingDoc ? { ...existingDoc, ...incoming } : { ...incoming };

        const urlForDomain =
          base.website_url || base.canonical_url || base.url || base.website || incomingUrl || "unknown";

        const computedDomain = toNormalizedDomain(urlForDomain);
        const incomingDomain =
          computedDomain !== "unknown" ? computedDomain : incoming.normalized_domain || computedDomain;

        const normalizedDomain = String((existingDoc && existingDoc.normalized_domain) || incomingDomain || "unknown").trim();

        if (!normalizedDomain) {
          return json({ error: "Unable to determine company domain for partition key" }, 400);
        }

        const partitionKeyValue = normalizedDomain;

        const reviewCountRaw =
          (typeof base.review_count === "number" ? base.review_count : null) ??
          (typeof base.reviews_count === "number" ? base.reviews_count : null) ??
          (typeof base.review_count_approved === "number" ? base.review_count_approved : null) ??
          0;

        const now = new Date().toISOString();
        const doc = {
          ...base,
          id: String(id).trim(),
          company_id: String(id).trim(),
          normalized_domain: normalizedDomain,
          company_name: base.company_name || base.name || "",
          name: base.name || base.company_name || "",
          review_count: Math.max(0, Math.trunc(Number(reviewCountRaw) || 0)),
          public_review_count: Math.max(0, Math.trunc(Number(base.public_review_count) || 0)),
          private_review_count: Math.max(0, Math.trunc(Number(base.private_review_count) || 0)),
          updated_at: now,
          created_at: (existingDoc && existingDoc.created_at) || base.created_at || now,
        };

        context.log("[admin-companies-v2] Upserting company", {
          id: partitionKeyValue,
          method,
          company_id: doc.company_id,
          company_name: doc.company_name,
        });

        try {
          let result;
          try {
            result = await container.items.upsert(doc, { partitionKey: partitionKeyValue });
          } catch (upsertError) {
            context.log(
              "[admin-companies-v2] First upsert attempt failed, retrying without partition key",
              { error: upsertError?.message }
            );
            result = await container.items.upsert(doc);
          }
          context.log("[admin-companies-v2] Upsert completed successfully", {
            id: partitionKeyValue,
            statusCode: result.statusCode,
            resourceId: result.resource?.id,
          });
          return json({ ok: true, company: doc }, 200);
        } catch (e) {
          context.log("[admin-companies-v2] Upsert failed completely", {
            id: partitionKeyValue,
            message: e?.message,
            code: e?.code,
            statusCode: e?.statusCode,
          });
          return json({ error: "Failed to save company", detail: e?.message }, 500);
        }
      }

      if (method === "DELETE") {
        let body = {};
        try {
          body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        const { getContainerPartitionKeyPath, buildPartitionKeyCandidates } = require("../_cosmosPartitionKey");

        const id = body.company_id || body.id;
        if (!id) {
          return json({ error: "id required" }, 400);
        }

        const requestedId = String(id).trim();
        if (!requestedId) {
          return json({ error: "Invalid company ID" }, 400);
        }

        context.log("[admin-companies-v2] DELETE: Deleting company", { id: requestedId });

        try {
          const containerPkPath = await getContainerPartitionKeyPath(container, "/normalized_domain");
          context.log("[admin-companies-v2] DELETE: container partition key path resolved", { containerPkPath });

          const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @id",
            parameters: [{ name: "@id", value: requestedId }],
          };

          const { resources } = await container.items
            .query(querySpec, { enableCrossPartitionQuery: true })
            .fetchAll();

          const docs = Array.isArray(resources) ? resources : [];
          context.log("[admin-companies-v2] DELETE query result count:", docs.length);

          if (docs.length === 0) {
            return json({ error: "Company not found", id: requestedId }, 404);
          }

          const now = new Date().toISOString();
          const actor = (body && body.actor) || "admin_ui";

          let softDeleted = 0;
          let hardDeleted = 0;
          const failures = [];

          for (const doc of docs) {
            const updatedDoc = {
              ...doc,
              is_deleted: true,
              deleted_at: now,
              deleted_by: actor,
            };

            const candidates = buildPartitionKeyCandidates({ doc, containerPkPath, requestedId });
            let deletedThisDoc = false;

            try {
              await container.items.upsert(updatedDoc);
              softDeleted++;
              deletedThisDoc = true;
              continue;
            } catch {
              // continue
            }

            for (const partitionKeyValue of candidates) {
              if (deletedThisDoc) break;
              try {
                await container.items.upsert(updatedDoc, { partitionKey: partitionKeyValue });
                softDeleted++;
                deletedThisDoc = true;
                break;
              } catch {
                // continue
              }

              try {
                await container.item(doc.id, partitionKeyValue).replace(updatedDoc);
                softDeleted++;
                deletedThisDoc = true;
                break;
              } catch {
                // continue
              }
            }

            if (deletedThisDoc) continue;

            for (const partitionKeyValue of candidates) {
              if (deletedThisDoc) break;
              try {
                await container.item(doc.id, partitionKeyValue).delete();
                hardDeleted++;
                deletedThisDoc = true;
                break;
              } catch {
                // continue
              }
            }

            if (!deletedThisDoc) {
              failures.push({ itemId: doc.id, attemptedPartitionKeyCount: candidates.length });
            }
          }

          if (failures.length > 0) {
            return json(
              {
                error: "Failed to delete one or more matching documents",
                id: requestedId,
                softDeleted,
                hardDeleted,
                failures,
              },
              500
            );
          }

          return json({ ok: true, id: requestedId, softDeleted, hardDeleted }, 200);
        } catch (e) {
          context.log("[admin-companies-v2] DELETE error", {
            id: requestedId,
            code: e?.code,
            statusCode: e?.statusCode,
            message: e?.message,
            stack: e?.stack,
          });
          return json({ error: "Failed to delete company", detail: e?.message }, 500);
        }
      }

      return json({ error: "Method not allowed" }, 405);
    } catch (e) {
      context.log("[admin-companies-v2] Error", e?.message || e);
      return json({ error: e?.message || "Internal error" }, 500);
    }
  },
});
