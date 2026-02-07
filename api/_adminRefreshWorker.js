/**
 * Admin Refresh Worker - Background processor for admin refresh jobs
 *
 * Called by the queue trigger when reason === "admin_refresh"
 * Processes a single company's enrichment and stores results in the refresh job document.
 */

let CosmosClient;
try {
  ({ CosmosClient } = require("@azure/cosmos"));
} catch {
  CosmosClient = null;
}

const { getXAIEndpoint, getXAIKey, resolveXaiEndpointForModel } = require("./_shared");
const { getBuildInfo } = require("./_buildInfo");
const {
  fetchTagline,
  fetchHeadquartersLocation,
  fetchManufacturingLocations,
  fetchIndustries,
  fetchProductKeywords,
  fetchLogo,
} = require("./_grokEnrichment");
const { geocodeLocationArray } = require("./_geocode");

const BUILD_INFO = getBuildInfo();
const HANDLER_ID = "admin-refresh-worker";

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function nowIso() {
  return new Date().toISOString();
}

function getCompaniesContainer() {
  const endpoint = asString(process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_ENDPOINT).trim();
  const key = asString(process.env.COSMOS_DB_KEY || process.env.COSMOS_KEY).trim();
  const database = asString(process.env.COSMOS_DB_DATABASE || process.env.COSMOS_DB || "tabarnam-db").trim();
  const containerName = asString(process.env.COSMOS_DB_COMPANIES_CONTAINER || process.env.COSMOS_CONTAINER || "companies").trim();

  if (!endpoint || !key) return null;
  if (!CosmosClient) return null;

  const client = new CosmosClient({ endpoint, key });
  return client.database(database).container(containerName);
}

async function loadRefreshJob(container, jobId) {
  const querySpec = {
    query: "SELECT * FROM c WHERE c.id = @id AND c.type = @type",
    parameters: [
      { name: "@id", value: jobId },
      { name: "@type", value: "refresh_job" },
    ],
  };
  const { resources } = await container.items.query(querySpec, { enableCrossPartitionQuery: true }).fetchAll();
  return Array.isArray(resources) && resources.length > 0 ? resources[0] : null;
}

async function patchRefreshJob(container, job, patch) {
  const updated = { ...job, ...patch, updated_at: nowIso() };
  const partitionKey = updated.normalized_domain || "unknown";
  try {
    await container.items.upsert(updated, { partitionKey });
  } catch {
    await container.items.upsert(updated);
  }
  return updated;
}

/**
 * Process an admin refresh job
 * @param {object} queueMessage - The queue message with session_id (job ID), company_ids, etc.
 * @param {object} context - Azure Functions context
 * @returns {object} Result of processing
 */
async function processAdminRefresh(queueMessage, context) {
  const startedAt = Date.now();
  const jobId = asString(queueMessage.session_id).trim();
  const companyIds = Array.isArray(queueMessage.company_ids) ? queueMessage.company_ids : [];

  console.log(JSON.stringify({
    handler_id: HANDLER_ID,
    event: "processing_started",
    job_id: jobId,
    company_ids: companyIds,
    build_id: BUILD_INFO.build_id || null,
  }));

  if (!jobId) {
    return { ok: false, error: "missing_job_id" };
  }

  const container = getCompaniesContainer();
  if (!container) {
    return { ok: false, error: "cosmos_not_configured" };
  }

  // Load the refresh job document
  const job = await loadRefreshJob(container, jobId);
  if (!job) {
    return { ok: false, error: "job_not_found", job_id: jobId };
  }

  // Mark job as in_progress
  await patchRefreshJob(container, job, { status: "in_progress" });

  // Get XAI configuration
  const xaiEndpointRaw = asString(job.xai_config?.xai_url || getXAIEndpoint()).trim();
  const xaiKey = asString(getXAIKey()).trim();
  const xaiModel = asString(job.xai_config?.xai_model || process.env.XAI_MODEL || "grok-4-latest").trim();
  const xaiUrl = xaiEndpointRaw || resolveXaiEndpointForModel(getXAIEndpoint(), xaiModel);

  const companyName = asString(job.company_name).trim();
  const normalizedDomain = asString(job.normalized_domain).trim();

  if (!companyName || !normalizedDomain) {
    await patchRefreshJob(container, job, {
      status: "failed",
      error: "missing_company_info",
      completed_at: nowIso(),
    });
    return { ok: false, error: "missing_company_info", job_id: jobId };
  }

  // Standard budget for background enrichment (15 minutes)
  const budgetMs = 900000;

  console.log(JSON.stringify({
    handler_id: HANDLER_ID,
    event: "enrichment_starting",
    job_id: jobId,
    company_name: companyName,
    normalized_domain: normalizedDomain,
    budget_ms: budgetMs,
    build_id: BUILD_INFO.build_id || null,
  }));

  // Run all enrichments sequentially to avoid overwhelming the XAI API
  // Each gets a generous timeout since we're in a background worker
  const enrichment_status = {
    tagline: "pending",
    headquarters: "pending",
    manufacturing: "pending",
    industries: "pending",
    keywords: "pending",
    logo: "pending",
  };

  const proposed = {
    company_name: companyName,
    normalized_domain: normalizedDomain,
  };

  try {
    // 1. Tagline
    console.log(JSON.stringify({ handler_id: HANDLER_ID, event: "enriching_tagline", job_id: jobId }));
    const taglineResult = await fetchTagline({ companyName, normalizedDomain, budgetMs, xaiUrl, xaiKey });
    if (taglineResult.tagline) {
      proposed.tagline = taglineResult.tagline;
      enrichment_status.tagline = "ok";
    } else {
      enrichment_status.tagline = taglineResult.tagline_status || "empty";
    }

    // 2. HQ Location
    console.log(JSON.stringify({ handler_id: HANDLER_ID, event: "enriching_hq", job_id: jobId }));
    const hqResult = await fetchHeadquartersLocation({ companyName, normalizedDomain, budgetMs, xaiUrl, xaiKey });
    if (hqResult.headquarters_location) {
      proposed.headquarters_location = hqResult.headquarters_location;
      proposed.headquarters_locations = [{
        location: hqResult.headquarters_location,
        formatted: hqResult.headquarters_location,
        is_hq: true,
        source: "xai_refresh",
      }];
      enrichment_status.headquarters = "ok";
    } else {
      enrichment_status.headquarters = hqResult.hq_status || "empty";
    }

    // 3. Manufacturing Locations
    console.log(JSON.stringify({ handler_id: HANDLER_ID, event: "enriching_manufacturing", job_id: jobId }));
    const mfgResult = await fetchManufacturingLocations({ companyName, normalizedDomain, budgetMs, xaiUrl, xaiKey });
    if (Array.isArray(mfgResult.manufacturing_locations) && mfgResult.manufacturing_locations.length > 0) {
      proposed.manufacturing_locations = mfgResult.manufacturing_locations.map(loc => ({
        location: typeof loc === "string" ? loc : loc.location || loc,
        formatted: typeof loc === "string" ? loc : loc.location || loc,
        source: "xai_refresh",
      }));
      enrichment_status.manufacturing = "ok";
    } else {
      enrichment_status.manufacturing = mfgResult.mfg_status || "empty";
    }

    // 4. Industries
    console.log(JSON.stringify({ handler_id: HANDLER_ID, event: "enriching_industries", job_id: jobId }));
    const industriesResult = await fetchIndustries({ companyName, normalizedDomain, budgetMs, xaiUrl, xaiKey });
    if (Array.isArray(industriesResult.industries) && industriesResult.industries.length > 0) {
      proposed.industries = industriesResult.industries;
      enrichment_status.industries = "ok";
    } else {
      enrichment_status.industries = industriesResult.industries_status || "empty";
    }

    // 5. Keywords
    console.log(JSON.stringify({ handler_id: HANDLER_ID, event: "enriching_keywords", job_id: jobId }));
    const keywordsResult = await fetchProductKeywords({ companyName, normalizedDomain, budgetMs, xaiUrl, xaiKey });
    const keywords = keywordsResult.product_keywords || keywordsResult.keywords;
    if (Array.isArray(keywords) && keywords.length > 0) {
      proposed.keywords = keywords;
      enrichment_status.keywords = "ok";
    } else {
      enrichment_status.keywords = keywordsResult.keywords_status || "empty";
    }

    // 6. Logo
    console.log(JSON.stringify({ handler_id: HANDLER_ID, event: "enriching_logo", job_id: jobId }));
    const logoResult = await fetchLogo({ companyName, normalizedDomain, budgetMs, xaiUrl, xaiKey });
    if (logoResult.logo_url) {
      proposed.logo_url = logoResult.logo_url;
      proposed.logo_source = logoResult.logo_source;
      proposed.logo_confidence = logoResult.logo_confidence;
      enrichment_status.logo = "ok";
    } else {
      enrichment_status.logo = logoResult.logo_status || "empty";
    }

    // 7. Geocoding
    console.log(JSON.stringify({ handler_id: HANDLER_ID, event: "geocoding", job_id: jobId }));

    // Geocode manufacturing locations
    if (Array.isArray(proposed.manufacturing_locations) && proposed.manufacturing_locations.length > 0) {
      try {
        const locationStrings = proposed.manufacturing_locations
          .map(loc => typeof loc === "string" ? loc : loc.location || loc.formatted || "")
          .filter(Boolean);

        if (locationStrings.length > 0) {
          const geocoded = await geocodeLocationArray(locationStrings, { timeoutMs: 10000, concurrency: 4 });
          proposed.manufacturing_locations = proposed.manufacturing_locations.map((loc, i) => ({
            ...loc,
            ...(geocoded[i] || {}),
          }));
        }
      } catch (geoErr) {
        console.log(JSON.stringify({
          handler_id: HANDLER_ID,
          event: "geocoding_error",
          location_type: "manufacturing",
          error: geoErr?.message || String(geoErr),
        }));
      }
    }

    // Geocode HQ
    if (proposed.headquarters_location) {
      try {
        const geocoded = await geocodeLocationArray([proposed.headquarters_location], { timeoutMs: 10000, concurrency: 1 });
        if (geocoded[0]) {
          proposed.headquarters_geocode = geocoded[0];
          if (geocoded[0].lat && geocoded[0].lng) {
            proposed.hq_lat = geocoded[0].lat;
            proposed.hq_lng = geocoded[0].lng;
          }
        }
      } catch (geoErr) {
        console.log(JSON.stringify({
          handler_id: HANDLER_ID,
          event: "geocoding_error",
          location_type: "hq",
          error: geoErr?.message || String(geoErr),
        }));
      }
    }

    // Count successful enrichments
    const successCount = Object.values(enrichment_status).filter(s => s === "ok").length;

    // Update job with results
    await patchRefreshJob(container, job, {
      status: successCount > 0 ? "complete" : "failed",
      proposed: successCount > 0 ? proposed : null,
      enrichment_status,
      completed_at: nowIso(),
      error: successCount === 0 ? "no_fields_enriched" : null,
    });

    const elapsedMs = Date.now() - startedAt;

    console.log(JSON.stringify({
      handler_id: HANDLER_ID,
      event: "processing_complete",
      job_id: jobId,
      success_count: successCount,
      enrichment_status,
      elapsed_ms: elapsedMs,
      build_id: BUILD_INFO.build_id || null,
    }));

    return {
      ok: successCount > 0,
      job_id: jobId,
      success_count: successCount,
      enrichment_status,
      elapsed_ms: elapsedMs,
    };

  } catch (e) {
    console.log(JSON.stringify({
      handler_id: HANDLER_ID,
      event: "processing_error",
      job_id: jobId,
      error: e?.message || String(e),
      build_id: BUILD_INFO.build_id || null,
    }));

    await patchRefreshJob(container, job, {
      status: "failed",
      error: e?.message || "Processing error",
      completed_at: nowIso(),
    });

    return { ok: false, error: e?.message || "Processing error", job_id: jobId };
  }
}

module.exports = {
  processAdminRefresh,
};
