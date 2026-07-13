const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');
const { computeReputationQualityScores } = require("../_companyScoring");
const { writeCompanyEditHistoryEntry } = require("../_companyEditHistory");

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

async function adminScoreCompanyHandler(req, context, deps = {}) {
  const method = String(req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return { status: 200, headers: getCorsHeaders() };
  }

  // deps is an optional injection point for tests (container + scorer); prod uses
  // the real Cosmos container and xAI scorer.
  const computeScores = deps.computeScores || computeReputationQualityScores;
  const companiesContainer = deps.container || getCompaniesContainer();
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

    // Initialize rating object if missing. Track whether the STORED doc already had
    // a /rating object — the field-scoped patch below sets /rating/star4 and
    // /rating/star5 sub-paths, which requires /rating to exist in storage.
    const ratingExistedInStore = Boolean(company.rating && typeof company.rating === "object");
    if (!company.rating || typeof company.rating !== "object") {
      company.rating = {};
    }

    // Snapshot before scoring mutates rating, for the score-history diff.
    const companyBefore = JSON.parse(JSON.stringify(company));

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
    const scoring = await computeScores(company, { timeoutMs: 60000, debug });
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

    const newStar4 = { ...existingStar4, value: scoring.reputation_score, reasoning: scoring.reputation_reasoning, insufficient_data: insufficientData };
    const newStar5 = { ...existingStar5, value: scoring.quality_score, reasoning: scoring.quality_reasoning, insufficient_data: insufficientData };
    const nowIso = new Date().toISOString();
    // Keep the in-memory copy consistent for the history diff below.
    company.rating.star4 = newStar4;
    company.rating.star5 = newStar5;
    company.updated_at = nowIso;

    // Persist ONLY the rating scores via a field-scoped Cosmos patch. This handler
    // runs as a separate request seconds after Save & Close, so a full-doc upsert of
    // the snapshot read at the top of the handler can clobber concurrent admin edits
    // (unknown_manufacturing, no_amazon_store, amazon_url_approved, star1/star2…) if
    // the read was stale. A patch touches only the listed paths and cannot drop other
    // fields.
    const partitionKeyValue = String(normalizedDomain || company.normalized_domain || "unknown").trim();
    const patchOps = [];
    if (!ratingExistedInStore) patchOps.push({ op: "add", path: "/rating", value: {} });
    patchOps.push({ op: "set", path: "/rating/star4", value: newStar4 });
    patchOps.push({ op: "set", path: "/rating/star5", value: newStar5 });
    patchOps.push({ op: "set", path: "/updated_at", value: nowIso });
    try {
      await companiesContainer.item(companyId, partitionKeyValue).patch(patchOps);
    } catch (patchErr) {
      // Recovery: re-read the CURRENT doc and set only the two stars on it, so we
      // still never write back the stale top-of-handler snapshot.
      context.log(`[admin-score-company] rating patch failed, re-read+merge fallback: ${patchErr?.message || patchErr}`);
      const { resource: fresh } = await companiesContainer.item(companyId, partitionKeyValue).read();
      const target = fresh && typeof fresh === "object" ? fresh : company;
      if (!target.rating || typeof target.rating !== "object") target.rating = {};
      target.rating.star4 = newStar4;
      target.rating.star5 = newStar5;
      target.updated_at = nowIso;
      await companiesContainer.items.upsert(target, { partitionKey: partitionKeyValue });
    }

    // Re-read the persisted doc so the response + score-history reflect the real
    // current state (admin flags intact), not the possibly-stale top-of-handler
    // snapshot. The caller replaces its list row with `company`, so this must be fresh.
    try {
      const { resource: persisted } = await companiesContainer.item(companyId, partitionKeyValue).read();
      if (persisted && typeof persisted === "object") company = persisted;
    } catch { /* keep in-memory company */ }

    context.log(`[admin-score-company] Scored ${company.company_name || normalizedDomain}: star4=${scoring.reputation_score.toFixed(2)}, star5=${scoring.quality_score.toFixed(2)}, duration=${(durationMs / 1000).toFixed(1)}s`);

    // Best-effort score-history entry (never blocks scoring).
    try {
      await writeCompanyEditHistoryEntry({
        company_id: String(company.company_id || company.id || companyId || "").trim(),
        actor_email: (req && req.__admin_email) || undefined,
        actor_user_id: (req && req.__admin_email) || undefined,
        action: "score_rescore",
        source: "manual-rescore",
        before: companyBefore,
        after: company,
        trigger: { type: "manual_rescore" },
      });
    } catch (e) {
      context.log(`[admin-score-company] history write failed: ${e?.message || e}`);
    }

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
  handler: require("../_adminAuth").withAdminGuard(adminScoreCompanyHandler),
});

module.exports = { handler: adminScoreCompanyHandler, _test: { adminScoreCompanyHandler } };
