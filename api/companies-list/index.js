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

        context.log("[companies-list] GET query:", {
          search: search || "(none)",
          take,
          sql
        });

        const { resources } = await container.items
          .query({ query: sql, parameters }, { enableCrossPartitionQuery: true })
          .fetchAll();

        const results = resources || [];
        context.log("[companies-list] GET raw count:", results.length);

        const items = results;
        context.log("[companies-list] GET count after soft-delete filter:", items.length);
        return json({ items, count: items.length }, 200);
      }

      if (method === "POST" || method === "PUT") {
        let body = {};
        try {
          // Azure Functions v4: use await req.json() for proper body parsing
          try {
            body = await req.json();
          } catch (jsonErr) {
            // If JSON parsing fails, try raw text as fallback
            try {
              const text = await req.text();
              if (text) {
                body = JSON.parse(text);
              }
            } catch (textErr) {
              context.log("[companies-list] Failed to parse request body as JSON or text", { jsonErr: jsonErr?.message, textErr: textErr?.message });
              return json({ error: "Invalid JSON", detail: textErr?.message }, 400);
            }
          }
        } catch (e) {
          context.log("[companies-list] JSON parse error:", { error: e?.message });
          return json({ error: "Invalid JSON", detail: e?.message }, 400);
        }

        context.log("[companies-list] Raw body received:", {
          method,
          bodyKeys: Object.keys(body).slice(0, 10),
          hasCompany: !!body.company,
          bodySample: JSON.stringify(body).substring(0, 500)
        });

        const incoming = body.company || body;
        context.log("[companies-list] Extracted incoming payload:", {
          hasId: !!incoming.id,
          hasCompanyId: !!incoming.company_id,
          incomingId: incoming.id,
          incomingCompanyId: incoming.company_id,
          incomingKeys: Object.keys(incoming).slice(0, 15)
        });
        if (!incoming) {
          context.log("[companies-list] No company payload found in body");
          return json({ error: "company payload required" }, 400);
        }

        context.log("[companies-list] Incoming company data:", {
          method,
          id: incoming.id,
          company_id: incoming.company_id,
          company_name: incoming.company_name,
          hasIndustries: Array.isArray(incoming.industries) && incoming.industries.length > 0,
          hasKeywords: Array.isArray(incoming.keywords) && incoming.keywords.length > 0,
          hasRating: !!incoming.rating,
          hasHeadquarters_location: !!incoming.headquarters_location,
          hasHeadquarters_locations: Array.isArray(incoming.headquarters_locations),
        });

        let id;

        if (method === "PUT") {
          // For PUT (updates), ALWAYS use the existing ID - never generate a new one
          id = incoming.id || incoming.company_id;
          context.log("[companies-list] PUT: Looking for ID:", {
            hasIncomingId: !!incoming.id,
            hasIncomingCompanyId: !!incoming.company_id,
            incomingIdValue: incoming.id,
            incomingCompanyIdValue: incoming.company_id,
            derivedId: id
          });
          if (!id) {
            context.log("[companies-list] PUT request missing ID - returning 400");
            return json({ error: "company ID required for updates" }, 400);
          }
          context.log("[companies-list] PUT: Preserving existing ID:", id);
        } else {
          // For POST (new companies), generate ID if not provided
          id = incoming.id || incoming.company_id || incoming.company_name;
          if (!id) {
            id = `company_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            context.log("[companies-list] POST: Generated new ID:", id);
          } else {
            context.log("[companies-list] POST: Using provided ID:", id);
          }
        }

        // Compute normalized_domain for partition key (Cosmos DB partition key is /normalized_domain)
        const urlForDomain = incoming.canonical_url || incoming.url || incoming.website || "unknown";
        const normalizedDomain = incoming.normalized_domain || toNormalizedDomain(urlForDomain);

        if (!normalizedDomain) {
          context.log("[companies-list] Unable to determine company domain for partition key");
          return json({ error: "Unable to determine company domain for partition key" }, 400);
        }

        // Use normalized_domain as partition key value
        const partitionKeyValue = String(normalizedDomain).trim();
        context.log("[companies-list] Using partition key (normalized_domain):", partitionKeyValue);

        // Geocode headquarters location if present and no lat/lng already provided
        let hq_lat = incoming.hq_lat;
        let hq_lng = incoming.hq_lng;

        if (!Number.isFinite(hq_lat) || !Number.isFinite(hq_lng)) {
          if (incoming.headquarters_location && incoming.headquarters_location.trim()) {
            const geoResult = await geocodeHQLocation(incoming.headquarters_location);
            if (geoResult.hq_lat !== undefined && geoResult.hq_lng !== undefined) {
              hq_lat = geoResult.hq_lat;
              hq_lng = geoResult.hq_lng;
              context.log(`[companies-list] Geocoded ${incoming.company_name || incoming.name}: ${incoming.headquarters_location} → (${hq_lat}, ${hq_lng})`);
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

        context.log(`[companies-list] Document prepared for upsert`, {
          id: partitionKeyValue,
          method,
          company_name: doc.company_name,
          hasIndustries: Array.isArray(doc.industries) && doc.industries.length > 0,
          hasKeywords: Array.isArray(doc.keywords) && doc.keywords.length > 0,
          docKeys: Object.keys(doc).sort(),
          hasRating: !!doc.rating,
        });

        try {
          context.log(`[companies-list] Attempting upsert with partition key "${partitionKeyValue}"...`);
          let result;
          try {
            result = await container.items.upsert(doc, { partitionKey: partitionKeyValue });
            context.log(`[companies-list] Upsert succeeded`, {
              id: partitionKeyValue,
              statusCode: result?.statusCode,
              returnedId: result?.resource?.id,
              returnedCompanyId: result?.resource?.company_id,
            });
          } catch (upsertError) {
            context.log(`[companies-list] Upsert with partition key failed, retrying without explicit key...`, {
              error: upsertError?.message,
              code: upsertError?.code,
              statusCode: upsertError?.statusCode,
            });
            result = await container.items.upsert(doc);
            context.log(`[companies-list] Fallback upsert succeeded`, {
              id: partitionKeyValue,
              statusCode: result?.statusCode,
            });
          }
          return json({ ok: true, company: result?.resource || doc }, 200);
        } catch (e) {
          context.log("[companies-list] Upsert failed completely", {
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
          try {
            body = await req.json();
          } catch (jsonErr) {
            try {
              const text = await req.text();
              if (text) {
                body = JSON.parse(text);
              }
            } catch (textErr) {
              context.log("[companies-list] DELETE: Failed to parse request body as JSON or text", { jsonErr: jsonErr?.message, textErr: textErr?.message });
              return json({ error: "Invalid JSON", detail: textErr?.message }, 400);
            }
          }
        } catch (e) {
          context.log("[companies-list] DELETE: JSON parse error:", { error: e?.message });
          return json({ error: "Invalid JSON", detail: e?.message }, 400);
        }

        context.log("[companies-list] DELETE raw body:", body);
        context.log("[companies-list] DELETE query:", req.query);

        const incoming = body.company || body || {};
        const id = incoming.id || incoming.company_id || req.query?.id || req.query?.company_id;

        context.log("[companies-list] DELETE extracted:", {
          incomingId: incoming.id,
          incomingCompanyId: incoming.company_id,
          queryId: req.query?.id,
          queryCompanyId: req.query?.company_id,
          resolvedId: id,
        });

        if (!id) {
          context.log("[companies-list] DELETE missing ID", { incoming, query: req.query });
          return json({ error: "id required" }, 400);
        }

        try {
          context.log("[companies-list] DELETE: Querying for document with id:", id);
          const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @id",
            parameters: [{ name: "@id", value: id }],
          };

          const queryResult = await container.items
            .query(querySpec, { enableCrossPartitionQuery: true })
            .fetchAll();

          const { resources } = queryResult;

          context.log("[companies-list] DELETE query result count:", resources.length);
          if (resources.length > 0) {
            context.log("[companies-list] DELETE document found", {
              id: resources[0].id,
              company_id: resources[0].company_id,
              is_deleted: resources[0].is_deleted,
              normalized_domain: resources[0].normalized_domain
            });
          }

          if (!resources || resources.length === 0) {
            context.log("[companies-list] DELETE no document found for id:", id);
            return json({ error: "Company not found", id }, 404);
          }

          let doc = resources[0];

          // CRITICAL: Extract partition key value directly from the retrieved document
          // The Cosmos DB container partition key is /normalized_domain
          let documentNormalizedDomain = doc.normalized_domain;

          // If the document doesn't have normalized_domain, compute it from URL fields
          // This handles legacy documents created before the normalized_domain field was added
          if (!documentNormalizedDomain || String(documentNormalizedDomain).trim() === "") {
            const urlForDomain = doc.canonical_url || doc.url || doc.website || "";
            documentNormalizedDomain = toNormalizedDomain(urlForDomain);

            context.log("[companies-list] DELETE: Document missing normalized_domain, computed from URL", {
              id: doc.id,
              company_name: doc.company_name,
              urlForDomain: urlForDomain,
              computedNormalizedDomain: documentNormalizedDomain
            });

            // Update the document to include the computed normalized_domain for future operations
            doc.normalized_domain = documentNormalizedDomain;
          }

          if (!documentNormalizedDomain || String(documentNormalizedDomain).trim() === "" || String(documentNormalizedDomain).trim() === "unknown") {
            context.log("[companies-list] DELETE ERROR: Cannot determine normalized_domain for document", {
              id: doc.id,
              company_name: doc.company_name,
              canonicalUrl: doc.canonical_url,
              url: doc.url,
              website: doc.website,
              docKeys: Object.keys(doc).slice(0, 20)
            });
            return json({
              error: "Cannot delete company: unable to determine partition key from document URL fields",
              id
            }, 500);
          }

          const partitionKeyValue = String(documentNormalizedDomain).trim();
          context.log("[companies-list] DELETE: Partition key ready", {
            itemId: doc.id,
            partitionKeyValue: partitionKeyValue,
            typeOf: typeof partitionKeyValue,
            length: partitionKeyValue.length,
            wasComputed: !resources[0].normalized_domain
          });

          const now = new Date().toISOString();
          const actor = (incoming && incoming.actor) || (body && body.actor) || "admin_ui";

          const updatedDoc = {
            ...doc,
            is_deleted: true,
            deleted_at: now,
            deleted_by: actor
          };

          context.log("[companies-list] SOFT DELETE prepared:", {
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
            context.log("[companies-list] SOFT DELETE attempting upsert with partition key:", {
              itemId: doc.id,
              partitionKeyValue: partitionKeyValue,
              docId: updatedDoc.id,
              updatedDocNormalizedDomain: updatedDoc.normalized_domain
            });

            const upsertResult = await container.items.upsert(updatedDoc, { partitionKey: partitionKeyValue });

            context.log("[companies-list] SOFT DELETE upsert succeeded:", {
              requestedId: id,
              itemId: doc.id,
              deletedAt: now,
              deletedBy: actor,
              statusCode: upsertResult?.statusCode,
              returnedId: upsertResult?.resource?.id,
              returnedIsDeleted: upsertResult?.resource?.is_deleted,
              returnedNormalizedDomain: upsertResult?.resource?.normalized_domain
            });
            return json({ ok: true, id, softDeleted: true }, 200);
          } catch (upsertError) {
            context.log("[companies-list] SOFT DELETE upsert with partition key failed:", {
              requestedId: id,
              itemId: doc.id,
              partitionKeyValue: partitionKeyValue,
              code: upsertError?.code,
              statusCode: upsertError?.statusCode,
              message: upsertError?.message,
              errorBody: upsertError?.body
            });

            context.log("[companies-list] SOFT DELETE: Attempting direct item replace with partition key...");
            try {
              const itemRef = container.item(doc.id, partitionKeyValue);
              const replaceResult = await itemRef.replace(updatedDoc);

              context.log("[companies-list] SOFT DELETE direct replace succeeded:", {
                requestedId: id,
                itemId: doc.id,
                partitionKeyValue: partitionKeyValue,
                statusCode: replaceResult?.statusCode,
                returnedId: replaceResult?.resource?.id,
                returnedIsDeleted: replaceResult?.resource?.is_deleted,
                returnedNormalizedDomain: replaceResult?.resource?.normalized_domain
              });
              return json({ ok: true, id, softDeleted: true }, 200);
            } catch (replaceError) {
              context.log("[companies-list] SOFT DELETE direct replace also failed:", {
                error: replaceError?.message,
                code: replaceError?.code,
                statusCode: replaceError?.statusCode
              });

              context.log("[companies-list] SOFT DELETE: Attempting fallback upsert without explicit partition key parameter...");
              try {
                const fallbackResult = await container.items.upsert(updatedDoc);

                context.log("[companies-list] SOFT DELETE fallback upsert succeeded:", {
                  requestedId: id,
                  itemId: doc.id,
                  statusCode: fallbackResult?.statusCode,
                  returnedId: fallbackResult?.resource?.id,
                  returnedIsDeleted: fallbackResult?.resource?.is_deleted
                });
                return json({ ok: true, id, softDeleted: true }, 200);
              } catch (fallbackError) {
                context.log("[companies-list] SOFT DELETE all methods failed:", {
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
          context.log("[companies-list] DELETE/SOFT-DELETE error:", {
            id,
            code: e?.code,
            statusCode: e?.statusCode,
            message: e?.message,
            stack: e?.stack,
            body: e?.body
          });

          if (e?.statusCode === 404) {
            return json({ error: "Company not found", id }, 404);
          }

          return json({ error: "Failed to delete company", detail: e?.message }, 500);
        }
      }

      return json({ error: "Method not allowed" }, 405);
    } catch (e) {
      context.log("[companies-list] Error:", e?.message || e);
      return json({ error: e?.message || "Internal error" }, 500);
    }
  },
});

console.log("[companies-list] ✅ Handler registered successfully with app.http v2");
