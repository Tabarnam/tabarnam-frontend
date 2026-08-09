/**
 * Queue worker for the two-phase manufacturing backfill (HQ-echo remediation).
 *
 * Phase 1 ("propose"): each message names one company from a backfill job.
 * The worker runs an mfg-only canonical enrichment call (current prompt
 * guidance — HQ-echo guard + customs probe) and stores the PROPOSED value on
 * the job doc in `backfill_jobs`. It never writes to the company doc — the
 * operator reviews the proposal diff and applies it via
 * xadmin-api-backfill-mfg { action: "apply" }.
 *
 * Queue: mfg-backfill (plain JSON — host.json messageEncoding "none").
 * Registered from api/index.js (v4 model: unregistered modules never run).
 * Gated to the dedicated worker like the other background functions.
 */

const { app } = require("../_app");
const { runCanonicalImportCall } = require("../_canonicalImport");
const { getCosmosClient } = require("../_cosmosConfig");

const IS_DEDICATED_WORKER = String(process.env.WEBSITE_SITE_NAME || "")
  .toLowerCase()
  .includes("dedicated");

const DB_ID = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const CALL_BUDGET_MS = 240_000;

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

async function loadCompany(companiesContainer, companyId, normalizedDomain) {
  if (normalizedDomain) {
    try {
      const { resource } = await companiesContainer.item(companyId, normalizedDomain).read();
      if (resource) return resource;
    } catch {}
  }
  const { resources } = await companiesContainer.items
    .query({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: companyId }] })
    .fetchAll();
  return resources[0] || null;
}

async function patchJobProposal(jobsContainer, jobId, companyId, proposal) {
  // Cosmos partial-document patch keeps concurrent workers (queue batchSize 2)
  // from clobbering each other's proposals via read-modify-write races.
  const ops = [
    { op: "set", path: `/proposals/${companyId}`, value: proposal },
    { op: "incr", path: "/completed", value: 1 },
  ];
  try {
    await jobsContainer.item(jobId, jobId).patch(ops);
  } catch (e) {
    // add fails if /proposals key path is unusual; fall back to read-modify-write once.
    try {
      const { resource } = await jobsContainer.item(jobId, jobId).read();
      if (!resource) throw e;
      resource.proposals = resource.proposals || {};
      resource.proposals[companyId] = proposal;
      resource.completed = (resource.completed || 0) + 1;
      await jobsContainer.items.upsert(resource, { partitionKey: jobId });
    } catch (e2) {
      console.error(`[mfg-backfill-worker] job_patch_failed`, {
        job_id: jobId,
        company_id: companyId,
        error: String(e2?.message || e2),
      });
    }
  }
}

async function processMessage(item, context) {
  const body = typeof item === "string" ? JSON.parse(item) : item || {};
  const jobId = asString(body.job_id).trim();
  const companyId = asString(body.company_id).trim();
  const normalizedDomain = asString(body.normalized_domain).trim();
  if (!jobId || !companyId) {
    console.warn(`[mfg-backfill-worker] bad_message`, { job_id: jobId, company_id: companyId });
    return;
  }

  const client = getCosmosClient();
  const db = client.database(DB_ID);
  const companies = db.container(process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies");
  const jobs = db.container("backfill_jobs");

  const startedAt = Date.now();
  const company = await loadCompany(companies, companyId, normalizedDomain);
  if (!company) {
    await patchJobProposal(jobs, jobId, companyId, {
      status: "error",
      error: "company_not_found",
      at: new Date().toISOString(),
    });
    return;
  }

  const oldMfg = Array.isArray(company.manufacturing_locations)
    ? company.manufacturing_locations.map((m) => (typeof m === "string" ? m : m?.location || ""))
    : [];

  console.log(`[mfg-backfill-worker] propose_start`, {
    job_id: jobId,
    company_id: companyId,
    company_name: company.company_name,
    old_mfg: oldMfg.slice(0, 6),
  });

  let proposal;
  try {
    const result = await runCanonicalImportCall({
      company,
      sessionId: jobId,
      budgetMs: CALL_BUDGET_MS,
      fieldsToEnrich: ["manufacturing_locations"],
    });
    const env = result?.enriched?.manufacturing_locations || null;
    const proposed = Array.isArray(env?.manufacturing_locations) ? env.manufacturing_locations.filter(Boolean) : [];
    const sources = Array.isArray(env?.location_source_urls?.mfg_source_urls)
      ? env.location_source_urls.mfg_source_urls.filter(Boolean).slice(0, 6)
      : [];
    proposal = {
      status: proposed.length ? "proposed" : "no_value_found",
      company_name: company.company_name || "",
      normalized_domain: company.normalized_domain || normalizedDomain || "",
      old_mfg: oldMfg,
      proposed_mfg: proposed,
      mfg_source_urls: sources,
      mfg_status: env?.manufacturing_locations_status || null,
      elapsed_ms: Date.now() - startedAt,
      at: new Date().toISOString(),
    };
  } catch (e) {
    proposal = {
      status: "error",
      company_name: company.company_name || "",
      normalized_domain: company.normalized_domain || normalizedDomain || "",
      old_mfg: oldMfg,
      error: String(e?.message || e).slice(0, 300),
      elapsed_ms: Date.now() - startedAt,
      at: new Date().toISOString(),
    };
  }

  await patchJobProposal(jobs, jobId, companyId, proposal);
  console.log(`[mfg-backfill-worker] propose_done`, {
    job_id: jobId,
    company_id: companyId,
    status: proposal.status,
    proposed_mfg: (proposal.proposed_mfg || []).slice(0, 6),
    elapsed_ms: proposal.elapsed_ms,
  });
}

if (IS_DEDICATED_WORKER) {
  app.storageQueue("mfg-backfill-worker", {
    queueName: "mfg-backfill",
    connection: "AzureWebJobsStorage",
    handler: async (item, context) => {
      try {
        await processMessage(item, context);
      } catch (e) {
        // Log and swallow: a poison retry loop over an xAI-heavy call is worse
        // than one lost proposal (the operator re-enqueues via "start").
        console.error(`[mfg-backfill-worker] message_failed`, { error: String(e?.message || e) });
      }
    },
  });
}

module.exports = {};
