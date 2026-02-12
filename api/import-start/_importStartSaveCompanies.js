let CosmosClient;
try {
  ({ CosmosClient } = require("@azure/cosmos"));
} catch {
  CosmosClient = null;
}
const { getCosmosConfig } = require("../_cosmosConfig");
const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
  getValueAtPath,
} = require("../_cosmosPartitionKey");
const { patchCompanyWithSearchText } = require("../_computeSearchText");
const { geocodeLocationArray, pickPrimaryLatLng } = require("../_geocode");
const { computeProfileCompleteness } = require("../_profileCompleteness");
const { stripAmazonAffiliateTagForStorage } = require("../_amazonAffiliate");
const { asMeaningfulString } = require("../_requiredFields");

const {
  normalizeStringArray,
  isRealValue,
  sanitizeIndustries,
  sanitizeKeywords,
} = require("../_requiredFields");

const { resolveReviewsStarState } = require("../_reviewsStarState");
const { mergeCompanyDocsForSession: mergeCompanyDocsForSessionExternal } = require("../_companyDocMerge");
const { applyEnrichment } = require("../_applyEnrichment");

const {
  toNormalizedDomain,
  normalizeIndustries,
  normalizeProductKeywords,
  keywordListToString,
  normalizeLocationEntries,
  normalizeUrlForCompare,
  computeReviewDedupeKey,
  dedupeCuratedReviews,
  buildReviewCursor,
  buildImportLocations,
  toFiniteNumber,
} = require("./_importStartCompanyUtils");

const {
  readItemWithPkCandidates,
  upsertItemWithPkCandidates,
  getCompaniesCosmosContainer,
  getCompaniesPartitionKeyPath: getCompaniesPartitionKeyPathFromCosmos,
  checkIfSessionStopped,
  upsertCosmosImportSessionDoc,
} = require("./_importStartCosmos");

// ── Constants (mirrored from index.js) ────────────────────────────────────────
const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000;
const DEADLINE_SAFETY_BUFFER_MS = 1_500;
const UPSTREAM_TIMEOUT_MARGIN_MS = 1_200;

// ── Helper: lazy-require logo importer ────────────────────────────────────────
function requireImportCompanyLogo() {
  const mod = require("../_logoImport");
  if (!mod || typeof mod.importCompanyLogo !== "function") {
    throw new Error("importCompanyLogo is not available");
  }
  return mod.importCompanyLogo;
}

// ── Helper: geocode company locations ─────────────────────────────────────────
async function geocodeCompanyLocations(company, { timeoutMs = 5000 } = {}) {
  const c = { ...(company || {}) };

  const { headquartersBase, manufacturingBase } = buildImportLocations(c);

  const settled = await Promise.allSettled([
    geocodeLocationArray(headquartersBase, { timeoutMs, concurrency: 4 }),
    geocodeLocationArray(manufacturingBase, { timeoutMs, concurrency: 4 }),
  ]);

  const headquarters = settled[0]?.status === "fulfilled" ? settled[0].value : [];
  const manufacturing_geocodes = settled[1]?.status === "fulfilled" ? settled[1].value : [];

  if (settled[0]?.status === "rejected") {
    console.warn(`[import-start] geocode HQ rejected: ${settled[0]?.reason?.message || String(settled[0]?.reason || "")}`);
  }
  if (settled[1]?.status === "rejected") {
    console.warn(
      `[import-start] geocode manufacturing rejected: ${settled[1]?.reason?.message || String(settled[1]?.reason || "")}`
    );
  }

  const primary = pickPrimaryLatLng(headquarters);

  const hq_lat = primary ? primary.lat : toFiniteNumber(c.hq_lat);
  const hq_lng = primary ? primary.lng : toFiniteNumber(c.hq_lng);

  const manufacturing_locations = manufacturing_geocodes
    .map((loc) => {
      if (typeof loc === "string") return loc.trim();
      if (loc && typeof loc === "object") {
        return String(loc.formatted || loc.full_address || loc.address || "").trim();
      }
      return "";
    })
    .filter((s) => s.length > 0);

  return {
    ...c,
    headquarters,
    headquarters_locations: headquarters,
    manufacturing_locations,
    manufacturing_geocodes,
    hq_lat,
    hq_lng,
  };
}

// ── Helper: geocode HQ location ──────────────────────────────────────────────
async function geocodeHQLocation(address, { timeoutMs = 5000 } = {}) {
  const list = [{ address: String(address || "").trim() }].filter((x) => x.address);
  if (!list.length) return { hq_lat: undefined, hq_lng: undefined };

  const results = await geocodeLocationArray(list, { timeoutMs, concurrency: 1 });
  const primary = pickPrimaryLatLng(results);
  return {
    hq_lat: primary ? primary.lat : undefined,
    hq_lng: primary ? primary.lng : undefined,
  };
}

// Check if company already exists by normalized domain / company name.
// IMPORTANT: Dedupe only against active companies (ignore soft-deleted rows).
async function findExistingCompany(container, normalizedDomain, companyName, canonicalUrl) {
  if (!container) return null;

  const domain = String(normalizedDomain || "").trim();
  const nameValue = String(companyName || "").trim().toLowerCase();

  const notDeletedClause = "(NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)";

  try {
    if (domain && domain !== "unknown") {
      const query = `
        SELECT TOP 1 c.id, c.normalized_domain, c.partition_key, c.canonical_url, c.website_url, c.url, c.import_missing_fields, c.seed_ready, c.source, c.source_stage
        FROM c
        WHERE ${notDeletedClause}
          AND c.normalized_domain = @domain
      `;

      const parameters = [{ name: "@domain", value: domain }];

      const { resources } = await container.items
        .query({ query, parameters }, { enableCrossPartitionQuery: true })
        .fetchAll();

      if (Array.isArray(resources) && resources[0]) {
        return {
          ...resources[0],
          duplicate_match_key: "normalized_domain",
          duplicate_match_value: domain,
        };
      }
    }

    const canonicalRaw = String(canonicalUrl || "").trim();
    const canonicalTrimmed = canonicalRaw.replace(/\/+$/, "");

    let canonicalHost = "";
    try {
      const parsed = canonicalTrimmed
        ? canonicalTrimmed.includes("://")
          ? new URL(canonicalTrimmed)
          : new URL(`https://${canonicalTrimmed}`)
        : null;
      canonicalHost = parsed ? String(parsed.hostname || "").toLowerCase().replace(/^www\./, "") : "";
    } catch {
      canonicalHost = "";
    }

    const canonicalVariants = (() => {
      if (!canonicalHost) return [];
      const variants = [
        `https://${canonicalHost}/`,
        `https://${canonicalHost}`,
        `http://${canonicalHost}/`,
        `http://${canonicalHost}`,
      ];
      return Array.from(new Set(variants.map((v) => String(v).trim()).filter(Boolean)));
    })();

    if (canonicalVariants.length > 0) {
      const params = canonicalVariants.map((value, idx) => ({ name: `@canon${idx}`, value }));
      const clause = canonicalVariants.map((_, idx) => `@canon${idx}`).join(", ");

      const query = `
        SELECT TOP 1 c.id, c.normalized_domain, c.partition_key, c.canonical_url, c.website_url, c.url, c.import_missing_fields, c.seed_ready, c.source, c.source_stage
        FROM c
        WHERE ${notDeletedClause}
          AND (
            c.canonical_url IN (${clause})
            OR c.website_url IN (${clause})
            OR c.url IN (${clause})
          )
      `;

      const { resources } = await container.items
        .query({ query, parameters: params }, { enableCrossPartitionQuery: true })
        .fetchAll();

      if (Array.isArray(resources) && resources[0]) {
        return {
          ...resources[0],
          duplicate_match_key: "canonical_url",
          duplicate_match_value: canonicalVariants[0],
        };
      }
    }

    if (nameValue) {
      const query = `
        SELECT TOP 1 c.id, c.normalized_domain, c.partition_key, c.canonical_url, c.website_url, c.url, c.import_missing_fields, c.seed_ready, c.source, c.source_stage
        FROM c
        WHERE ${notDeletedClause}
          AND LOWER(c.company_name) = @name
      `;

      const parameters = [{ name: "@name", value: nameValue }];

      const { resources } = await container.items
        .query({ query, parameters }, { enableCrossPartitionQuery: true })
        .fetchAll();

      if (Array.isArray(resources) && resources[0]) {
        return {
          ...resources[0],
          duplicate_match_key: "company_name",
          duplicate_match_value: nameValue,
        };
      }
    }

    return null;
  } catch (e) {
    console.warn(`[import-start] Error checking for existing company: ${e.message}`);
    return null;
  }
}

// Helper: import logo (discover -> fetch w/ retries -> rasterize SVG -> upload to blob)
async function fetchLogo({ companyId, companyName, domain, websiteUrl, existingLogoUrl, budgetMs }) {
  const existing = String(existingLogoUrl || "").trim();
  const budget = Number.isFinite(Number(budgetMs)) ? Math.max(0, Math.trunc(Number(budgetMs))) : null;

  const looksLikeCompanyLogoBlobUrl = (u) => {
    const s = String(u || "");
    return s.includes(".blob.core.windows.net") && s.includes("/company-logos/");
  };

  const headCheck = async (u) => {
    const controller = new AbortController();
    const timeoutMs = (() => {
      if (budget == null) return 6000;
      // If the budget is tight, don't burn the whole thing on the HEAD probe.
      return Math.max(900, Math.min(6000, Math.trunc(budget * 0.4)));
    })();

    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(u, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          Accept: "image/svg+xml,image/png,image/jpeg,image/*,*/*",
          "User-Agent": "Mozilla/5.0 (compatible; TabarnamBot/1.0; +https://tabarnam.com)",
        },
      });

      const contentType = String(res.headers.get("content-type") || "");
      const contentLengthRaw = String(res.headers.get("content-length") || "");
      const contentLength = Number.isFinite(Number(contentLengthRaw)) ? Number(contentLengthRaw) : null;

      if (!res.ok) return { ok: false, reason: `head_status_${res.status}` };
      if (!contentType.toLowerCase().startsWith("image/")) return { ok: false, reason: `non_image_${contentType || "unknown"}` };
      if (contentLength != null && contentLength <= 5 * 1024) return { ok: false, reason: `too_small_${contentLength}_bytes` };
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e?.message || "head_failed" };
    } finally {
      clearTimeout(timeout);
    }
  };

  // Only accept an existing logo URL if it's a previously uploaded blob AND it actually exists.
  // Never persist arbitrary / synthetic URLs as logo_url.
  if (existing && looksLikeCompanyLogoBlobUrl(existing)) {
    if (budget != null && budget < 900) {
      return {
        ok: true,
        logo_status: "imported",
        logo_import_status: "imported",
        logo_stage_status: "ok",
        logo_source_url: null,
        logo_source_type: "existing_blob_unverified",
        logo_url: existing,
        logo_error: "",
        logo_discovery_strategy: "existing_blob_unverified",
        logo_discovery_page_url: "",
        logo_telemetry: {
          budget_ms: budget,
          elapsed_ms: 0,
          discovery_ok: null,
          candidates_total: 0,
          candidates_tried: 0,
          tiers: [],
          rejection_reasons: {},
          time_budget_exhausted: true,
        },
      };
    }

    const verified = await headCheck(existing);
    if (verified.ok) {
      return {
        ok: true,
        logo_status: "imported",
        logo_import_status: "imported",
        logo_stage_status: "ok",
        logo_source_url: null,
        logo_source_type: "existing_blob",
        logo_url: existing,
        logo_error: "",
        logo_discovery_strategy: "existing_blob",
        logo_discovery_page_url: "",
        logo_telemetry: {
          budget_ms: budget,
          elapsed_ms: 0,
          discovery_ok: null,
          candidates_total: 0,
          candidates_tried: 0,
          tiers: [{ tier: "existing_blob", attempted: 1, rejected: 0, ok: true, selected_url: existing, selected_content_type: "" }],
          rejection_reasons: {},
          time_budget_exhausted: false,
        },
      };
    }
  }

  if (!domain || domain === "unknown") {
    return {
      ok: true,
      logo_status: "not_found_on_site",
      logo_import_status: "missing",
      logo_source_url: null,
      logo_source_location: null,
      logo_source_domain: null,
      logo_source_type: null,
      logo_url: null,
      logo_error: "missing domain",
      logo_discovery_strategy: "",
      logo_discovery_page_url: "",
    };
  }

  // Only skip if budget is critically low (< 2000ms)
  // Logo discovery needs at least 2s for HTML fetch + parsing + candidate validation
  if (budget != null && budget < 2000) {
    return {
      ok: true,
      logo_status: "not_found_on_site",
      logo_import_status: "missing",
      logo_stage_status: "budget_exhausted",
      logo_source_url: null,
      logo_source_location: null,
      logo_source_domain: null,
      logo_source_type: null,
      logo_url: null,
      logo_error: `Skipped logo import due to low remaining time budget (${budget}ms < 2000ms minimum)`,
      logo_discovery_strategy: "",
      logo_discovery_page_url: "",
      logo_telemetry: {
        budget_ms: budget,
        elapsed_ms: 0,
        discovery_ok: null,
        candidates_total: 0,
        candidates_tried: 0,
        tiers: [],
        rejection_reasons: { budget_exhausted: 1 },
        time_budget_exhausted: true,
      },
    };
  }

  try {
    const importCompanyLogo = requireImportCompanyLogo();
    const result = await importCompanyLogo({ companyId, domain, websiteUrl, companyName }, console, { budgetMs: budget });
    // Always return a structured result, never throw
    return result || {
      ok: true,
      logo_status: "error",
      logo_import_status: "failed",
      logo_stage_status: "exception",
      logo_error: "logo processing returned null/undefined",
      logo_last_error: { code: "NULL_RESULT", message: "logo processing returned null/undefined" },
      logo_source_url: null,
      logo_source_type: null,
      logo_url: null,
      logo_telemetry: { budget_ms: budget, elapsed_ms: 0, candidates_total: 0, candidates_tried: 0, rejection_reasons: { null_result: 1 } },
    };
  } catch (e) {
    // Logo processing failed - convert to non-blocking "skipped" state
    const errorMsg = e?.message || String(e) || "unknown logo processing error";
    console.warn(`[fetchLogo] Logo processing exception (non-blocking): ${errorMsg}`);
    return {
      ok: true, // Non-blocking: logo failure does not fail the import
      logo_status: "skipped",
      logo_import_status: "skipped",
      logo_stage_status: "exception",
      logo_error: `Logo processing failed (non-blocking): ${errorMsg}`,
      logo_last_error: { code: "LOGO_EXCEPTION", message: errorMsg },
      logo_source_url: null,
      logo_source_type: null,
      logo_url: null,
      logo_telemetry: { budget_ms: budget, elapsed_ms: 0, candidates_total: 0, candidates_tried: 0, rejection_reasons: { exception: 1 } },
    };
  }
}

async function saveCompaniesToCosmos({
  companies,
  sessionId,
  requestId,
  sessionCreatedAt,
  axiosTimeout,
  saveStub = false,
  getRemainingMs,
  allowUpdateExisting = false,
}) {
  try {
    const list = Array.isArray(companies) ? companies : [];
    const sid = String(sessionId || "").trim();

    const importRequestId = typeof requestId === "string" && requestId.trim() ? requestId.trim() : null;
    const importCreatedAt =
      typeof sessionCreatedAt === "string" && sessionCreatedAt.trim() ? sessionCreatedAt.trim() : new Date().toISOString();
    const { endpoint, key, databaseId, containerId } = getCosmosConfig();

    if (!endpoint || !key) {
      console.warn("[import-start] Cosmos DB not configured, skipping save");
      return { saved: 0, failed: 0, skipped: 0 };
    }

    if (!CosmosClient) {
      console.warn("[import-start] Cosmos client module unavailable, skipping save");
      return { saved: 0, failed: 0, skipped: 0 };
    }

    const client = new CosmosClient({ endpoint, key });
    const database = client.database(databaseId);
    const container = database.container(containerId);

    let saved = 0;
    let failed = 0;
    let skipped = 0;

    const saved_ids = [];
    const skipped_ids = [];
    const skipped_duplicates = [];
    const failed_items = [];
    const persisted_items = [];

    // Process companies in batches for better concurrency
    const BATCH_SIZE = 4;

    for (let batchStart = 0; batchStart < list.length; batchStart += BATCH_SIZE) {
      // Check if import was stopped
      if (batchStart > 0) {
        const stopped = await checkIfSessionStopped(sid);
        if (stopped) {
          console.log(`[import-start] Import stopped by user after ${saved} companies`);
          break;
        }
      }

      const batch = list.slice(batchStart, Math.min(batchStart + BATCH_SIZE, list.length));

      // Process batch in parallel
      const batchResults = await Promise.all(
        batch.map(async (company, batchIndex) => {
          const companyIndex = batchStart + batchIndex;
          const companyName = company.company_name || company.name || "";

          try {
            const normalizedDomain = toNormalizedDomain(
              company.website_url ||
                company.canonical_url ||
                company.url ||
                company.amazon_url ||
                company.normalized_domain ||
                ""
            );

            const finalNormalizedDomain =
              normalizedDomain && normalizedDomain !== "unknown" ? normalizedDomain : "unknown";

            // If a stub company was saved earlier in the same session, we must UPDATE it (not skip)
            // so enrichment fields get persisted atomically.
            const canonicalUrlForDedupe = String(company.canonical_url || company.website_url || company.url || "").trim();

            const existing = await findExistingCompany(container, normalizedDomain, companyName, canonicalUrlForDedupe);
            let existingDoc = null;
            let shouldUpdateExisting = false;

            if (existing && existing.id) {
              const existingPkCandidate = String(existing.partition_key || existing.normalized_domain || finalNormalizedDomain || "").trim();

              existingDoc = await readItemWithPkCandidates(container, existing.id, {
                id: existing.id,
                normalized_domain: existingPkCandidate || finalNormalizedDomain,
                partition_key: existingPkCandidate || finalNormalizedDomain,
              }).catch(() => null);

              const existingSessionId = String(existingDoc?.import_session_id || existingDoc?.session_id || "").trim();

              const existingMissingFields = Array.isArray(existingDoc?.import_missing_fields) ? existingDoc.import_missing_fields : [];
              const existingLooksLikeSeed =
                Boolean(existingDoc?.seed_ready) ||
                String(existingDoc?.source || "").trim() === "company_url_shortcut" ||
                String(existingDoc?.source_stage || "").trim() === "seed";

              const existingIncomplete = existingLooksLikeSeed || existingMissingFields.length > 0;

              // Reconcile: if the existing record is incomplete (common for seed_fallback), update it instead of creating
              // or leaving behind additional seed rows. Also allow update when the caller explicitly requests it
              // (e.g., company_url imports where the user intentionally re-imports an existing company).
              shouldUpdateExisting = Boolean(
                (existingSessionId && existingSessionId === sid) || existingIncomplete || allowUpdateExisting
              );

              if (!shouldUpdateExisting) {
                console.log(`[import-start] Skipping duplicate company: ${companyName} (${normalizedDomain})`);
                return {
                  type: "skipped",
                  index: companyIndex,
                  company_name: companyName,
                  duplicate_of_id: existing?.id || null,
                  duplicate_match_key: existing?.duplicate_match_key || null,
                  duplicate_match_value: existing?.duplicate_match_value || null,
                };
              }
            }

            // Normalize first so we can decide whether this is worth persisting.
            const industriesNormalized = normalizeIndustries(company.industries);

            const keywordsNormalized = normalizeProductKeywords(company?.keywords || company?.product_keywords, {
              companyName,
              websiteUrl: company.website_url || company.canonical_url || company.url || "",
            }).slice(0, 25);

            const headquartersLocation = String(company.headquarters_location || "").trim();
            const headquartersMeaningful = (() => {
              if (!headquartersLocation) return false;
              const lower = headquartersLocation.toLowerCase();
              if (lower === "unknown" || lower === "n/a" || lower === "na" || lower === "none") return false;
              return true;
            })();

            const manufacturingLocationsNormalized = Array.isArray(company.manufacturing_locations)
              ? company.manufacturing_locations
                  .map((loc) => {
                    if (typeof loc === "string") return loc.trim();
                    if (loc && typeof loc === "object") {
                      return String(loc.formatted || loc.address || loc.location || "").trim();
                    }
                    return "";
                  })
                  .filter(Boolean)
              : [];

            const curatedReviewsNormalized = Array.isArray(company.curated_reviews)
              ? company.curated_reviews.filter((r) => r && typeof r === "object")
              : [];

            const reviewCountNormalized = Number.isFinite(Number(company.review_count))
              ? Number(company.review_count)
              : curatedReviewsNormalized.length;

            const headquartersAttempted =
              headquartersMeaningful ||
              Boolean(
                company?.hq_unknown &&
                  String(company?.hq_unknown_reason || company?.red_flag_reason || "").trim()
              );

            const manufacturingAttempted =
              manufacturingLocationsNormalized.length > 0 ||
              Boolean(
                company?.mfg_unknown &&
                  String(company?.mfg_unknown_reason || company?.red_flag_reason || "").trim()
              );

            const reviewsAttempted =
              curatedReviewsNormalized.length > 0 ||
              reviewCountNormalized > 0 ||
              Boolean(
                company?.review_cursor &&
                  typeof company.review_cursor === "object" &&
                  (company.review_cursor.exhausted || company.review_cursor.last_error)
              );

            const hasMeaningfulEnrichment =
              industriesNormalized.length > 0 ||
              keywordsNormalized.length > 0 ||
              headquartersAttempted ||
              manufacturingAttempted ||
              reviewsAttempted;

            const source = String(company?.source || "").trim();
            const isUrlShortcut = source === "company_url_shortcut";

            // Hard guarantee: never persist a URL shortcut stub unless it has meaningful enrichment.
            // The save_stub flag must NOT override this.
            if (!hasMeaningfulEnrichment && (isUrlShortcut || !saveStub)) {
              return {
                type: "skipped_stub",
                index: companyIndex,
                company_name: companyName,
                normalized_domain: finalNormalizedDomain,
                reason: "missing_enrichment",
              };
            }

            // Determine company ID early (before logo fetch to avoid impact)
            const companyId = shouldUpdateExisting && existingDoc?.id
              ? String(existingDoc.id)
              : `company_${Date.now()}_${Math.random().toString(36).slice(2)}`;

            // IMPORTANT: Logo processing is moved to AFTER Cosmos save to ensure:
            // - Cosmos write succeeds even if sharp/logo processing fails
            // - Logo failures do not block company persistence
            // We'll fetch logo AFTER the document is successfully saved.
            const logoImport = {
              ok: true,
              logo_status: "pending",
              logo_import_status: "pending",
              logo_stage_status: "deferred",
              logo_source_url: null,
              logo_source_location: null,
              logo_source_domain: null,
              logo_source_type: null,
              logo_url: null,
              logo_error: "Logo processing deferred to post-save",
              logo_telemetry: null,
            };

            // Calculate default rating based on company data
            const hasManufacturingLocations =
              Array.isArray(company.manufacturing_locations) && company.manufacturing_locations.length > 0;
            const hasHeadquarters = !!(company.headquarters_location && company.headquarters_location.trim());

            // Check for reviews from curated_reviews or legacy fields
            const hasCuratedReviews = Array.isArray(company.curated_reviews) && company.curated_reviews.length > 0;
            const hasEditorialReviews =
              (company.editorial_review_count || 0) > 0 ||
              (Array.isArray(company.reviews) && company.reviews.length > 0) ||
              hasCuratedReviews;

            const defaultRatingWithReviews = {
              star1: { value: hasManufacturingLocations ? 1.0 : 0.0, notes: [] },
              star2: { value: hasHeadquarters ? 1.0 : 0.0, notes: [] },
              star3: { value: hasEditorialReviews ? 1.0 : 0.0, notes: [] },
              star4: { value: 0.0, notes: [] },
              star5: { value: 0.0, notes: [] },
            };

            const reviewsStarState = resolveReviewsStarState({
              ...company,
              curated_reviews: curatedReviewsNormalized,
              review_count: reviewCountNormalized,
              public_review_count: Math.max(0, Math.trunc(Number(company.public_review_count) || 0)),
              private_review_count: Math.max(0, Math.trunc(Number(company.private_review_count) || 0)),
              rating: defaultRatingWithReviews,
            });

            const nowIso = new Date().toISOString();

            const productKeywordsString = keywordListToString(keywordsNormalized);

            const reviewsLastUpdatedAt =
              typeof company.reviews_last_updated_at === "string" && company.reviews_last_updated_at.trim()
                ? company.reviews_last_updated_at.trim()
                : nowIso;

            const incomingCursor = company.review_cursor && typeof company.review_cursor === "object" ? company.review_cursor : null;

            // Default: NEVER mark the cursor exhausted just because review_count is 0.
            // Exhaustion should be a deliberate signal from an upstream fetch attempt.
            const cursorExhausted =
              incomingCursor && typeof incomingCursor.exhausted === "boolean" ? incomingCursor.exhausted : false;

            const reviewCursorNormalized = incomingCursor
              ? { ...incomingCursor, exhausted: cursorExhausted }
              : buildReviewCursor({
                  nowIso,
                  count: reviewCountNormalized,
                  exhausted: cursorExhausted,
                  last_error: null,
                });

            const doc = {
              id: companyId,
              company_name: companyName,
              name: company.name || companyName,
              url: company.url || company.website_url || company.canonical_url || "",
              website_url: company.website_url || company.canonical_url || company.url || "",
              canonical_url:
                finalNormalizedDomain && finalNormalizedDomain !== "unknown"
                  ? `https://${finalNormalizedDomain}/`
                  : company.canonical_url || company.website_url || company.url || "",
              industries: industriesNormalized,
              product_keywords: productKeywordsString,
              keywords: keywordsNormalized,
              normalized_domain: finalNormalizedDomain,
              partition_key: finalNormalizedDomain,
              logo_url: logoImport.logo_url || null,
              logo_source_url: logoImport.logo_source_url || null,
              logo_source_location: logoImport.logo_source_location || null,
              logo_source_domain: logoImport.logo_source_domain || null,
              logo_source_type: logoImport.logo_source_type || null,
              logo_status: logoImport.logo_status || (logoImport.logo_url ? "imported" : "not_found_on_site"),
              logo_import_status: logoImport.logo_import_status || "missing",
              logo_stage_status:
                typeof logoImport.logo_stage_status === "string" && logoImport.logo_stage_status.trim()
                  ? logoImport.logo_stage_status.trim()
                  : logoImport.logo_url
                    ? "ok"
                    : "not_found_on_site",
              logo_error: logoImport.logo_error || "",
              logo_telemetry: logoImport.logo_telemetry && typeof logoImport.logo_telemetry === "object" ? logoImport.logo_telemetry : null,
              tagline: company.tagline || "",
              location_sources: Array.isArray(company.location_sources) ? company.location_sources : [],
              show_location_sources_to_users: Boolean(company.show_location_sources_to_users),
              hq_lat: company.hq_lat,
              hq_lng: company.hq_lng,
              headquarters_location: headquartersLocation,
              hq_unknown: Boolean(company.hq_unknown),
              hq_unknown_reason: String(company.hq_unknown_reason || "").trim(),
              headquarters_locations: company.headquarters_locations || [],
              headquarters: Array.isArray(company.headquarters)
                ? company.headquarters
                : Array.isArray(company.headquarters_locations)
                  ? company.headquarters_locations
                  : [],
              manufacturing_locations: manufacturingLocationsNormalized,
              mfg_unknown: Boolean(company.mfg_unknown),
              mfg_unknown_reason: String(company.mfg_unknown_reason || "").trim(),
              manufacturing_geocodes: Array.isArray(company.manufacturing_geocodes) ? company.manufacturing_geocodes : [],
              curated_reviews: curatedReviewsNormalized,
              review_count: reviewCountNormalized,
              reviews_last_updated_at: reviewsLastUpdatedAt,
              review_cursor: reviewCursorNormalized,
              reviews_stage_status: (() => {
                const explicit = typeof company.reviews_stage_status === "string" ? company.reviews_stage_status.trim() : "";
                if (explicit) return explicit;

                const cursorStatus =
                  reviewCursorNormalized && typeof reviewCursorNormalized.reviews_stage_status === "string"
                    ? reviewCursorNormalized.reviews_stage_status.trim()
                    : "";
                if (cursorStatus) return cursorStatus;

                if (reviewCursorNormalized && reviewCursorNormalized.last_error) return "upstream_unreachable";
                if (reviewCursorNormalized && reviewCursorNormalized.exhausted) {
                  return reviewCountNormalized > 0 ? "ok" : "no_valid_reviews_found";
                }

                return "pending";
              })(),
              reviews_upstream_status:
                typeof company.reviews_upstream_status === "number"
                  ? company.reviews_upstream_status
                  : reviewCursorNormalized && typeof reviewCursorNormalized.upstream_status === "number"
                    ? reviewCursorNormalized.upstream_status
                    : null,
              red_flag: Boolean(company.red_flag),
              red_flag_reason: company.red_flag_reason || "",
              location_confidence: company.location_confidence || "medium",
              social: company.social || {},
              amazon_url: company.amazon_url || "",
              rating_icon_type: "star",
              reviews_star_value: reviewsStarState.next_value,
              reviews_star_source: reviewsStarState.next_source,
              rating: reviewsStarState.next_rating,
              source: "xai_import",
              session_id: sid,
              import_session_id: sid,
              import_request_id: importRequestId,
              import_created_at: importCreatedAt,
              created_at:
                shouldUpdateExisting && existingDoc && typeof existingDoc.created_at === "string" && existingDoc.created_at.trim()
                  ? existingDoc.created_at.trim()
                  : nowIso,
              updated_at: nowIso,
            };

            // Canonical import contract:
            // - No required field should be absent/undefined after persistence
            // - If we cannot resolve a value, persist a deterministic placeholder + structured warning
            try {
              const asMeaningful = asMeaningfulString;

              const import_missing_fields = [];
              const import_missing_reason = {};
              const import_warnings = [];

              const LOW_QUALITY_MAX_ATTEMPTS = 3;

              const applyLowQualityPolicy = (field, reason) => {
                const f = String(field || "").trim();
                const r = String(reason || "").trim();
                if (!f) return { missing_reason: r || "missing", retryable: true, attemptCount: 0 };

                // We cap repeated attempts for both low_quality and not_found so resume-worker can
                // terminalize these fields and let the session complete.
                const supportsTerminalization = r === "low_quality" || r === "not_found";
                if (!supportsTerminalization) return { missing_reason: r || "missing", retryable: true, attemptCount: 0 };

                const terminalReason = r === "low_quality" ? "low_quality_terminal" : "not_found_terminal";

                // If we previously terminalized this field, keep it terminal.
                const prev = String(import_missing_reason[f] || doc?.import_missing_reason?.[f] || "").trim();
                if (prev === "low_quality_terminal" || prev === "not_found_terminal") {
                  return { missing_reason: prev, retryable: false, attemptCount: LOW_QUALITY_MAX_ATTEMPTS };
                }

                const attemptsObj =
                  doc.import_low_quality_attempts &&
                  typeof doc.import_low_quality_attempts === "object" &&
                  !Array.isArray(doc.import_low_quality_attempts)
                    ? { ...doc.import_low_quality_attempts }
                    : {};

                const metaObj =
                  doc.import_low_quality_attempts_meta &&
                  typeof doc.import_low_quality_attempts_meta === "object" &&
                  !Array.isArray(doc.import_low_quality_attempts_meta)
                    ? { ...doc.import_low_quality_attempts_meta }
                    : {};

                const currentRequestId = String(importRequestId || doc.import_request_id || "").trim();
                const lastRequestId = String(metaObj[f] || "").trim();

                if (currentRequestId && lastRequestId !== currentRequestId) {
                  attemptsObj[f] = (Number(attemptsObj[f]) || 0) + 1;
                  metaObj[f] = currentRequestId;
                }

                doc.import_low_quality_attempts = attemptsObj;
                doc.import_low_quality_attempts_meta = metaObj;

                const attemptCount = Number(attemptsObj[f]) || 0;

                if (attemptCount >= LOW_QUALITY_MAX_ATTEMPTS) {
                  return { missing_reason: terminalReason, retryable: false, attemptCount };
                }

                return { missing_reason: r, retryable: true, attemptCount };
              };

              const ensureMissing = (field, reason, stage, message, retryable = true, source_attempted = "xai") => {
                const f = String(field || "").trim();
                if (!f) return;

                const missing_reason = String(reason || "missing");
                const terminal =
                  missing_reason === "not_disclosed" ||
                  missing_reason === "low_quality_terminal" ||
                  missing_reason === "not_found_terminal";

                if (!import_missing_fields.includes(f)) import_missing_fields.push(f);

                // Prefer final, terminal decisions over earlier seed placeholders.
                // This prevents "seed_from_company_url" from surviving after extractors run.
                const prevReason = String(import_missing_reason[f] || "").trim();
                if (!prevReason || terminal || prevReason === "seed_from_company_url") {
                  import_missing_reason[f] = missing_reason;
                }

                const entry = {
                  field: f,
                  missing_reason,
                  stage: String(stage || "unknown"),
                  source_attempted: String(source_attempted || ""),
                  retryable: Boolean(retryable),
                  terminal,
                  message: String(message || "missing"),
                };

                const existingIndex = import_warnings.findIndex((w) => w && typeof w === "object" && w.field === f);
                if (existingIndex >= 0) import_warnings[existingIndex] = entry;
                else import_warnings.push(entry);
              };

              // company_name (required)
              if (!String(doc.company_name || "").trim()) {
                doc.company_name = "Unknown";
                doc.company_name_unknown = true;
                ensureMissing("company_name", "missing", "primary", "company_name missing; set to placeholder 'Unknown'", false);
              }

              // website_url (required)
              if (!String(doc.website_url || "").trim()) {
                doc.website_url = "Unknown";
                doc.website_url_unknown = true;
                if (!String(doc.normalized_domain || "").trim()) doc.normalized_domain = "unknown";
                if (!String(doc.partition_key || "").trim()) doc.partition_key = doc.normalized_domain;
                ensureMissing("website_url", "missing", "primary", "website_url missing; set to placeholder 'Unknown'", false);
              }

              // industries (required) — quality gate
              const industriesRaw = Array.isArray(doc.industries) ? doc.industries : [];
              const industriesSanitized = sanitizeIndustries(industriesRaw);

              if (industriesSanitized.length === 0) {
                const hadAny = normalizeStringArray(industriesRaw).length > 0;

                // Placeholder hygiene: keep canonical field empty.
                doc.industries = [];
                doc.industries_unknown = true;

                const policy = applyLowQualityPolicy("industries", hadAny ? "low_quality" : "not_found");
                const messageBase = hadAny
                  ? "Industries present but low-quality; cleared industries and marked industries_unknown=true"
                  : "Industries missing; left empty and marked industries_unknown=true";

                const message =
                  policy.missing_reason === "low_quality_terminal"
                    ? `${messageBase} (terminal after ${policy.attemptCount || LOW_QUALITY_MAX_ATTEMPTS} attempts)`
                    : messageBase;

                ensureMissing("industries", policy.missing_reason, "extract_industries", message, policy.retryable);
              } else {
                doc.industries = industriesSanitized;
                doc.industries_unknown = false;
              }

              // keywords/product_keywords (required) — sanitize + quality gate
              if (!Array.isArray(doc.keywords)) doc.keywords = [];

              const keywordStats = sanitizeKeywords({
                product_keywords: doc.product_keywords,
                keywords: doc.keywords,
              });

              const meetsKeywordQuality = isRealValue(
                "product_keywords",
                keywordStats.sanitized.join(", "),
                { ...doc, keywords: keywordStats.sanitized }
              );

              if (meetsKeywordQuality) {
                doc.keywords = keywordStats.sanitized;
                doc.product_keywords = keywordStats.sanitized.join(", ");
                doc.product_keywords_unknown = false;
              } else {
                const hadAny = keywordStats.total_raw > 0;
                doc.keywords = keywordStats.sanitized;

                // Placeholder hygiene: keep canonical field empty.
                doc.product_keywords = "";
                doc.product_keywords_unknown = true;

                const policy = applyLowQualityPolicy("product_keywords", hadAny ? "low_quality" : "not_found");
                const messageBase = hadAny
                  ? `product_keywords low quality (raw=${keywordStats.total_raw}, sanitized=${keywordStats.product_relevant_count}); cleared and marked product_keywords_unknown=true`
                  : "product_keywords missing; left empty and marked product_keywords_unknown=true";

                const message =
                  policy.missing_reason === "low_quality_terminal"
                    ? `${messageBase} (terminal after ${policy.attemptCount || LOW_QUALITY_MAX_ATTEMPTS} attempts)`
                    : messageBase;

                ensureMissing("product_keywords", policy.missing_reason, "extract_keywords", message, policy.retryable);
              }

              // tagline (required)
              const taglineMeaningful = asMeaningful(doc.tagline);
              if (!taglineMeaningful) {
                // Placeholder hygiene: keep canonical field empty.
                doc.tagline = "";
                doc.tagline_unknown = true;
                ensureMissing(
                  "tagline",
                  "not_found",
                  "extract_tagline",
                  "tagline missing; left empty and marked tagline_unknown=true"
                );
              } else {
                doc.tagline_unknown = false;
              }

              // headquarters_location — track in import_missing_fields like all other required fields.
              // (Previously deferred to resume-worker only, but unified enrichment may have populated it.)
              if (typeof doc.headquarters_location !== "string") {
                doc.headquarters_location = doc.headquarters_location == null ? "" : String(doc.headquarters_location);
              }
              if (!doc.headquarters_location.trim() || doc.headquarters_location === "Not disclosed") {
                if (doc.hq_unknown_reason === "not_disclosed" || doc.headquarters_location === "Not disclosed") {
                  // Explicitly not disclosed — terminal, not retryable
                } else {
                  const policy = applyLowQualityPolicy("headquarters_location", "not_found");
                  ensureMissing(
                    "headquarters_location",
                    policy.missing_reason,
                    "extract_hq",
                    "headquarters_location missing after seed/enrichment",
                    policy.retryable
                  );
                }
              }

              // manufacturing_locations — same treatment as HQ.
              if (!Array.isArray(doc.manufacturing_locations)) {
                doc.manufacturing_locations = doc.manufacturing_locations == null ? [] : [doc.manufacturing_locations];
              }
              doc.manufacturing_locations = doc.manufacturing_locations
                .map((v) => (typeof v === "string" ? v : v == null ? "" : String(v)))
                .map((v) => v.trim())
                .filter(Boolean);

              if (doc.manufacturing_locations.length === 0) {
                if (doc.mfg_unknown_reason === "not_disclosed") {
                  // Explicitly not disclosed — terminal, not retryable
                } else {
                  const policy = applyLowQualityPolicy("manufacturing_locations", "not_found");
                  ensureMissing(
                    "manufacturing_locations",
                    policy.missing_reason,
                    "extract_mfg",
                    "manufacturing_locations missing after seed/enrichment",
                    policy.retryable
                  );
                }
              }

              // reviews (required fields can be empty, but must be explicitly set)
              if (!Array.isArray(doc.curated_reviews)) doc.curated_reviews = [];
              if (!Number.isFinite(Number(doc.review_count))) doc.review_count = doc.curated_reviews.length;
              if (!(doc.review_cursor && typeof doc.review_cursor === "object")) {
                doc.review_cursor = reviewCursorNormalized;
              }
              if (!String(doc.reviews_last_updated_at || "").trim()) doc.reviews_last_updated_at = nowIso;
              if (!(typeof doc.reviews_stage_status === "string" && doc.reviews_stage_status.trim())) {
                doc.reviews_stage_status = "pending";
              }

              // logo (required: ok OR explicit not_found)
              if (!String(doc.logo_url || "").trim()) {
                doc.logo_url = null;
                if (!String(doc.logo_status || "").trim()) doc.logo_status = "not_found_on_site";
                if (!String(doc.logo_import_status || "").trim()) doc.logo_import_status = "missing";
                if (!String(doc.logo_stage_status || "").trim()) doc.logo_stage_status = "not_found_on_site";
                ensureMissing("logo", String(doc.logo_status || "not_found"), "logo", "logo_url missing; persisted as explicit not_found");
              }

              // A compact checklist used by import-status (resume detection + UI).
              doc.import_missing_fields = import_missing_fields;
              doc.import_missing_reason = import_missing_reason;
              doc.import_warnings = import_warnings;

              // Back-compat field used by some tooling.
              doc.missing_fields = import_missing_fields
                .map((f) => {
                  if (f === "headquarters_location") return "hq";
                  if (f === "manufacturing_locations") return "mfg";
                  if (f === "website_url") return "website_url";
                  return f;
                })
                .filter(Boolean);
              doc.missing_fields_updated_at = nowIso;
            } catch (validationErr) {
              console.warn(`[import-start] session=${sid} company[${companyIndex}] field validation error: ${validationErr?.message || validationErr}`);
            }

            try {
              const completeness = computeProfileCompleteness(doc);
              doc.profile_completeness = completeness.profile_completeness;
              doc.profile_completeness_version = completeness.profile_completeness_version;
              doc.profile_completeness_meta = completeness.profile_completeness_meta;
            } catch (completenessErr) {
              console.warn(`[import-start] session=${sid} company[${companyIndex}] profile completeness error: ${completenessErr?.message || completenessErr}`);
            }

            if (!doc.company_name && !doc.url) {
              return {
                type: "failed",
                index: companyIndex,
                company_name: companyName,
                error: "Missing company_name and url",
              };
            }

            if (shouldUpdateExisting && existingDoc) {
              const mergedDoc = mergeCompanyDocsForSessionExternal({
                existingDoc,
                incomingDoc: doc,
                finalNormalizedDomain,
              });

              const expectedPk = String(existingDoc?.normalized_domain || existingDoc?.partition_key || "").trim() || undefined;

              const enriched = await applyEnrichment({
                container,
                company_id: String(existingDoc.id),
                expected_partition_key: expectedPk,
                patch: mergedDoc,
                meta: {
                  stage: "save_companies_merge",
                  upstream: {
                    provider: "import-start",
                    summary: "mergeCompanyDocsForSession",
                  },
                },
              });

              if (!enriched?.ok) {
                try {
                  await upsertCosmosImportSessionDoc({
                    sessionId: sid,
                    requestId,
                    patch: {
                      enrichment_last_write_error: {
                        at: new Date().toISOString(),
                        company_id: String(existingDoc.id),
                        stage: "save_companies_merge",
                        root_cause: enriched?.root_cause || "enrichment_write_failed",
                        retryable: Boolean(enriched?.retryable),
                        expected_partition_key: enriched?.expected_partition_key || null,
                        actual_partition_key: enriched?.actual_partition_key || null,
                        error: enriched?.error || null,
                      },
                    },
                  }).catch(() => null);
                } catch {}

                throw new Error(enriched?.error || enriched?.root_cause || "enrichment_write_failed");
              }

              return {
                type: "updated",
                index: companyIndex,
                id: String(existingDoc.id),
                company_name: companyName,
                normalized_domain: String(existingDoc?.normalized_domain || finalNormalizedDomain || ""),
              };
            }

            // Seed write: include an enrichment event so the persisted company doc always contains
            // a durable trace even if later stages cannot run.
            doc.enrichment_version = 1;
            doc.enrichment_updated_at = nowIso;
            doc.enrichment_events = [
              {
                stage: "seed_save",
                started_at: nowIso,
                ended_at: nowIso,
                ok: true,
                root_cause: null,
                retryable: false,
                fields_written: [
                  "company_name",
                  "website_url",
                  "normalized_domain",
                  "logo_url",
                  "headquarters_location",
                  "manufacturing_locations",
                  "industries",
                  "product_keywords",
                  "tagline",
                  "curated_reviews",
                  "review_count",
                  "import_missing_fields",
                ],
              },
            ];

            // ABSOLUTE GUARANTEE: logo processing can never block Cosmos save
            // Remove all logo-derived fields if logo processing failed or was skipped
            if (
              doc.logo_stage_status === "skipped" ||
              doc.logo_stage_status === "exception" ||
              doc.logo_error ||
              doc.logo_last_error
            ) {
              delete doc.logo_blob_url;
              delete doc.logo_png_url;
              delete doc.logo_metadata;
              delete doc.logo_dimensions;
              delete doc.logo_url;
              delete doc.logo_source_url;
              delete doc.logo_source_location;
              delete doc.logo_source_domain;
              delete doc.logo_source_type;
              delete doc.logo_status;
              delete doc.logo_import_status;
              delete doc.logo_telemetry;
              // Keep logo_stage_status and logo_error for diagnostics
            }

            // Clean up temporary properties from unified enrichment before persisting
            delete doc._unified_reviews;
            delete doc._unified_reviews_status;
            delete doc._unified_enrichment_done;

            const upsertRes = await upsertItemWithPkCandidates(container, doc);
            if (!upsertRes?.ok) {
              throw new Error(upsertRes?.error || "upsert_failed");
            }

            // AFTER successful Cosmos save: process logo (non-blocking, fire-and-forget)
            // This ensures the company document is persisted even if logo processing fails
            (async () => {
              try {
                const remainingForLogo =
                  typeof getRemainingMs === "function"
                    ? Number(getRemainingMs())
                    : Number.isFinite(Number(axiosTimeout))
                      ? Number(axiosTimeout)
                      : DEFAULT_UPSTREAM_TIMEOUT_MS;

                // Logo fetching is important - give it a generous budget
                // Minimum 5000ms to ensure logo discovery + upload can complete
                // Maximum 15000ms to avoid blocking other work
                const logoBudgetMs = Math.max(
                  5000,
                  Math.min(
                    15000,
                    Math.trunc(remainingForLogo - DEADLINE_SAFETY_BUFFER_MS - UPSTREAM_TIMEOUT_MARGIN_MS)
                  )
                );

                const logoImportResult = await fetchLogo({
                  companyId,
                  companyName,
                  domain: finalNormalizedDomain,
                  websiteUrl: company.website_url || company.canonical_url || company.url || "",
                  existingLogoUrl: company.logo_url || existingDoc?.logo_url || null,
                  budgetMs: logoBudgetMs,
                });

                // Update document with logo information (non-blocking on failure)
                if (logoImportResult && logoImportResult.logo_url) {
                  const logoUpdateDoc = {
                    id: companyId,
                    normalized_domain: finalNormalizedDomain,
                    partition_key: finalNormalizedDomain,
                    logo_url: logoImportResult.logo_url || null,
                    logo_source_url: logoImportResult.logo_source_url || null,
                    logo_source_location: logoImportResult.logo_source_location || null,
                    logo_source_domain: logoImportResult.logo_source_domain || null,
                    logo_source_type: logoImportResult.logo_source_type || null,
                    logo_status: logoImportResult.logo_status || "imported",
                    logo_import_status: logoImportResult.logo_import_status || "imported",
                    logo_stage_status: logoImportResult.logo_stage_status || "ok",
                    logo_error: logoImportResult.logo_error || "",
                    logo_telemetry: logoImportResult.logo_telemetry || null,
                  };

                  // Attempt update but don't fail if it doesn't work
                  await upsertItemWithPkCandidates(container, logoUpdateDoc).catch((err) => {
                    console.warn(`[import-start] Failed to update logo for company ${companyId}: ${err?.message || String(err)}`);
                  });
                }
              } catch (err) {
                // Logo processing error is logged but does not fail the save
                console.warn(`[import-start] Post-save logo processing error for company ${companyId}: ${err?.message || String(err)}`);
              }
            })().catch(() => {
              // Swallow any errors from the async logo processing
            });

            return {
              type: "saved",
              index: companyIndex,
              id: companyId,
              company_name: companyName,
              normalized_domain: finalNormalizedDomain,
            };
          } catch (e) {
            const statusCode = Number(e?.code || e?.statusCode || e?.status || 0);
            if (statusCode === 409) {
              return {
                type: "skipped",
                index: companyIndex,
                company_name: companyName,
                duplicate_of_id: null,
                duplicate_match_key: null,
                duplicate_match_value: null,
              };
            }

            return {
              type: "failed",
              index: companyIndex,
              company_name: companyName,
              error: e?.message ? String(e.message) : String(e || "save_failed"),
            };
          }
        })
      );

      // Process batch results
      for (const result of batchResults) {
        if (!result || typeof result !== "object") continue;

        if (result.type === "skipped_stub") {
          skipped++;
          skipped_duplicates.push({
            index: Number.isFinite(Number(result.index)) ? Number(result.index) : null,
            company_name: String(result.company_name || ""),
            duplicate_of_id: null,
            duplicate_match_key: "skipped_stub",
            duplicate_match_value: result.reason || "missing_enrichment",
          });
          continue;
        }

        if (result.type === "skipped") {
          skipped++;
          if (result.duplicate_of_id) skipped_ids.push(result.duplicate_of_id);
          skipped_duplicates.push({
            index: Number.isFinite(Number(result.index)) ? Number(result.index) : null,
            company_name: String(result.company_name || ""),
            duplicate_of_id: result.duplicate_of_id || null,
            duplicate_match_key: result.duplicate_match_key || null,
            duplicate_match_value: result.duplicate_match_value || null,
          });
          continue;
        }

        if (result.type === "saved" || result.type === "updated") {
          saved++;
          if (result.id) {
            saved_ids.push(result.id);
            persisted_items.push({
              type: result.type,
              index: Number.isFinite(Number(result.index)) ? Number(result.index) : null,
              id: String(result.id),
              company_name: String(result.company_name || ""),
              normalized_domain: String(result.normalized_domain || ""),
            });
          }
          continue;
        }

        if (result.type === "failed") {
          failed++;
          failed_items.push({
            index: Number.isFinite(Number(result.index)) ? Number(result.index) : null,
            company_name: result.company_name || "",
            error: result.error || "save_failed",
          });
          console.warn(`[import-start] Failed to save company: ${result.error || "save_failed"}`);
        }
      }
    }

    return { saved, failed, skipped, saved_ids, skipped_ids, skipped_duplicates, failed_items, persisted_items };
  } catch (e) {
    console.error("[import-start] Error in saveCompaniesToCosmos:", e.message);
    return {
      saved: 0,
      failed: Array.isArray(companies) ? companies.length : 0,
      skipped: 0,
      saved_ids: [],
      skipped_ids: [],
      skipped_duplicates: [],
      failed_items: [{ index: null, company_name: "", error: e?.message || String(e || "save_failed") }],
    };
  }
}

module.exports = {
  saveCompaniesToCosmos,
  geocodeCompanyLocations,
  geocodeHQLocation,
  findExistingCompany,
  fetchLogo,
  requireImportCompanyLogo,
};
