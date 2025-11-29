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

        const partitionKeyValue = String(id).trim();
        if (!partitionKeyValue) {
          context.log("[admin-companies] Invalid partition key value");
          return json({ error: "Unable to determine company ID" }, 400);
        }

        context.log("[admin-companies] Using partition key:", partitionKeyValue);

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

        context.log(`[admin-companies] Upserting company`, { id: partitionKeyValue, method, company_name: doc.company_name });

        try {
          let result;
          try {
            result = await container.items.upsert(doc, { partitionKey: partitionKeyValue });
          } catch (upsertError) {
            context.log(`[admin-companies] First upsert attempt failed, retrying without partition key`, { error: upsertError?.message });
            result = await container.items.upsert(doc);
          }
          context.log(`[admin-companies] Upsert completed successfully`, { id: partitionKeyValue, statusCode: result.statusCode, resourceId: result.resource?.id });
          return json({ ok: true, company: doc }, 200);
        } catch (e) {
          context.log("[admin-companies] Upsert failed completely", { id: partitionKeyValue, message: e?.message, code: e?.code, statusCode: e?.statusCode });
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

        context.log(`[admin-companies] Deleting company:`, { id: partitionKeyValue });

        try {
          await container.item(partitionKeyValue, partitionKeyValue).delete();
          context.log(`[admin-companies] Delete success:`, { id: partitionKeyValue });
          return json({ ok: true }, 200);
        } catch (e) {
          context.log("[admin-companies] Delete error:", { id: partitionKeyValue, error: e?.message });
          return json({ error: "Company not found", detail: e?.message }, 404);
        }
      }

      return json({ error: "Method not allowed" }, 405);
    } catch (e) {
      context.log("[admin-companies] Error:", e?.message || e);
      return json({ error: e?.message || "Internal error" }, 500);
    }
  },
});
