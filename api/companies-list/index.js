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

        const partitionKeyValue = String(id).trim();
        if (!partitionKeyValue) {
          context.log("[companies-list] Invalid partition key value");
          return json({ error: "Unable to determine company ID" }, 400);
        }

        context.log("[companies-list] Using partition key:", partitionKeyValue);

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
          id: partitionKeyValue,
          company_id: partitionKeyValue,
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
          // Use same robust parsing as POST/PUT: Azure Functions v4 with req.json() and text fallback
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

        // Support both { company: {...} } and flat {...} patterns, plus query params
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
          // 1) Find the document by id with a cross-partition query
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
            context.log("[companies-list] DELETE first doc:", resources[0]);
          }

          // Log container partition key configuration
          const pkPaths = container.partitionKey && container.partitionKey.paths;
          context.log("[companies-list] DELETE container partition key paths:", pkPaths);

          if (!resources || resources.length === 0) {
            context.log("[companies-list] DELETE no document found for id:", id);
            return json({ error: "Company not found", id }, 404);
          }

          const doc = resources[0];

          // 2) Dynamically derive partition key from container configuration
          const primaryPkPath = pkPaths && pkPaths[0];
          const pkFieldName = primaryPkPath ? primaryPkPath.replace(/^\//, "") : null;

          let partitionKeyValue = pkFieldName ? doc[pkFieldName] : undefined;

          // Fallbacks if that field is missing on this document
          if (partitionKeyValue === undefined || partitionKeyValue === null) {
            // Prefer explicit company_id if present
            if (doc.company_id !== undefined && doc.company_id !== null) {
              partitionKeyValue = doc.company_id;
            } else {
              // Final fallback – use id
              partitionKeyValue = doc.id;
            }

            context.log("[companies-list] DELETE pk fallback used:", {
              id,
              pkPaths,
              pkFieldName,
              docCompanyId: doc.company_id,
              docId: doc.id,
              partitionKeyValue
            });
          }

          if (partitionKeyValue === undefined || partitionKeyValue === null) {
            context.log("[companies-list] DELETE unable to resolve partition key value:", {
              id,
              pkPaths,
              pkFieldName,
              doc
            });
            return json(
              { error: "Could not determine partition key for document", id },
              500
            );
          }

          // 3) Delete using the correct partition key resolved from container config
          const deleteResult = await container.item(id, partitionKeyValue).delete();
          context.log("[companies-list] DELETE success:", {
            id,
            partitionKeyValue,
            statusCode: deleteResult.statusCode
          });

          return json({ ok: true, id }, 200);
        } catch (e) {
          context.log("[companies-list] DELETE error:", {
            id,
            error: e?.message,
            code: e?.code,
            statusCode: e?.statusCode,
          });
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
