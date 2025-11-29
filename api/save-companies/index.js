const { app } = require("@azure/functions");
const axios = require("axios");

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-functions-key",
    },
    body: JSON.stringify(obj),
  };
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
    console.log(`[save-companies] Geocoding failed for "${headquarters_location}": ${e.message}`);
  }

  return { hq_lat: undefined, hq_lng: undefined };
}

app.http("saveCompanies", {
  route: "save-companies",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "content-type,x-functions-key",
        },
      };
    }

    if (method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    try {
      const { CosmosClient } = require("@azure/cosmos");

      const endpoint = (process.env.COSMOS_DB_ENDPOINT || "").trim();
      const key = (process.env.COSMOS_DB_KEY || "").trim();
      const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
      const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

      if (!endpoint || !key) {
        return json({ ok: false, error: "Cosmos DB not configured" }, 500);
      }

      const bodyObj = await req.json().catch(() => ({}));
      const companies = bodyObj.companies || [];
      if (!Array.isArray(companies) || companies.length === 0) {
        return json({ ok: false, error: "companies array required" }, 400);
      }

      const client = new CosmosClient({ endpoint, key });
      const database = client.database(databaseId);
      const container = database.container(containerId);

      let saved = 0;
      let failed = 0;
      const errors = [];
      const sessionId = `manual_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      for (const company of companies) {
        try {
          // Geocode headquarters location if present and no lat/lng already provided
          let hq_lat = company.hq_lat;
          let hq_lng = company.hq_lng;

          if (!Number.isFinite(hq_lat) || !Number.isFinite(hq_lng)) {
            if (company.headquarters_location && company.headquarters_location.trim()) {
              const geoResult = await geocodeHQLocation(company.headquarters_location);
              if (geoResult.hq_lat !== undefined && geoResult.hq_lng !== undefined) {
                hq_lat = geoResult.hq_lat;
                hq_lng = geoResult.hq_lng;
                console.log(`[save-companies] Geocoded ${company.company_name || company.name}: ${company.headquarters_location} → (${hq_lat}, ${hq_lng})`);
              }
            }
          }

          // Geocode additional headquarters locations
          let headquarters_locations = [];
          if (Array.isArray(company.headquarters_locations) && company.headquarters_locations.length > 0) {
            headquarters_locations = await Promise.all(
              company.headquarters_locations.map(async (hqLoc) => {
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

          // Calculate default rating based on company data
          const hasManufacturingLocations = Array.isArray(company.manufacturing_locations) && company.manufacturing_locations.length > 0;
          const hasHeadquarters = !!(company.headquarters_location && company.headquarters_location.trim());
          const hasReviews = (company.editorial_review_count || 0) > 0 ||
                            (Array.isArray(company.reviews) && company.reviews.length > 0);

          const defaultRating = {
            star1: { value: hasManufacturingLocations ? 1.0 : 0.0, notes: [] },
            star2: { value: hasHeadquarters ? 1.0 : 0.0, notes: [] },
            star3: { value: hasReviews ? 1.0 : 0.0, notes: [] },
            star4: { value: 0.0, notes: [] },
            star5: { value: 0.0, notes: [] },
          };

          const doc = {
            id: `company_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            company_name: company.company_name || company.name || "",
            name: company.name || company.company_name || "",
            url: company.url || "",
            website_url: company.url || "",
            industries: company.industries || [],
            product_keywords: company.product_keywords || "",
            headquarters_location: company.headquarters_location || "",
            headquarters_locations: headquarters_locations.length > 0 ? headquarters_locations : company.headquarters_locations,
            manufacturing_locations: Array.isArray(company.manufacturing_locations) ? company.manufacturing_locations : [],
            red_flag: Boolean(company.red_flag),
            red_flag_reason: company.red_flag_reason || "",
            location_confidence: company.location_confidence || "medium",
            hq_lat: hq_lat,
            hq_lng: hq_lng,
            rating_icon_type: company.rating_icon_type || "star",
            rating: company.rating || defaultRating,
            source: "manual_import",
            session_id: sessionId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };

          if (!doc.company_name && !doc.url) {
            failed++;
            errors.push(`Skipped entry: no company_name or url`);
            continue;
          }

          await container.items.create(doc);
          saved++;
        } catch (e) {
          failed++;
          errors.push(
            `Failed to save "${company.company_name || company.name}": ${e.message}`
          );
        }
      }

      return json(
        {
          ok: true,
          saved,
          failed,
          total: companies.length,
          session_id: sessionId,
          errors: errors.length > 0 ? errors : undefined,
        },
        200
      );
    } catch (e) {
      return json(
        { ok: false, error: `Database error: ${e.message || String(e)}` },
        500
      );
    }
  },
});
