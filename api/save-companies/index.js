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

function requireImportCompanyLogo() {
  const mod = require("../_logoImport");
  if (!mod || typeof mod.importCompanyLogo !== "function") {
    throw new Error("importCompanyLogo is not available");
  }
  return mod.importCompanyLogo;
}

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

function normalizeIncludeOnSaveFlag(value, fallback = undefined) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (!v) return fallback;
    if (["true", "1", "yes", "y", "on"].includes(v)) return true;
    if (["false", "0", "no", "n", "off"].includes(v)) return false;
  }
  return fallback;
}

function normalizeCuratedReviewsForSave(company) {
  const curated = Array.isArray(company?.curated_reviews) ? company.curated_reviews : [];
  const legacy = Array.isArray(company?.reviews) ? company.reviews : [];

  const incoming = curated.length > 0 && legacy.length > 0 ? curated.concat(legacy) : curated.length > 0 ? curated : legacy;

  const out = [];
  const seen = new Set();

  for (const r of incoming) {
    if (!r || typeof r !== "object") continue;

    const includeFlag = normalizeIncludeOnSaveFlag(r?.include_on_save ?? r?.includeOnSave ?? r?.include, undefined);
    if (includeFlag === false) continue;

    const id = typeof r?.id === "string" ? r.id.trim() : "";
    const urlRaw = typeof r?.source_url === "string" ? r.source_url : typeof r?.url === "string" ? r.url : "";
    const key = id || String(urlRaw || "").trim().toLowerCase();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);

    const showToUsers = normalizeIncludeOnSaveFlag(
      r?.show_to_users ?? r?.showToUsers ?? r?.is_public ?? r?.visible_to_users ?? r?.visible,
      true
    );

    const rating = typeof r?.rating === "number" ? r.rating : typeof r?.rating === "string" && r.rating.trim() ? Number(r.rating) : null;

    out.push({
      ...(r || {}),
      include_on_save: true,
      visibility: typeof r?.visibility === "string" && r.visibility.trim() ? r.visibility.trim() : "public",
      rating: typeof rating === "number" && Number.isFinite(rating) ? rating : null,
      show_to_users: showToUsers,
      is_public: showToUsers,
    });
  }

  return out;
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

      // Canonical import completeness contract + session warnings.
      // Keep the same shape as import-start so /import/status and admin UI can diagnose missing fields.
      const warningKeys = new Set();
      const warnings_detail = {};
      const warnings_v2 = [];

      const addWarning = (warningKey, detail) => {
        const k = String(warningKey || "").trim();
        if (!k) return;
        warningKeys.add(k);

        const d = detail && typeof detail === "object" ? detail : {};
        if (!warnings_detail[k]) {
          warnings_detail[k] = {
            stage: String(d.stage || k),
            root_cause: String(d.root_cause || k),
            retryable: Boolean(d.retryable),
            message: String(d.message || "warning"),
            company_name: typeof d.company_name === "string" && d.company_name.trim() ? d.company_name.trim() : undefined,
            website_url: typeof d.website_url === "string" && d.website_url.trim() ? d.website_url.trim() : undefined,
          };
        }

        warnings_v2.push({
          key: k,
          at: new Date().toISOString(),
          ...warnings_detail[k],
        });
      };

      let importCompanyLogo = null;
      try {
        importCompanyLogo = requireImportCompanyLogo();
      } catch (e) {
        importCompanyLogo = null;
        try {
          console.warn(`[save-companies] Logo importer unavailable: ${e?.message || String(e)}`);
        } catch {}
      }

      const looksLikeCompanyLogoBlobUrl = (u) => {
        const s = String(u || "");
        return s.includes(".blob.core.windows.net") && s.includes("/company-logos/");
      };

      for (let companyIndex = 0; companyIndex < companies.length; companyIndex += 1) {
        const company = companies[companyIndex];
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

          const existingLogoUrl = String(company?.logo_url || "").trim();
          const providedLogoSourceUrl = String(company?.logo_source_url || "").trim();

          let logoImport = null;
          const shouldTryLogo = Boolean(importCompanyLogo && normalizedDomain && normalizedDomain !== "unknown" && cleanUrl);

          if (shouldTryLogo && !looksLikeCompanyLogoBlobUrl(existingLogoUrl)) {
            try {
              logoImport = await importCompanyLogo(
                {
                  companyId,
                  domain: normalizedDomain,
                  websiteUrl: cleanUrl,
                  companyName,
                  logoSourceUrl: providedLogoSourceUrl || existingLogoUrl || undefined,
                },
                console
              );
            } catch (e) {
              logoImport = {
                ok: false,
                logo_status: "error",
                logo_import_status: "failed",
                logo_error: e?.message || String(e),
                logo_source_url: providedLogoSourceUrl || null,
                logo_source_type: providedLogoSourceUrl ? "provided" : null,
                logo_url: null,
              };
            }
          }

          const resolvedLogoUrl =
            String(logoImport?.logo_url || "").trim() || (looksLikeCompanyLogoBlobUrl(existingLogoUrl) ? existingLogoUrl : "");

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
            partition_key: normalizedDomain,

            logo_url: resolvedLogoUrl ? resolvedLogoUrl : null,
            logo_source_url: logoImport?.logo_source_url || (looksLikeCompanyLogoBlobUrl(existingLogoUrl) ? company?.logo_source_url || null : null),
            logo_source_location: logoImport?.logo_source_location || null,
            logo_source_domain: logoImport?.logo_source_domain || null,
            logo_source_type: logoImport?.logo_source_type || (looksLikeCompanyLogoBlobUrl(existingLogoUrl) ? company?.logo_source_type || null : null),
            logo_status: logoImport?.logo_status || (resolvedLogoUrl ? "imported" : "not_found_on_site"),
            logo_import_status: logoImport?.logo_import_status || (resolvedLogoUrl ? "imported" : "missing"),
            logo_stage_status:
              typeof logoImport?.logo_stage_status === "string" && logoImport.logo_stage_status.trim()
                ? logoImport.logo_stage_status.trim()
                : resolvedLogoUrl
                  ? "ok"
                  : "not_found_on_site",
            logo_error: String(logoImport?.logo_error || ""),
            logo_telemetry: logoImport?.logo_telemetry && typeof logoImport.logo_telemetry === "object" ? logoImport.logo_telemetry : null,
            logo_discovery_strategy: String(logoImport?.logo_discovery_strategy || ""),
            logo_discovery_page_url: String(logoImport?.logo_discovery_page_url || ""),

            tagline: String(company?.tagline || ""),
            location_sources: Array.isArray(company?.location_sources) ? company.location_sources : [],
            show_location_sources_to_users: Boolean(company?.show_location_sources_to_users),

            hq_lat,
            hq_lng,
            headquarters_location: String(company?.headquarters_location || ""),
            headquarters_locations: headquarters.length > 0 ? headquarters : company?.headquarters_locations,
            headquarters,

            manufacturing_locations: Array.isArray(company?.manufacturing_locations)
              ? company.manufacturing_locations
              : Array.isArray(manufacturing_geocodes)
                ? manufacturing_geocodes
                : [],
            manufacturing_geocodes,

            curated_reviews: normalizeCuratedReviewsForSave(company),
            review_count: Number.isFinite(Number(company?.review_count))
              ? Number(company.review_count)
              : Number.isFinite(Number(company?.editorial_review_count))
                ? Number(company.editorial_review_count)
                : normalizeCuratedReviewsForSave(company).length,
            reviews_last_updated_at: String(company?.reviews_last_updated_at || nowIso),
            reviews_stage_status:
              typeof company?.reviews_stage_status === "string" && company.reviews_stage_status.trim()
                ? company.reviews_stage_status.trim()
                : null,

            import_session_id: sessionId,
            import_session: sessionId,
            import_request_id: requestId,
            import_created_at: nowIso,
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

          try {
            const completeness = computeProfileCompleteness(doc);
            doc.profile_completeness = completeness.profile_completeness;
            doc.profile_completeness_version = completeness.profile_completeness_version;
            doc.profile_completeness_meta = completeness.profile_completeness_meta;
          } catch {}

          // Save-companies is frequently used as the final step of an import session.
          // Enforce the same canonical “usable import” contract as import-start:
          // always persist deterministic placeholders + per-company diagnostics.
          try {
            const asMeaningful = (v) => {
              const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
              if (!s) return "";
              const lower = s.toLowerCase();
              if (lower === "unknown" || lower === "n/a" || lower === "na" || lower === "none") return "";
              return s;
            };

            const import_missing_fields = Array.isArray(doc.import_missing_fields)
              ? doc.import_missing_fields.map((v) => String(v || "").trim()).filter(Boolean)
              : [];

            const import_missing_reason =
              doc.import_missing_reason && typeof doc.import_missing_reason === "object" && !Array.isArray(doc.import_missing_reason)
                ? { ...doc.import_missing_reason }
                : {};

            const import_warnings = Array.isArray(doc.import_warnings)
              ? doc.import_warnings.filter((w) => w && typeof w === "object")
              : [];

            const ensureMissing = (field, reason, message, retryable = true) => {
              const f = String(field || "").trim();
              if (!f) return;
              if (!import_missing_fields.includes(f)) import_missing_fields.push(f);
              if (!import_missing_reason[f]) import_missing_reason[f] = String(reason || "missing");
              import_warnings.push({
                field: f,
                root_cause: f,
                retryable: Boolean(retryable),
                message: String(message || "missing"),
              });

              addWarning(`import_missing_${f}_${companyIndex}`, {
                stage: "save",
                root_cause: `missing_${f}`,
                retryable: Boolean(retryable),
                message: String(message || "missing"),
                company_name: String(doc.company_name || "").trim(),
                website_url: String(doc.website_url || "").trim(),
              });
            };

            // Compute missing_fields (used by import-status/progress) BEFORE placeholders.
            try {
              const missing_fields = [];

              const industries = Array.isArray(doc.industries) ? doc.industries : [];
              const industriesMeaningful = industries.filter((v) => asMeaningful(v));
              if (industriesMeaningful.length === 0) missing_fields.push("industries");

              const keywords = Array.isArray(doc.keywords) ? doc.keywords : [];
              const pk = asMeaningful(doc.product_keywords);
              const hasKeywords = pk || keywords.some((k) => asMeaningful(k));
              if (!hasKeywords) missing_fields.push("product_keywords");

              const hqMeaningful = asMeaningful(doc.headquarters_location);
              if (!hqMeaningful) missing_fields.push("hq");

              const mfgList = Array.isArray(doc.manufacturing_locations) ? doc.manufacturing_locations : [];
              const mfgHas = mfgList.some((m) => {
                if (typeof m === "string") return Boolean(asMeaningful(m));
                if (m && typeof m === "object") {
                  return Boolean(asMeaningful(m.formatted || m.address || m.location || m.full_address));
                }
                return false;
              });
              if (!mfgHas) missing_fields.push("mfg");

              const curated = Array.isArray(doc.curated_reviews) ? doc.curated_reviews : [];
              const reviewCount = Number.isFinite(Number(doc.review_count)) ? Number(doc.review_count) : curated.length;
              const hasReviews = curated.length > 0 || reviewCount > 0;
              if (!hasReviews) missing_fields.push("reviews");

              if (!asMeaningful(doc.logo_url)) missing_fields.push("logo");

              doc.missing_fields = missing_fields;
              doc.missing_fields_updated_at = nowIso;
            } catch {}

            // company_name
            if (!String(doc.company_name || "").trim()) {
              doc.company_name = "Unknown";
              doc.company_name_unknown = true;
              ensureMissing("company_name", "missing", "company_name missing; set to placeholder 'Unknown'", false);
            }

            // website_url
            if (!String(doc.website_url || "").trim()) {
              doc.website_url = "Unknown";
              doc.website_url_unknown = true;
              if (!String(doc.normalized_domain || "").trim()) doc.normalized_domain = "unknown";
              if (!String(doc.partition_key || "").trim()) doc.partition_key = doc.normalized_domain;
              ensureMissing("website_url", "missing", "website_url missing; set to placeholder 'Unknown'", false);
            }

            // industries
            if (!Array.isArray(doc.industries) || doc.industries.filter((v) => asMeaningful(v)).length === 0) {
              doc.industries = ["Unknown"];
              doc.industries_unknown = true;
              ensureMissing("industries", "not_found", "Industries missing; set to placeholder ['Unknown']");
            }

            // product_keywords (ensure deterministic)
            const kwList = Array.isArray(doc.keywords) ? doc.keywords.map((k) => String(k || "").trim()).filter(Boolean) : [];
            const pkRaw = String(doc.product_keywords || "").trim();
            if (!pkRaw && kwList.length > 0) {
              doc.product_keywords = kwList.join(", ");
            }

            const pkFixed = String(doc.product_keywords || "").trim();
            const hasAnyKeywords = Boolean(pkFixed) || kwList.length > 0;
            if (!hasAnyKeywords) {
              doc.product_keywords = "Unknown";
              if (!Array.isArray(doc.keywords)) doc.keywords = [];
              ensureMissing("product_keywords", "not_found", "product_keywords missing; set to placeholder 'Unknown'");
            }

            // tagline (required)
            if (!asMeaningful(doc.tagline)) {
              doc.tagline = "Unknown";
              doc.tagline_unknown = true;
              ensureMissing("tagline", "not_found", "tagline missing; set to placeholder 'Unknown'");
            }

            // headquarters
            const hqExisting = String(doc.headquarters_location || "").trim();
            const hqFromGeo = Array.isArray(headquarters) && headquarters[0]
              ? String(headquarters[0].formatted || headquarters[0].address || headquarters[0].full_address || "").trim()
              : "";
            if (!hqExisting && hqFromGeo) {
              doc.headquarters_location = hqFromGeo;
            }

            if (!String(doc.headquarters_location || "").trim()) {
              doc.headquarters_location = "Unknown";
              doc.hq_unknown = true;
              doc.hq_unknown_reason = String(doc.hq_unknown_reason || "unknown");
              ensureMissing(
                "headquarters_location",
                doc.hq_unknown_reason,
                "headquarters_location missing; set to placeholder 'Unknown'"
              );
            }

            // manufacturing
            const mfgList = Array.isArray(doc.manufacturing_locations) ? doc.manufacturing_locations : [];
            if (mfgList.length === 0) {
              doc.manufacturing_locations = ["Unknown"];
              doc.mfg_unknown = true;
              doc.mfg_unknown_reason = String(doc.mfg_unknown_reason || "unknown");
              ensureMissing(
                "manufacturing_locations",
                doc.mfg_unknown_reason,
                "manufacturing_locations missing; set to placeholder ['Unknown']"
              );
            }

            // logo
            if (!String(doc.logo_url || "").trim()) {
              doc.logo_url = null;
              doc.logo_status = doc.logo_status || "not_found_on_site";
              doc.logo_import_status = doc.logo_import_status || "missing";
              doc.logo_stage_status = doc.logo_stage_status || "not_found_on_site";
              ensureMissing("logo", doc.logo_stage_status, "logo_url missing or not imported");
            }

            // curated reviews
            if (!Array.isArray(doc.curated_reviews)) doc.curated_reviews = [];
            if (!Number.isFinite(Number(doc.review_count))) doc.review_count = doc.curated_reviews.length;
            if (!String(doc.reviews_last_updated_at || "").trim()) doc.reviews_last_updated_at = nowIso;
            if (!(typeof doc.reviews_stage_status === "string" && doc.reviews_stage_status.trim())) {
              doc.reviews_stage_status = doc.curated_reviews.length > 0 || Number(doc.review_count) > 0 ? "ok" : "no_valid_reviews_found";
            }

            if (doc.curated_reviews.length === 0) {
              ensureMissing(
                "curated_reviews",
                String(doc.reviews_stage_status || "none"),
                "curated_reviews empty (persisted as empty list)"
              );
            }

            doc.import_missing_fields = import_missing_fields;
            doc.import_missing_reason = import_missing_reason;
            doc.import_warnings = import_warnings;
          } catch {
            // Never block admin saves on completeness enforcement.
          }

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
          const warningKeyList = Array.from(warningKeys);
          const completionReason = warningKeyList.length ? "completed_with_warnings" : "saved_from_admin";

          const completionDoc = {
            id: completionId,
            ...buildImportControlDocBase(sessionId),
            completed_at: completedAt,
            elapsed_ms: null,
            reason: completionReason,
            saved,
            skipped,
            failed,
            saved_ids,
            skipped_ids,
            skipped_duplicates,
            failed_items,
            ...(warningKeyList.length
              ? {
                  warnings: warningKeyList,
                  warnings_detail,
                  warnings_v2,
                }
              : {}),
          };

          const upsertCompletion = await upsertItemWithPkCandidates(container, completionDoc);
          if (!upsertCompletion.ok) {
            console.warn(
              `[save-companies] request_id=${requestId} session=${sessionId} failed to upsert completion marker: ${upsertCompletion.error}`
            );
          }
        }

        const warningKeyListForSession = Array.from(warningKeys);

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
            ...(warningKeyListForSession.length
              ? {
                  warnings: warningKeyListForSession,
                  warnings_detail,
                  warnings_v2,
                }
              : {}),
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
