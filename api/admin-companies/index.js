const { app } = require("@azure/functions");
const axios = require("axios");

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
    console.error("[admin-companies] Failed to create Cosmos client:", e?.message);
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
    console.log(`[admin-companies] Geocoding failed for "${headquarters_location}": ${e.message}`);
  }

  return { hq_lat: undefined, hq_lng: undefined };
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

app.http("adminCompanies", {
  route: "admin-companies",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    console.log("[admin-companies-handler] Request received:", { method: req.method, url: req.url });
    context.log("admin-companies function invoked");

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
        context.log("[admin-companies] GET count after soft-delete filter:", items.length);
        return json({ items, count: items.length }, 200);
      }

      if (method === "POST" || method === "PUT") {
        let body = {};
        try {
          body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
        } catch (e) {
          context.log("[admin-companies] JSON parse error:", e?.message);
          return json({ error: "Invalid JSON", detail: e?.message }, 400);
        }

        context.log("[admin-companies] Raw body received:", { bodyKeys: Object.keys(body).slice(0, 5), hasCompany: !!body.company });

        const incoming = body.company || body;
        if (!incoming) {
          context.log("[admin-companies] No company payload found in body");
          return json({ error: "company payload required" }, 400);
        }

        context.log("[admin-companies] Incoming company data:", {
          id: incoming.id,
          company_id: incoming.company_id,
          company_name: incoming.company_name,
          hasRating: !!incoming.rating,
          hasHeadquarters_location: !!incoming.headquarters_location,
          hasHeadquarters_locations: Array.isArray(incoming.headquarters_locations),
        });

        let id = incoming.id || incoming.company_id || incoming.company_name;
        if (!id) {
          id = `company_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          context.log("[admin-companies] Generated new ID:", id);
        }

        // Compute normalized_domain for partition key (Cosmos DB partition key is /normalized_domain)
        const urlForDomain = incoming.canonical_url || incoming.url || incoming.website || "unknown";
        const normalizedDomain = incoming.normalized_domain || toNormalizedDomain(urlForDomain);

        if (!normalizedDomain) {
          context.log("[admin-companies] Unable to determine company domain for partition key");
          return json({ error: "Unable to determine company domain for partition key" }, 400);
        }

        // Use normalized_domain as partition key value
        const partitionKeyValue = String(normalizedDomain).trim();
        context.log("[admin-companies] Using partition key (normalized_domain):", partitionKeyValue);

        // Geocode headquarters location if present and no lat/lng already provided
        let hq_lat = incoming.hq_lat;
        let hq_lng = incoming.hq_lng;

        if (!Number.isFinite(hq_lat) || !Number.isFinite(hq_lng)) {
          if (incoming.headquarters_location && incoming.headquarters_location.trim()) {
            const geoResult = await geocodeHQLocation(incoming.headquarters_location);
            if (geoResult.hq_lat !== undefined && geoResult.hq_lng !== undefined) {
              hq_lat = geoResult.hq_lat;
              hq_lng = geoResult.hq_lng;
              context.log(`[admin-companies] Geocoded ${incoming.company_name || incoming.name}: ${incoming.headquarters_location} → (${hq_lat}, ${hq_lng})`);
            }
          }
        }

        // Geocode additional headquarters locations
        let headquarters_locations = [];
        if (Array.isArray(incoming.headquarters_locations) && incoming.headquarters_locations.length > 0) {
          headquarters_locations = await Promise.all(
            incoming.headquarters_locations.map(async (hqLoc) => {
              if (!hqLoc.lat || !hqLoc.lng) {
                if (hqLoc.address && hqLoc.address.trim()) {
                  const geoResult = await geocodeHQLocation(hqLoc.address);
                  return {
                    ...hqLoc,
                    lat: geoResult.hq_lat,
                    lng: geoResult.hq_lng,
                  };
                }
              }
              return hqLoc;
            })
          );
        }

        // Calculate default rating if not provided
        const hasManufacturingLocations = Array.isArray(incoming.manufacturing_locations) && incoming.manufacturing_locations.length > 0;
        const hasHeadquarters = !!(incoming.headquarters_location && incoming.headquarters_location.trim());
        const hasReviews = (incoming.editorial_review_count || 0) > 0;

        const defaultRating = {
          star1: { value: hasManufacturingLocations ? 1.0 : 0.0, notes: [] },
          star2: { value: hasHeadquarters ? 1.0 : 0.0, notes: [] },
          star3: { value: hasReviews ? 1.0 : 0.0, notes: [] },
          star4: { value: 0.0, notes: [] },
          star5: { value: 0.0, notes: [] },
        };

        const now = new Date().toISOString();
        const doc = {
          ...incoming,
          id: String(id).trim(),
          company_id: String(id).trim(),
          normalized_domain: normalizedDomain,
          company_name: incoming.company_name || incoming.name || "",
          name: incoming.name || incoming.company_name || "",
          hq_lat: hq_lat,
          hq_lng: hq_lng,
          headquarters_locations: headquarters_locations.length > 0 ? headquarters_locations : incoming.headquarters_locations,
          rating_icon_type: incoming.rating_icon_type || "star",
          rating: incoming.rating || defaultRating,
          updated_at: now,
          created_at: incoming.created_at || now,
        };

        context.log(`[admin-companies] Document prepared for upsert`, {
          id: partitionKeyValue,
          method,
          company_name: doc.company_name,
          docKeys: Object.keys(doc).sort(),
          hasRating: !!doc.rating,
        });

        try {
          context.log(`[admin-companies] Attempting upsert with partition key...`);
          let result;
          try {
            result = await container.items.upsert(doc);
            context.log(`[admin-companies] Upsert succeeded`, {
              id: partitionKeyValue,
              statusCode: result?.statusCode,
              resourceId: result?.resource?.id,
            });
          } catch (upsertError) {
            context.log(`[admin-companies] Upsert attempt failed`, {
              error: upsertError?.message,
              code: upsertError?.code,
              statusCode: upsertError?.statusCode,
            });
            throw upsertError;
          }
          return json({ ok: true, company: doc }, 200);
        } catch (e) {
          context.log("[admin-companies] Upsert failed completely", {
            id: partitionKeyValue,
            message: e?.message,
            code: e?.code,
            statusCode: e?.statusCode,
            stack: e?.stack,
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

        const requestedId = String(id).trim();
        if (!requestedId) {
          return json({ error: "Invalid company ID" }, 400);
        }

        context.log(`[admin-companies] DELETE: Deleting company with id:`, { id: requestedId });

        try {
          context.log("[admin-companies] DELETE: Querying for document with id:", requestedId);
          const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @id",
            parameters: [{ name: "@id", value: requestedId }],
          };

          const queryResult = await container.items
            .query(querySpec, { enableCrossPartitionQuery: true })
            .fetchAll();

          const { resources } = queryResult;

          context.log("[admin-companies] DELETE query result count:", resources.length);

          if (!resources || resources.length === 0) {
            context.log("[admin-companies] DELETE no document found for id:", requestedId);
            return json({ error: "Company not found", id: requestedId }, 404);
          }

          let doc = resources[0];

          let pkPaths = undefined;
          let pkFieldName = null;

          try {
            const containerResponse = await container.read();
            const containerDef = containerResponse.resource;
            pkPaths = containerDef && containerDef.partitionKey && containerDef.partitionKey.paths;
            context.log("[admin-companies] DELETE container definition read successfully:", {
              partitionKeyPaths: pkPaths
            });
          } catch (readErr) {
            context.log("[admin-companies] DELETE warning: failed to read container definition:", {
              error: readErr?.message
            });
          }

          context.log("[admin-companies] DELETE container partition key paths:", {
            pkPaths: pkPaths,
            pkFieldName: pkFieldName
          });

          const now = new Date().toISOString();
          const actor = (body && body.actor) || "admin_ui";
          const partitionKeyValue = String(doc.normalized_domain || doc.id).trim();

          const updatedDoc = {
            ...doc,
            is_deleted: true,
            deleted_at: now,
            deleted_by: actor
          };

          context.log("[admin-companies] SOFT DELETE prepared:", {
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
            context.log("[admin-companies] SOFT DELETE attempting upsert with partition key:", {
              itemId: doc.id,
              partitionKeyValue: partitionKeyValue
            });

            const upsertResult = await container.items.upsert(updatedDoc, { partitionKey: partitionKeyValue });
            context.log(`[admin-companies] DELETE soft-delete succeeded:`, {
              id: requestedId,
              itemId: doc.id,
              deletedAt: now,
              deletedBy: actor,
              statusCode: upsertResult?.statusCode
            });
            return json({ ok: true, softDeleted: true }, 200);
          } catch (upsertError) {
            context.log("[admin-companies] SOFT DELETE upsert with partition key failed:", {
              requestedId: requestedId,
              itemId: doc.id,
              code: upsertError?.code,
              statusCode: upsertError?.statusCode,
              message: upsertError?.message,
              errorBody: upsertError?.body
            });

            context.log("[admin-companies] SOFT DELETE: Attempting direct item replace with partition key...");
            try {
              const itemRef = container.item(doc.id, partitionKeyValue);
              const replaceResult = await itemRef.replace(updatedDoc);
              context.log("[admin-companies] SOFT DELETE direct replace succeeded:", {
                requestedId: requestedId,
                itemId: doc.id,
                statusCode: replaceResult?.statusCode,
                returnedId: replaceResult?.resource?.id,
                returnedIsDeleted: replaceResult?.resource?.is_deleted
              });
              return json({ ok: true, softDeleted: true }, 200);
            } catch (replaceError) {
              context.log("[admin-companies] SOFT DELETE direct replace also failed:", {
                error: replaceError?.message,
                code: replaceError?.code,
                statusCode: replaceError?.statusCode
              });

              context.log("[admin-companies] SOFT DELETE: Attempting fallback upsert without partition key...");
              try {
                const fallbackResult = await container.items.upsert(updatedDoc);
                context.log("[admin-companies] SOFT DELETE fallback upsert succeeded:", {
                  requestedId: requestedId,
                  itemId: doc.id,
                  statusCode: fallbackResult?.statusCode
                });
                return json({ ok: true, softDeleted: true }, 200);
              } catch (fallbackError) {
                context.log("[admin-companies] SOFT DELETE all methods failed:", {
                  upsertWithKeyError: upsertError?.message,
                  replaceError: replaceError?.message,
                  fallbackError: fallbackError?.message
                });
                throw upsertError;
              }
            }
          }
        } catch (e) {
          context.log("[admin-companies] DELETE error:", {
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
      context.log("[admin-companies] Error:", e?.message || e);
      return json({ error: e?.message || "Internal error" }, 500);
    }
  },
});
