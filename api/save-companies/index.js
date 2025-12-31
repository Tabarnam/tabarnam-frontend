let app;
try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {} };
}

const axios = require("axios");
let CosmosClient;
try {
  ({ CosmosClient } = require("@azure/cosmos"));
} catch {
  CosmosClient = null;
}

const { stripAmazonAffiliateTagForStorage } = require("../_amazonAffiliate");
const { geocodeLocationArray, pickPrimaryLatLng } = require("../_geocode");
const { computeProfileCompleteness } = require("../_profileCompleteness");
const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
  getValueAtPath,
} = require("../_cosmosPartitionKey");

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

function toNormalizedDomain(s = "") {
  try {
    const raw = String(s || "").trim();
    if (!raw) return "";

    const ensured = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
    const u = new URL(ensured);
    const host = String(u.hostname || "")
      .toLowerCase()
      .replace(/^www\./, "")
      .trim();

    return host;
  } catch {
    return "";
  }
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

let cosmosCompaniesClient = null;
let companiesPkPathPromise;

function getCompaniesCosmosContainer() {
  try {
    const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
    const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

    if (!endpoint || !key) return null;
    if (!CosmosClient) return null;

    cosmosCompaniesClient ||= new CosmosClient({ endpoint, key });
    return cosmosCompaniesClient.database(databaseId).container(containerId);
  } catch {
    return null;
  }
}

async function getCompaniesPartitionKeyPath(container) {
  if (!container) return "/normalized_domain";
  companiesPkPathPromise ||= getContainerPartitionKeyPath(container, "/normalized_domain");
  try {
    return await companiesPkPathPromise;
  } catch {
    return "/normalized_domain";
  }
}

function buildImportControlDocBase(sessionId) {
  return {
    session_id: sessionId,
    normalized_domain: "import",
    partition_key: "import",
    type: "import_control",
    updated_at: new Date().toISOString(),
  };
}

async function readItemWithPkCandidates(container, id, docForCandidates) {
  if (!container || !id) return null;
  const containerPkPath = await getCompaniesPartitionKeyPath(container);

  const candidates = buildPartitionKeyCandidates({
    doc: docForCandidates,
    containerPkPath,
    requestedId: id,
  });

  let lastErr = null;
  for (const partitionKeyValue of candidates) {
    try {
      const item =
        partitionKeyValue !== undefined
          ? container.item(id, partitionKeyValue)
          : container.item(id);
      const { resource } = await item.read();
      return resource || null;
    } catch (e) {
      lastErr = e;
      if (e?.code === 404) return null;
    }
  }

  if (lastErr && lastErr.code !== 404) {
    console.warn(`[save-companies] readItem failed id=${id} pkPath=${containerPkPath}: ${lastErr.message}`);
  }

  return null;
}

async function upsertItemWithPkCandidates(container, doc) {
  if (!container || !doc) return { ok: false, error: "no_container" };
  const id = String(doc.id || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  const containerPkPath = await getCompaniesPartitionKeyPath(container);
  const pkValue = getValueAtPath(doc, containerPkPath);
  const candidates = buildPartitionKeyCandidates({ doc, containerPkPath, requestedId: id });

  let lastErr = null;
  for (const partitionKeyValue of candidates) {
    try {
      if (partitionKeyValue !== undefined) {
        await container.items.upsert(doc, { partitionKey: partitionKeyValue });
      } else if (pkValue !== undefined) {
        await container.items.upsert(doc, { partitionKey: pkValue });
      } else {
        await container.items.upsert(doc);
      }
      return { ok: true };
    } catch (e) {
      lastErr = e;
    }
  }

  return { ok: false, error: lastErr?.message || "upsert_failed" };
}

async function upsertCosmosImportSessionDoc({ sessionId, requestId, patch }) {
  try {
    const sid = String(sessionId || "").trim();
    if (!sid) return { ok: false, error: "missing_session_id" };

    const container = getCompaniesCosmosContainer();
    if (!container) return { ok: false, error: "no_container" };

    const id = `_import_session_${sid}`;

    const existing = await readItemWithPkCandidates(container, id, {
      id,
      ...buildImportControlDocBase(sid),
      created_at: "",
    });

    const createdAt = existing?.created_at || new Date().toISOString();
    const existingRequest = existing?.request && typeof existing.request === "object" ? existing.request : null;

    const sessionDoc = {
      id,
      ...buildImportControlDocBase(sid),
      created_at: createdAt,
      request_id: requestId,
      ...(existingRequest ? { request: existingRequest } : {}),
      ...(patch && typeof patch === "object" ? patch : {}),
    };

    return await upsertItemWithPkCandidates(container, sessionDoc);
  } catch (e) {
    return { ok: false, error: e?.message || String(e || "session_upsert_failed") };
  }
}

async function findExistingCompany(container, normalizedDomain, companyName) {
  if (!container) return null;

  const domain = String(normalizedDomain || "").trim();
  const name = String(companyName || "").trim();
  const nameLower = name.toLowerCase();

  const notDeletedClause = "(NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)";

  try {
    if (domain && domain !== "unknown") {
      const q = {
        query: `SELECT TOP 1 c.id, c.normalized_domain FROM c WHERE NOT STARTSWITH(c.id, '_import_') AND ${notDeletedClause} AND c.normalized_domain = @domain`,
        parameters: [{ name: "@domain", value: domain }],
      };

      const { resources } = await container.items
        .query(q, { enableCrossPartitionQuery: true })
        .fetchAll();

      if (Array.isArray(resources) && resources[0]) {
        return {
          ...resources[0],
          duplicate_match_key: "normalized_domain",
          duplicate_match_value: domain,
        };
      }
    }

    if (nameLower) {
      const q = {
        query: `SELECT TOP 1 c.id, c.company_name, c.name FROM c WHERE NOT STARTSWITH(c.id, '_import_') AND ${notDeletedClause} AND (LOWER(c.company_name) = @name OR LOWER(c.name) = @name)`,
        parameters: [{ name: "@name", value: nameLower }],
      };

      const { resources } = await container.items
        .query(q, { enableCrossPartitionQuery: true })
        .fetchAll();

      if (Array.isArray(resources) && resources[0]) {
        return {
          ...resources[0],
          duplicate_match_key: "company_name",
          duplicate_match_value: nameLower,
        };
      }
    }
  } catch (e) {
    console.warn(`[save-companies] duplicate check failed: ${e?.message || String(e)}`);
  }

  return null;
}

app.http("save-companies", {
  route: "save-companies",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return {
        status: 200,
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

    const requestId =
      (context && typeof context.invocationId === "string" && context.invocationId.trim()
        ? context.invocationId.trim()
        : "") || `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    try {
      const container = getCompaniesCosmosContainer();
      if (!container) {
        const cfg = {
          has_cosmos_module: Boolean(CosmosClient),
          has_endpoint: Boolean((process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim()),
          has_key: Boolean((process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim()),
          databaseId: (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim(),
          containerId: (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim(),
        };
        return json({ ok: false, error: "Cosmos DB not configured", details: cfg }, 500);
      }

      const bodyObj = await req.json().catch(() => ({}));
      const companies = bodyObj.companies || [];
      if (!Array.isArray(companies) || companies.length === 0) {
        return json({ ok: false, error: "companies array required" }, 400);
      }

      const providedSessionId = typeof bodyObj.session_id === "string" ? bodyObj.session_id.trim() : "";
      const useProvidedSession = Boolean(providedSessionId);

      const sessionId = useProvidedSession
        ? providedSessionId
        : `manual_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      let saved = 0;
      let skipped = 0;
      let failed = 0;

      const saved_ids = [];
      const skipped_ids = [];
      const skipped_duplicates = [];
      const failed_items = [];
      const errors = [];

      for (const company of companies) {
        const companyName = String(company?.company_name || company?.name || "").trim();

        try {
          // Validate logo_url is not a temporary blob URL
          if (company?.logo_url && typeof company.logo_url === "string") {
            if (company.logo_url.startsWith("blob:")) {
              failed += 1;
              errors.push(
                `Invalid logo URL for "${companyName || "(unknown)"}": Must be a permanent storage link, not a temporary blob URL`
              );
              failed_items.push({
                index: null,
                company_name: companyName,
                error: "Invalid logo_url (blob:)",
              });
              continue;
            }
          }

          const baseUrl = String(company?.website_url || company?.canonical_url || company?.url || "").trim();
          const cleanUrl = baseUrl ? stripAmazonAffiliateTagForStorage(baseUrl) : "";

          const normalizedDomainRaw =
            toNormalizedDomain(cleanUrl) ||
            toNormalizedDomain(company?.normalized_domain) ||
            toNormalizedDomain(company?.amazon_url) ||
            "";

          const normalizedDomain = normalizedDomainRaw ? normalizedDomainRaw : "unknown";

          const existing = await findExistingCompany(container, normalizedDomain, companyName);
          if (existing) {
            skipped += 1;
            if (existing?.id) skipped_ids.push(existing.id);
            skipped_duplicates.push({
              company_name: companyName,
              duplicate_of_id: existing?.id || null,
              duplicate_match_key: existing?.duplicate_match_key || null,
              duplicate_match_value: existing?.duplicate_match_value || null,
              normalized_domain: normalizedDomain,
            });
            continue;
          }

          // Build HQ location array (primary + additional) and geocode per-location
          let headquarters_locations = Array.isArray(company?.headquarters_locations)
            ? company.headquarters_locations
            : [];

          if (company?.headquarters_location && String(company.headquarters_location).trim()) {
            const primaryAddr = String(company.headquarters_location).trim();
            const alreadyHasPrimary = headquarters_locations.some((hq) => {
              if (!hq) return false;
              if (typeof hq === "string") return hq.trim() === primaryAddr;
              return typeof hq.address === "string" && hq.address.trim() === primaryAddr;
            });

            if (!alreadyHasPrimary) {
              headquarters_locations = [{ address: primaryAddr }, ...headquarters_locations];
            }
          }

          const geoCompany = await geocodeCompanyLocations(company || {}, headquarters_locations, { timeoutMs: 5000 });
          const headquarters = geoCompany.headquarters;
          const manufacturing_geocodes = geoCompany.manufacturing_geocodes;
          const hq_lat = geoCompany.hq_lat;
          const hq_lng = geoCompany.hq_lng;

          const hasManufacturingLocations =
            Array.isArray(company?.manufacturing_locations) && company.manufacturing_locations.length > 0;
          const hasHeadquarters = !!(company?.headquarters_location && String(company.headquarters_location).trim());
          const hasReviews =
            (company?.editorial_review_count || 0) > 0 ||
            (Array.isArray(company?.reviews) && company.reviews.length > 0) ||
            (Array.isArray(company?.curated_reviews) && company.curated_reviews.length > 0);

          const defaultRating = {
            star1: { value: hasManufacturingLocations ? 1.0 : 0.0, notes: [] },
            star2: { value: hasHeadquarters ? 1.0 : 0.0, notes: [] },
            star3: { value: hasReviews ? 1.0 : 0.0, notes: [] },
            star4: { value: 0.0, notes: [] },
            star5: { value: 0.0, notes: [] },
          };

          const nowIso = new Date().toISOString();
          const companyId = `company_${Date.now()}_${Math.random().toString(36).slice(2)}`;

          const doc = {
            id: companyId,
            company_name: companyName,
            name: String(company?.name || companyName || ""),
            url: cleanUrl || String(company?.url || ""),
            website_url: cleanUrl || String(company?.website_url || company?.url || ""),
            industries: Array.isArray(company?.industries) ? company.industries : [],
            product_keywords: String(company?.product_keywords || ""),
            keywords: Array.isArray(company?.keywords) ? company.keywords : [],
            normalized_domain: normalizedDomain,

            logo_url: company?.logo_url || null,
            logo_source_url: company?.logo_source_url || null,
            logo_source_location: company?.logo_source_location || null,
            logo_source_domain: company?.logo_source_domain || null,
            logo_source_type: company?.logo_source_type || null,
            logo_status: company?.logo_status || (company?.logo_url ? "imported" : "missing"),
            logo_import_status: company?.logo_import_status || (company?.logo_url ? "present" : "missing"),
            logo_error: String(company?.logo_error || ""),

            tagline: String(company?.tagline || ""),
            location_sources: Array.isArray(company?.location_sources) ? company.location_sources : [],
            show_location_sources_to_users: Boolean(company?.show_location_sources_to_users),

            hq_lat,
            hq_lng,
            headquarters_location: String(company?.headquarters_location || ""),
            headquarters_locations: headquarters.length > 0 ? headquarters : company?.headquarters_locations,
            headquarters,

            manufacturing_locations: Array.isArray(manufacturing_geocodes) ? manufacturing_geocodes : [],
            manufacturing_geocodes,

            curated_reviews: Array.isArray(company?.curated_reviews) ? company.curated_reviews : [],
            red_flag: Boolean(company?.red_flag),
            red_flag_reason: String(company?.red_flag_reason || ""),
            location_confidence: String(company?.location_confidence || "medium"),
            social: company?.social && typeof company.social === "object" ? company.social : {},
            amazon_url: String(company?.amazon_url || ""),

            rating_icon_type: String(company?.rating_icon_type || "star"),
            rating: company?.rating && typeof company.rating === "object" ? company.rating : defaultRating,

            source:
              typeof company?.source === "string" && company.source.trim()
                ? company.source.trim()
                : useProvidedSession
                  ? "admin_import"
                  : "manual_import",

            session_id: sessionId,
            created_at: nowIso,
            updated_at: nowIso,
          };

          if (!doc.company_name && !doc.url) {
            skipped += 1;
            errors.push("Skipped entry: no company_name or url");
            continue;
          }

          const created = await container.items.create(doc);
          saved += 1;
          const savedId = created?.resource?.id || doc.id;
          if (savedId) saved_ids.push(savedId);
        } catch (e) {
          const statusCode = Number(e?.code || e?.statusCode || e?.status || 0);
          if (statusCode === 409) {
            skipped += 1;
            continue;
          }

          failed += 1;
          const msg = `Failed to save "${companyName || "(unknown)"}": ${e?.message || String(e)}`;
          errors.push(msg);
          failed_items.push({
            index: null,
            company_name: companyName,
            error: e?.message ? String(e.message) : String(e || "save_failed"),
          });
        }
      }

      // If this save is part of an import session, finalize the import control docs so /api/import/status
      // and /api/import/progress are consistent (report.completion not null, session.status not stuck).
      if (useProvidedSession) {
        const completedAt = new Date().toISOString();
        const completionId = `_import_complete_${sessionId}`;

        const existingCompletion = await readItemWithPkCandidates(container, completionId, {
          id: completionId,
          ...buildImportControlDocBase(sessionId),
          completed_at: "",
        });

        if (!existingCompletion) {
          const completionDoc = {
            id: completionId,
            ...buildImportControlDocBase(sessionId),
            completed_at: completedAt,
            elapsed_ms: null,
            reason: "saved_from_admin",
            saved,
            skipped,
            failed,
            saved_ids,
            skipped_ids,
            skipped_duplicates,
            failed_items,
          };

          const upsertCompletion = await upsertItemWithPkCandidates(container, completionDoc);
          if (!upsertCompletion.ok) {
            console.warn(
              `[save-companies] request_id=${requestId} session=${sessionId} failed to upsert completion marker: ${upsertCompletion.error}`
            );
          }
        }

        await upsertCosmosImportSessionDoc({
          sessionId,
          requestId,
          patch: {
            status: "complete",
            stage_beacon: "cosmos_write_done",
            saved,
            skipped,
            failed,
            completed_at: completedAt,
          },
        }).catch(() => null);
      }

      return json(
        {
          ok: true,
          saved,
          skipped,
          failed,
          total: companies.length,
          session_id: sessionId,
          saved_ids,
          skipped_ids,
          skipped_duplicates: skipped_duplicates.length > 0 ? skipped_duplicates : [],
          failed_items: failed_items.length > 0 ? failed_items : [],
          errors: errors.length > 0 ? errors : undefined,
        },
        200
      );
    } catch (e) {
      return json({ ok: false, error: `Database error: ${e?.message || String(e)}` }, 500);
    }
  },
});
