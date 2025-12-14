// Companies list API endpoint - v4 modern runtime with app.http()
console.log("[companies-list] Starting module load...");
const { app } = require("@azure/functions");
const axios = require("axios");
const { stripAmazonAffiliateTagForStorage } = require("../_amazonAffiliate");
const { geocodeLocationArray, pickPrimaryLatLng } = require("../_geocode");
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

function toFiniteNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function normalizeBool(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (!v) return defaultValue;
    if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
    if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  }
  return Boolean(value);
}

function clampStarValue01(value) {
  const n = toFiniteNumber(value);
  const clamped = Math.max(0, Math.min(1, n ?? 0));
  return Math.round(clamped * 100) / 100;
}

function normalizeStarNote(note) {
  if (!note || typeof note !== "object") return null;
  const text = typeof note.text === "string" ? note.text.trim() : "";
  if (!text) return null;

  const idRaw = typeof note.id === "string" ? note.id.trim() : "";
  const id = idRaw || `note_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  return {
    id,
    text,
    is_public: normalizeBool(note.is_public, false),
    created_at: typeof note.created_at === "string" ? note.created_at : undefined,
    updated_at: typeof note.updated_at === "string" ? note.updated_at : undefined,
    created_by: typeof note.created_by === "string" ? note.created_by : undefined,
  };
}

function normalizeStarUnit(unit) {
  const u = unit && typeof unit === "object" ? unit : {};
  const notes = Array.isArray(u.notes) ? u.notes.map(normalizeStarNote).filter(Boolean) : [];
  const iconType = typeof u.icon_type === "string" ? u.icon_type.trim().toLowerCase() : "";

  return {
    value: clampStarValue01(u.value),
    notes,
    ...(iconType === "star" || iconType === "heart" ? { icon_type: iconType } : {}),
  };
}

function normalizeCompanyRating(rating) {
  const r = rating && typeof rating === "object" ? rating : {};
  return {
    star1: normalizeStarUnit(r.star1),
    star2: normalizeStarUnit(r.star2),
    star3: normalizeStarUnit(r.star3),
    star4: normalizeStarUnit(r.star4),
    star5: normalizeStarUnit(r.star5),
  };
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

function stripAmazonTagIfString(value) {
  return typeof value === "string" ? stripAmazonAffiliateTagForStorage(value) : value;
}

function stripAmazonTagsFromUrlArray(value) {
  if (!Array.isArray(value)) return value;
  return value.map((v) => (typeof v === "string" ? stripAmazonAffiliateTagForStorage(v) : v));
}

function stripAmazonTagsFromAffiliateLinks(value) {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (typeof entry === "string") return stripAmazonAffiliateTagForStorage(entry);
    if (entry && typeof entry === "object" && typeof entry.url === "string") {
      return { ...entry, url: stripAmazonAffiliateTagForStorage(entry.url) };
    }
    return entry;
  });
}

function stripAmazonTagsFromLocationSources(value) {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    if (typeof entry.source_url !== "string") return entry;
    return { ...entry, source_url: stripAmazonAffiliateTagForStorage(entry.source_url) };
  });
}

function stripAmazonTagsFromSocial(value) {
  if (!value || typeof value !== "object") return value;
  const next = { ...value };
  for (const k of ["linkedin", "instagram", "x", "twitter", "facebook", "tiktok", "youtube"]) {
    next[k] = stripAmazonTagIfString(next[k]);
  }
  return next;
}

async function geocodeCompanyLocations(base, headquarters_locations, { timeoutMs = 5000 } = {}) {
  const hqBase = normalizeLocationEntries(headquarters_locations);
  const manuBase =
    Array.isArray(base.manufacturing_geocodes) && base.manufacturing_geocodes.length > 0
      ? base.manufacturing_geocodes
      : Array.isArray(base.manufacturing_locations)
        ? base.manufacturing_locations
        : [];

  const [headquarters, manufacturing_geocodes] = await Promise.all([
    geocodeLocationArray(hqBase, { timeoutMs, concurrency: 4 }),
    geocodeLocationArray(normalizeLocationEntries(manuBase), { timeoutMs, concurrency: 4 }),
  ]);

  const primary = pickPrimaryLatLng(headquarters);

  return {
    headquarters,
    manufacturing_geocodes,
    hq_lat: primary ? primary.lat : toFiniteNumber(base.hq_lat),
    hq_lng: primary ? primary.lng : toFiniteNumber(base.hq_lng),
  };
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

app.http("companies-list", {
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
        const id = (req.query?.id || req.query?.company_id || "").toString().trim();
        if (id) {
          const parameters = [{ name: "@id", value: id }];
          const sql =
            "SELECT TOP 1 * FROM c WHERE c.id = @id AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) ORDER BY c._ts DESC";

          const { resources } = await container.items
            .query({ query: sql, parameters }, { enableCrossPartitionQuery: true })
            .fetchAll();

          const item = Array.isArray(resources) ? resources[0] : null;
          if (!item) return json({ ok: false, error: "Company not found", id }, 404);

          if (!item.created_at && typeof item._ts === "number") {
            try {
              item.created_at = new Date(item._ts * 1000).toISOString();
            } catch {}
          }
          if (!item.updated_at && typeof item._ts === "number") {
            try {
              item.updated_at = new Date(item._ts * 1000).toISOString();
            } catch {}
          }

          return json({ ok: true, item }, 200);
        }

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

        // Validate logo_url is not a temporary blob URL
        if (incoming.logo_url && typeof incoming.logo_url === 'string') {
          if (incoming.logo_url.startsWith('blob:')) {
            context.log("[companies-list] Rejected: logo_url is a temporary blob URL", {
              company_name: incoming.company_name,
              logo_url: incoming.logo_url.substring(0, 50)
            });
            return json({
              error: "Invalid logo URL: Must be a permanent storage link, not a temporary blob URL. Please ensure the logo was properly uploaded to Azure Blob Storage before saving."
            }, 400);
          }
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
            context.log("[companies-list] PUT: Existing document lookup", {
              id: String(id).trim(),
              found: !!existingDoc,
              existingNormalizedDomain: existingDoc?.normalized_domain,
            });
          } catch (e) {
            context.log("[companies-list] PUT: Failed to lookup existing document", {
              id: String(id).trim(),
              error: e?.message,
            });
          }
        }

        const base = existingDoc ? { ...existingDoc, ...incoming } : { ...incoming };

        for (const key of [
          "amazon_url",
          "amazon_store_url",
          "url",
          "website_url",
          "website",
          "canonical_url",
        ]) {
          base[key] = stripAmazonTagIfString(base[key]);
        }

        base.affiliate_links = stripAmazonTagsFromAffiliateLinks(base.affiliate_links);
        base.affiliate_link_urls = stripAmazonTagsFromUrlArray(base.affiliate_link_urls);

        for (let i = 1; i <= 5; i += 1) {
          base[`affiliate_link_${i}`] = stripAmazonTagIfString(base[`affiliate_link_${i}`]);
          base[`affiliate_link_${i}_url`] = stripAmazonTagIfString(base[`affiliate_link_${i}_url`]);
          base[`affiliate${i}_url`] = stripAmazonTagIfString(base[`affiliate${i}_url`]);
        }

        base.location_sources = stripAmazonTagsFromLocationSources(base.location_sources);
        base.social = stripAmazonTagsFromSocial(base.social);

        // Compute normalized_domain for partition key (Cosmos DB partition key is /normalized_domain)
        const urlForDomain = base.canonical_url || base.url || base.website || "unknown";
        const incomingNormalizedDomain = incoming.normalized_domain || toNormalizedDomain(urlForDomain);
        let normalizedDomain = incomingNormalizedDomain;

        if (existingDoc) {
          const existingNormalizedDomain = String(existingDoc.normalized_domain || "").trim();
          if (existingNormalizedDomain) {
            normalizedDomain = existingNormalizedDomain;
          } else {
            const existingUrlForDomain =
              existingDoc.canonical_url || existingDoc.url || existingDoc.website || "unknown";
            normalizedDomain = toNormalizedDomain(existingUrlForDomain) || incomingNormalizedDomain;
          }
        }

        if (!normalizedDomain) {
          context.log("[companies-list] Unable to determine company domain for partition key");
          return json({ error: "Unable to determine company domain for partition key" }, 400);
        }

        // Use normalized_domain as partition key value
        const partitionKeyValue = String(normalizedDomain).trim();
        context.log("[companies-list] Using partition key (normalized_domain):", partitionKeyValue);

        // Build HQ locations array and geocode per-location (HQ + manufacturing)
        let headquarters_locations = Array.isArray(base.headquarters_locations) ? base.headquarters_locations : [];

        if (base.headquarters_location && String(base.headquarters_location).trim()) {
          const primaryAddr = String(base.headquarters_location).trim();
          const alreadyHasPrimary = headquarters_locations.some((hq) => {
            if (!hq) return false;
            if (typeof hq === "string") return hq.trim() === primaryAddr;
            return typeof hq.address === "string" && String(hq.address).trim() === primaryAddr;
          });
          if (!alreadyHasPrimary) {
            headquarters_locations = [{ address: primaryAddr }, ...headquarters_locations];
          }
        }

        const geoCompany = await geocodeCompanyLocations(base, headquarters_locations, { timeoutMs: 5000 });
        const headquarters = geoCompany.headquarters;
        const manufacturing_geocodes = geoCompany.manufacturing_geocodes;
        const hq_lat = geoCompany.hq_lat;
        const hq_lng = geoCompany.hq_lng;

        // Calculate default rating if not provided
        const hasManufacturingLocations =
          Array.isArray(base.manufacturing_locations) && base.manufacturing_locations.length > 0;
        const hasHeadquarters = !!(base.headquarters_location && String(base.headquarters_location).trim());
        const hasReviews =
          (base.editorial_review_count || 0) > 0 ||
          (base.review_count || 0) > 0 ||
          (base.review_count_approved || 0) > 0;

        const defaultRating = {
          star1: { value: hasManufacturingLocations ? 1.0 : 0.0, notes: [] },
          star2: { value: hasHeadquarters ? 1.0 : 0.0, notes: [] },
          star3: { value: hasReviews ? 1.0 : 0.0, notes: [] },
          star4: { value: 0.0, notes: [] },
          star5: { value: 0.0, notes: [] },
        };

        const rating = normalizeCompanyRating(base.rating || defaultRating);

        const rawVisibility = base.visibility && typeof base.visibility === "object" ? base.visibility : {};
        const visibility = {
          hq_public: rawVisibility.hq_public ?? true,
          manufacturing_public: rawVisibility.manufacturing_public ?? true,
          admin_rating_public: rawVisibility.admin_rating_public ?? true,
        };

        const now = new Date().toISOString();
        const doc = {
          ...base,
          id: String(id).trim(),
          company_id: String(id).trim(),
          normalized_domain: String(normalizedDomain || "unknown").trim(),
          company_name: base.company_name || base.name || "",
          name: base.name || base.company_name || "",
          hq_lat: hq_lat,
          hq_lng: hq_lng,
          headquarters_locations:
            headquarters.length > 0 ? headquarters : base.headquarters_locations,
          headquarters,
          manufacturing_locations: manufacturing_geocodes,
          manufacturing_geocodes,
          rating_icon_type: base.rating_icon_type || "star",
          rating,
          visibility,
          updated_at: now,
          created_at: (existingDoc && existingDoc.created_at) || base.created_at || now,
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
              if (text) body = JSON.parse(text);
            } catch (textErr) {
              context.log("[companies-list] DELETE: Failed to parse request body as JSON or text", {
                jsonErr: jsonErr?.message,
                textErr: textErr?.message,
              });
              return json({ error: "Invalid JSON", detail: textErr?.message }, 400);
            }
          }
        } catch (e) {
          context.log("[companies-list] DELETE: JSON parse error:", { error: e?.message });
          return json({ error: "Invalid JSON", detail: e?.message }, 400);
        }

        const { getContainerPartitionKeyPath, buildPartitionKeyCandidates } = require("../_cosmosPartitionKey");

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

        const requestedId = String(id).trim();
        if (!requestedId) {
          return json({ error: "Invalid id" }, 400);
        }

        try {
          const containerPkPath = await getContainerPartitionKeyPath(container, "/normalized_domain");
          context.log("[companies-list] DELETE: container partition key path resolved", { containerPkPath });

          context.log("[companies-list] DELETE: Querying for document(s) with id:", requestedId);
          const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @id",
            parameters: [{ name: "@id", value: requestedId }],
          };

          const { resources } = await container.items
            .query(querySpec, { enableCrossPartitionQuery: true })
            .fetchAll();

          const docs = Array.isArray(resources) ? resources : [];

          context.log("[companies-list] DELETE query result count:", docs.length);

          if (docs.length === 0) {
            context.log("[companies-list] DELETE no document found for id:", requestedId);
            return json({ error: "Company not found", id: requestedId }, 404);
          }

          const now = new Date().toISOString();
          const actor = (incoming && incoming.actor) || (body && body.actor) || "admin_ui";

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

            const candidates = buildPartitionKeyCandidates({
              doc,
              containerPkPath,
              requestedId,
            });

            let deletedThisDoc = false;

            try {
              const upsertResult = await container.items.upsert(updatedDoc);
              context.log("[companies-list] DELETE: soft-delete upsert succeeded without explicit partition key", {
                id: requestedId,
                itemId: doc.id,
                statusCode: upsertResult?.statusCode,
              });
              softDeleted++;
              deletedThisDoc = true;
              continue;
            } catch (e) {
              context.log("[companies-list] DELETE: soft-delete upsert without explicit partition key failed", {
                id: requestedId,
                itemId: doc.id,
                message: e?.message,
                code: e?.code,
                statusCode: e?.statusCode,
              });
            }

            for (const partitionKeyValue of candidates) {
              if (deletedThisDoc) break;

              try {
                const upsertResult = await container.items.upsert(updatedDoc, { partitionKey: partitionKeyValue });
                context.log("[companies-list] DELETE: soft-delete upsert succeeded", {
                  id: requestedId,
                  itemId: doc.id,
                  partitionKeyValue,
                  statusCode: upsertResult?.statusCode,
                });
                softDeleted++;
                deletedThisDoc = true;
                break;
              } catch (upsertError) {
                context.log("[companies-list] DELETE: soft-delete upsert failed", {
                  id: requestedId,
                  itemId: doc.id,
                  partitionKeyValue,
                  message: upsertError?.message,
                  code: upsertError?.code,
                  statusCode: upsertError?.statusCode,
                });
              }

              try {
                const replaceResult = await container.item(doc.id, partitionKeyValue).replace(updatedDoc);
                context.log("[companies-list] DELETE: soft-delete replace succeeded", {
                  id: requestedId,
                  itemId: doc.id,
                  partitionKeyValue,
                  statusCode: replaceResult?.statusCode,
                });
                softDeleted++;
                deletedThisDoc = true;
                break;
              } catch (replaceError) {
                context.log("[companies-list] DELETE: soft-delete replace failed", {
                  id: requestedId,
                  itemId: doc.id,
                  partitionKeyValue,
                  message: replaceError?.message,
                  code: replaceError?.code,
                  statusCode: replaceError?.statusCode,
                });
              }
            }

            if (deletedThisDoc) continue;

            for (const partitionKeyValue of candidates) {
              if (deletedThisDoc) break;
              try {
                const deleteResult = await container.item(doc.id, partitionKeyValue).delete();
                context.log("[companies-list] DELETE: hard delete succeeded", {
                  id: requestedId,
                  itemId: doc.id,
                  partitionKeyValue,
                  statusCode: deleteResult?.statusCode,
                });
                hardDeleted++;
                deletedThisDoc = true;
                break;
              } catch (deleteError) {
                context.log("[companies-list] DELETE: hard delete failed", {
                  id: requestedId,
                  itemId: doc.id,
                  partitionKeyValue,
                  message: deleteError?.message,
                  code: deleteError?.code,
                  statusCode: deleteError?.statusCode,
                });
              }
            }

            if (!deletedThisDoc) {
              failures.push({
                itemId: doc.id,
                attemptedPartitionKeyCount: candidates.length,
              });
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
          context.log("[companies-list] DELETE error:", {
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
      context.log("[companies-list] Error:", e?.message || e);
      return json({ error: e?.message || "Internal error" }, 500);
    }
  },
});

console.log("[companies-list] ✅ Handler registered successfully with app.http v2");
