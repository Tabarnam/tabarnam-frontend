const { app } = require("@azure/functions");
const axios = require("axios");
const { geocodeLocationArray, pickPrimaryLatLng } = require("../_geocode");

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

function toFiniteNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function normalizeLocationEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      if (typeof entry === "string") {
        const address = entry.trim();
        return address ? { address } : null;
      }
      if (entry && typeof entry === "object") return entry;
      return null;
    })
    .filter(Boolean);
}

async function geocodeCompanyLocations(company, headquarters_locations, { timeoutMs = 5000 } = {}) {
  const hqBase = normalizeLocationEntries(headquarters_locations);

  const manuBase =
    Array.isArray(company.manufacturing_geocodes) && company.manufacturing_geocodes.length > 0
      ? company.manufacturing_geocodes
      : Array.isArray(company.manufacturing_locations)
        ? company.manufacturing_locations
        : [];

  const [headquarters, manufacturing_geocodes] = await Promise.all([
    geocodeLocationArray(hqBase, { timeoutMs, concurrency: 4 }),
    geocodeLocationArray(normalizeLocationEntries(manuBase), { timeoutMs, concurrency: 4 }),
  ]);

  const primary = pickPrimaryLatLng(headquarters);

  return {
    headquarters,
    manufacturing_geocodes,
    hq_lat: primary ? primary.lat : toFiniteNumber(company.hq_lat),
    hq_lng: primary ? primary.lng : toFiniteNumber(company.hq_lng),
  };
}

app.http("save-companies", {
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
          // Validate logo_url is not a temporary blob URL
          if (company.logo_url && typeof company.logo_url === 'string') {
            if (company.logo_url.startsWith('blob:')) {
              failed++;
              errors.push(`Invalid logo URL for "${company.company_name || company.name}": Must be a permanent storage link, not a temporary blob URL`);
              continue;
            }
          }

          // Build HQ location array (primary + additional) and geocode per-location
          let headquarters_locations = Array.isArray(company.headquarters_locations)
            ? company.headquarters_locations
            : [];

          if (company.headquarters_location && company.headquarters_location.trim()) {
            const primaryAddr = company.headquarters_location.trim();
            const alreadyHasPrimary = headquarters_locations.some((hq) => {
              if (!hq) return false;
              if (typeof hq === "string") return hq.trim() === primaryAddr;
              return typeof hq.address === "string" && hq.address.trim() === primaryAddr;
            });

            if (!alreadyHasPrimary) {
              headquarters_locations = [{ address: primaryAddr }, ...headquarters_locations];
            }
          }

          const geoCompany = await geocodeCompanyLocations(company, headquarters_locations, { timeoutMs: 5000 });
          const headquarters = geoCompany.headquarters;
          const manufacturing_geocodes = geoCompany.manufacturing_geocodes;
          const hq_lat = geoCompany.hq_lat;
          const hq_lng = geoCompany.hq_lng;

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
            headquarters_locations: headquarters.length > 0 ? headquarters : company.headquarters_locations,
            headquarters,
            manufacturing_locations: Array.isArray(manufacturing_geocodes) ? manufacturing_geocodes : [],
            manufacturing_geocodes,
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
