const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');
const { computeReputationQualityScores } = require("../_companyScoring");

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

const json = (obj, status = 200) => ({
  status,
  headers: getCorsHeaders(),
  body: JSON.stringify(obj),
});

let cosmosClient = null;

function getCosmosClient() {
  const endpoint = E("COSMOS_DB_ENDPOINT");
  const key = E("COSMOS_DB_KEY");
  if (!endpoint || !key) return null;
  cosmosClient ||= require("../_cosmosConfig").getCosmosClient();
  return cosmosClient;
}

function getCompaniesContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_COMPANIES_CONTAINER", "companies");
  return client.database(databaseId).container(containerId);
}

async function adminScoreCompanyHandler(req, context) {
  const method = String(req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return { status: 200, headers: getCorsHeaders() };
  }

  const companiesContainer = getCompaniesContainer();
  if (!companiesContainer) {
    return json({ error: "Cosmos DB not configured" }, 500);
  }

  try {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const companyId = String(body?.company_id || "").trim();
    const normalizedDomain = String(body?.normalized_domain || "").trim();
    const force = Boolean(body?.force);
    const debug = Boolean(body?.debug);
    const propose = Boolean(body?.propose);

    if (!companyId || !normalizedDomain) {
      return json({ error: "Missing company_id or normalized_domain" }, 400);
    }

    // Load company from Cosmos DB
    let company;
    try {
      const { resource } = await companiesContainer.item(companyId, normalizedDomain).read();
      company = resource;
    } catch (e) {
      return json({ error: `Company not found: ${e?.message || e}` }, 404);
    }

    if (!company) {
      return json({ error: "Company not found" }, 404);
    }

    // Initialize rating object if missing
    if (!company.rating || typeof company.rating !== "object") {
      company.rating = {};
    }

    // Idempotency: skip if star4 already has a value (unless force or propose).
    // Propose mode always runs — it returns a non-persistent proposal for admin review.
    const existingStar4Value = company.rating?.star4?.value;
    if (existingStar4Value > 0 && !force && !propose) {
      return json({
        ok: true,
        skipped: true,
        reason: "star4 already populated (pass force: true to re-score, or propose: true for a non-persistent proposal)",
        star4: existingStar4Value,
        star5: company.rating?.star5?.value ?? 0,
      });
    }

    // Run scoring
    const startMs = Date.now();
    const scoring = await computeReputationQualityScores(company, { timeoutMs: 60000, debug });
    const durationMs = Date.now() - startMs;

    if (!scoring.ok) {
      return json({
        ok: false,
        reason: scoring.reason,
        duration_ms: durationMs,
        ...(debug ? { _debug: { prompt: scoring._debug_prompt, response: scoring._debug_response } } : {}),
      }, 422);
    }

    // Propose mode: return proposal without writing to Cosmos
    if (propose) {
      context.log(`[admin-score-company] Proposed ${company.company_name || normalizedDomain}: star4=${scoring.reputation_score.toFixed(2)}, star5=${scoring.quality_score.toFixed(2)}, duration=${(durationMs / 1000).toFixed(1)}s`);
      return json({
        ok: true,
        proposed: true,
        proposal: {
          star4_value: scoring.reputation_score,
          star4_reasoning: scoring.reputation_reasoning,
          star5_value: scoring.quality_score,
          star5_reasoning: scoring.quality_reasoning,
        },
        current: {
          star4_value: company.rating?.star4?.value ?? null,
          star4_reasoning: company.rating?.star4?.reasoning || "",
          star5_value: company.rating?.star5?.value ?? null,
          star5_reasoning: company.rating?.star5?.reasoning || "",
        },
        duration_ms: durationMs,
        company_name: company.company_name,
        ...(debug ? { _debug: { prompt: scoring._debug_prompt, response: scoring._debug_response, parsed: scoring._debug_parsed } } : {}),
      });
    }

    // Apply scores — preserve existing notes
    const existingStar4 = company.rating.star4 && typeof company.rating.star4 === "object"
      ? company.rating.star4 : { value: 0, notes: [] };
    const existingStar5 = company.rating.star5 && typeof company.rating.star5 === "object"
      ? company.rating.star5 : { value: 0, notes: [] };

    // Mark whether this was the skip-short-circuit (no xAI call — insufficient
    // data). The backfill "needs scoring" predicate re-scores these once the
    // company gains data; a real score clears the marker. See api/_scoringStatus.js.
    const insufficientData = scoring.skipped_xai_call === true;

    company.rating.star4 = { ...existingStar4, value: scoring.reputation_score, reasoning: scoring.reputation_reasoning, insufficient_data: insufficientData };
    company.rating.star5 = { ...existingStar5, value: scoring.quality_score, reasoning: scoring.quality_reasoning, insufficient_data: insufficientData };
    company.updated_at = new Date().toISOString();

    // Upsert to Cosmos DB
    const partitionKeyValue = String(company.normalized_domain || "unknown").trim();
    await companiesContainer.items.upsert(company, { partitionKey: partitionKeyValue });

    context.log(`[admin-score-company] Scored ${company.company_name || normalizedDomain}: star4=${scoring.reputation_score.toFixed(2)}, star5=${scoring.quality_score.toFixed(2)}, duration=${(durationMs / 1000).toFixed(1)}s`);

    return json({
      ok: true,
      star4: scoring.reputation_score,
      star5: scoring.quality_score,
      duration_ms: durationMs,
      company_name: company.company_name,
      // Return the updated company so the caller (e.g. admin editor auto-rescore
      // on save) can patch its in-memory draft and row without a follow-up GET.
      company,
      ...(debug ? { _debug: { prompt: scoring._debug_prompt, response: scoring._debug_response, parsed: scoring._debug_parsed } } : {}),
    });

  } catch (e) {
    context.log("Error in admin-score-company:", e?.message || e, e?.stack || "");
    return json({ error: e?.message || "Internal error", stack: e?.stack || "" }, 500);
  }
}

app.http('adminScoreCompany', {
  route: 'xadmin-api-score-company',
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: adminScoreCompanyHandler,
});

module.exports = { handler: adminScoreCompanyHandler };
