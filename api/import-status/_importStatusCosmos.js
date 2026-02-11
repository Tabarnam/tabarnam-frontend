/**
 * Cosmos DB access functions extracted from import-status/index.js.
 * All async I/O for reading/writing control docs and company documents.
 */

const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
} = require("../_cosmosPartitionKey");

const { patchCompanyWithSearchText } = require("../_computeSearchText");
const { getJob: getImportPrimaryJob, patchJob: patchImportPrimaryJob } = require("../_importPrimaryJobStore");
const { nowIso, computePrimaryProgress } = require("./_importStatusUtils");

// Orchestration mode: When false, status endpoint can trigger resume worker and force-terminalize.
const STATUS_NO_ORCHESTRATION = false;

let companiesPkPathPromise;
async function getCompaniesPkPath(container) {
  if (!container) return "/normalized_domain";
  companiesPkPathPromise ||= getContainerPartitionKeyPath(container, "/normalized_domain");
  try {
    return await companiesPkPathPromise;
  } catch {
    return "/normalized_domain";
  }
}

async function readControlDoc(container, id, sessionId) {
  if (!container) return null;
  const containerPkPath = await getCompaniesPkPath(container);

  const docForCandidates = {
    id,
    session_id: sessionId,
    normalized_domain: "import",
    partition_key: "import",
    type: "import_control",
  };

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
    try {
      console.warn(`[import-status] session=${sessionId} control doc read failed: ${lastErr.message}`);
    } catch {}
  }
  return null;
}

async function hasAnyCompanyDocs(container, sessionId) {
  if (!container) return false;
  try {
    const q = {
      query: `
        SELECT TOP 1 c.id FROM c
        WHERE (
          (IS_DEFINED(c.session_id) AND c.session_id = @sid)
          OR (IS_DEFINED(c.import_session_id) AND c.import_session_id = @sid)
          OR (IS_DEFINED(c.import_session) AND c.import_session = @sid)
          OR (IS_DEFINED(c.source_session_id) AND c.source_session_id = @sid)
          OR (IS_DEFINED(c.source_session) AND c.source_session = @sid)
        ) AND NOT STARTSWITH(c.id, '_import_')
      `,
      parameters: [{ name: "@sid", value: sessionId }],
    };

    const { resources } = await container.items
      .query(q, { enableCrossPartitionQuery: true })
      .fetchAll();

    return Array.isArray(resources) && resources.length > 0;
  } catch (e) {
    try {
      console.warn(`[import-status] session=${sessionId} company probe failed: ${e?.message || String(e)}`);
    } catch {}
    return false;
  }
}

async function fetchRecentCompanies(container, { sessionId, take, normalizedDomain, createdAfter }) {
  if (!container) return [];
  const n = Math.max(0, Math.min(Number(take) || 10, 200));
  if (!n) return [];

  const domain = typeof normalizedDomain === "string" ? normalizedDomain.trim().toLowerCase() : "";
  const createdAfterIso = typeof createdAfter === "string" ? createdAfter.trim() : "";

  const domainFallbackClause =
    domain && createdAfterIso
      ? `
          OR (
            IS_DEFINED(c.normalized_domain) AND c.normalized_domain = @domain
            AND IS_DEFINED(c.created_at) AND c.created_at >= @createdAfter
          )
        `
      : "";

  const q = {
    query: `
      SELECT c.id, c.company_name, c.name, c.url, c.website_url, c.created_at,
        c.normalized_domain, c.import_attempts, c.import_attempts_meta,
        c.industries, c.product_keywords, c.keywords,
        c.headquarters_location, c.manufacturing_locations,
        c.curated_reviews, c.review_count, c.review_cursor, c.reviews_stage_status, c.no_valid_reviews_found,
        c.tagline, c.logo_url, c.logo_stage_status,
        c.import_missing_fields, c.import_missing_reason, c.import_warnings,
        c.hq_unknown, c.hq_unknown_reason,
        c.mfg_unknown, c.mfg_unknown_reason,
        c.red_flag, c.red_flag_reason
      FROM c
      WHERE NOT STARTSWITH(c.id, '_import_')
        AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)
        AND (
          (IS_DEFINED(c.session_id) AND c.session_id = @sid)
          OR (IS_DEFINED(c.import_session_id) AND c.import_session_id = @sid)
          OR (IS_DEFINED(c.import_session) AND c.import_session = @sid)
          OR (IS_DEFINED(c.source_session_id) AND c.source_session_id = @sid)
          OR (IS_DEFINED(c.source_session) AND c.source_session = @sid)
          ${domainFallbackClause}
        )
      ORDER BY c.created_at DESC
    `,
    parameters: [
      { name: "@sid", value: sessionId },
      ...(domain && createdAfterIso
        ? [
            { name: "@domain", value: domain },
            { name: "@createdAfter", value: createdAfterIso },
          ]
        : []),
    ],
  };

  const { resources } = await container.items
    .query(q, { enableCrossPartitionQuery: true })
    .fetchAll();

  return Array.isArray(resources) ? resources.slice(0, n) : [];
}

async function fetchCompaniesByIds(container, ids) {
  if (!container) return [];
  const list = Array.isArray(ids) ? ids.map((id) => String(id || "").trim()).filter(Boolean) : [];
  if (list.length === 0) return [];

  const q = {
    query: `
      SELECT c.id, c.company_name, c.name, c.url, c.website_url, c.created_at,
        c.normalized_domain, c.import_attempts, c.import_attempts_meta,
        c.industries, c.product_keywords, c.keywords,
        c.headquarters_location, c.manufacturing_locations,
        c.curated_reviews, c.review_count, c.review_cursor, c.reviews_stage_status, c.no_valid_reviews_found,
        c.tagline, c.logo_url, c.logo_stage_status,
        c.import_missing_fields, c.import_missing_reason, c.import_warnings,
        c.hq_unknown, c.hq_unknown_reason,
        c.mfg_unknown, c.mfg_unknown_reason,
        c.red_flag, c.red_flag_reason
      FROM c
      WHERE ARRAY_CONTAINS(@ids, c.id)
    `,
    parameters: [{ name: "@ids", value: list }],
  };

  const { resources } = await container.items
    .query(q, { enableCrossPartitionQuery: true })
    .fetchAll();

  const out = Array.isArray(resources) ? resources : [];
  const byId = new Map(out.map((doc) => [String(doc?.id || ""), doc]));
  return list.map((id) => byId.get(id)).filter(Boolean);
}

async function fetchCompanyByNormalizedDomain(container, normalizedDomain) {
  if (!container) return null;
  const domain = String(normalizedDomain || "").trim().toLowerCase();
  if (!domain) return null;

  const q = {
    query: `
      SELECT TOP 1 c.id, c.company_name, c.name, c.url, c.website_url, c.created_at,
        c.normalized_domain, c.import_attempts, c.import_attempts_meta,
        c.industries, c.product_keywords, c.keywords,
        c.headquarters_location, c.manufacturing_locations,
        c.curated_reviews, c.review_count, c.review_cursor, c.reviews_stage_status, c.no_valid_reviews_found,
        c.tagline, c.logo_url, c.logo_stage_status,
        c.import_missing_fields, c.import_missing_reason, c.import_warnings,
        c.hq_unknown, c.hq_unknown_reason,
        c.mfg_unknown, c.mfg_unknown_reason,
        c.red_flag, c.red_flag_reason
      FROM c
      WHERE NOT STARTSWITH(c.id, '_import_')
        AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)
        AND IS_DEFINED(c.normalized_domain) AND c.normalized_domain = @domain
      ORDER BY c.created_at DESC
    `,
    parameters: [{ name: "@domain", value: domain }],
  };

  const { resources } = await container.items
    .query(q, { enableCrossPartitionQuery: true })
    .fetchAll();

  const list = Array.isArray(resources) ? resources : [];
  return list.length > 0 ? list[0] : null;
}

async function fetchCompaniesByIdsFull(container, ids) {
  if (!container) return [];
  const list = Array.isArray(ids) ? ids.map((id) => String(id || "").trim()).filter(Boolean) : [];
  if (list.length === 0) return [];

  const q = {
    query: `SELECT * FROM c WHERE ARRAY_CONTAINS(@ids, c.id)`,
    parameters: [{ name: "@ids", value: list }],
  };

  const { resources } = await container.items.query(q, { enableCrossPartitionQuery: true }).fetchAll();
  const out = Array.isArray(resources) ? resources : [];
  const byId = new Map(out.map((doc) => [String(doc?.id || ""), doc]));
  return list.map((id) => byId.get(id)).filter(Boolean);
}

async function upsertDoc(container, doc) {
  if (STATUS_NO_ORCHESTRATION) return { ok: true, skipped: true };
  if (!container || !doc) return { ok: false, error: "no_container" };
  const id = String(doc?.id || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  const containerPkPath = await getCompaniesPkPath(container);
  const candidates = buildPartitionKeyCandidates({ doc, containerPkPath, requestedId: id });

  let lastErr = null;
  for (const partitionKeyValue of candidates) {
    try {
      if (partitionKeyValue !== undefined) {
        await container.items.upsert(doc, { partitionKey: partitionKeyValue });
      } else {
        await container.items.upsert(doc);
      }
      return { ok: true };
    } catch (e) {
      lastErr = e;
    }
  }

  return { ok: false, error: lastErr?.message || String(lastErr || "upsert_failed") };
}

async function persistResumeBlocked(container, {
  sessionId,
  forcedAt,
  errorCode,
  details,
  forcedBy,
  message,
}) {
  if (!container) return { ok: false, error: "no_container" };
  const sid = String(sessionId || "").trim();
  if (!sid) return { ok: false, error: "missing_session_id" };

  const stamp = String(forcedAt || nowIso()).trim() || nowIso();

  const sessionDocId = `_import_session_${sid}`;
  const resumeDocId = `_import_resume_${sid}`;

  const sessionDoc = await readControlDoc(container, sessionDocId, sid).catch(() => null);
  const resumeDoc = await readControlDoc(container, resumeDocId, sid).catch(() => null);

  const mergedDetails = {
    ...(details && typeof details === "object" ? details : {}),
    blocked_at: (details && typeof details === "object" && details.blocked_at) ? details.blocked_at : stamp,
    forced_by: (details && typeof details === "object" && details.forced_by) ? details.forced_by : (forcedBy || null),
  };

  const sessionWrite = {
    ...(sessionDoc && typeof sessionDoc === "object"
      ? sessionDoc
      : {
          id: sessionDocId,
          session_id: sid,
          normalized_domain: "import",
          partition_key: "import",
          type: "import_control",
          status: "running",
          stage_beacon: "enrichment_resume_blocked",
          created_at: stamp,
        }),
    resume_needed: true,
    resume_error: errorCode,
    resume_error_details: mergedDetails,
    status: sessionDoc && typeof sessionDoc?.status === "string" && sessionDoc.status.trim() === "complete" ? "running" : (sessionDoc?.status || "running"),
    stage_beacon: "enrichment_resume_blocked",
    updated_at: stamp,
  };

  const resumeWrite = {
    ...(resumeDoc && typeof resumeDoc === "object"
      ? resumeDoc
      : {
          id: resumeDocId,
          session_id: sid,
          normalized_domain: "import",
          partition_key: "import",
          type: "import_control",
          created_at: stamp,
        }),
    status: "blocked",
    resume_error: errorCode,
    resume_error_details: mergedDetails,
    blocked_at: stamp,
    blocked_reason: forcedBy || null,
    last_error: {
      code: errorCode,
      message: String(message || "Resume blocked"),
      ...mergedDetails,
    },
    lock_expires_at: null,
    updated_at: stamp,
  };

  const [sessionRes, resumeRes] = await Promise.all([
    upsertDoc(container, sessionWrite).catch((e) => ({ ok: false, error: e?.message || String(e) })),
    upsertDoc(container, resumeWrite).catch((e) => ({ ok: false, error: e?.message || String(e) })),
  ]);

  return {
    ok: Boolean(sessionRes?.ok) && Boolean(resumeRes?.ok),
    session: sessionRes,
    resume: resumeRes,
    session_doc_id: sessionDocId,
    resume_doc_id: resumeDocId,
  };
}

async function ensurePrimaryJobProgressFields({ sessionId, job, hardMaxRuntimeMs, stageBeaconValues }) {
  const nowTs = Date.now();
  const progress = computePrimaryProgress(job, nowTs, hardMaxRuntimeMs);

  const patch = {};

  if (!(typeof job?.stage_beacon === "string" && job.stage_beacon.trim())) {
    patch.stage_beacon = "primary_search_started";
  }

  if (!Number.isFinite(Number(job?.elapsed_ms))) patch.elapsed_ms = progress.elapsed_ms;
  if (!Number.isFinite(Number(job?.remaining_budget_ms))) patch.remaining_budget_ms = progress.remaining_budget_ms;

  if (!Number.isFinite(Number(job?.upstream_calls_made))) patch.upstream_calls_made = progress.upstream_calls_made;

  if (!Number.isFinite(Number(job?.companies_candidates_found)) && !Number.isFinite(Number(job?.companies_count))) {
    patch.companies_candidates_found = progress.companies_candidates_found;
  }

  if (typeof job?.early_exit_triggered !== "boolean") patch.early_exit_triggered = progress.early_exit_triggered;

  const patchKeys = Object.keys(patch);
  if (patchKeys.length === 0) return { job, progress };

  stageBeaconValues.status_patched_progress_fields = nowIso();

  await patchImportPrimaryJob({
    sessionId,
    cosmosEnabled: true,
    patch: {
      ...patch,
      updated_at: nowIso(),
    },
  }).catch(() => null);

  const refreshed = await getImportPrimaryJob({ sessionId, cosmosEnabled: true }).catch(() => job);
  return { job: refreshed || job, progress: computePrimaryProgress(refreshed || job, Date.now(), hardMaxRuntimeMs) };
}

async function markPrimaryJobError({ sessionId, code, message, stageBeacon, details, stageBeaconValues }) {
  stageBeaconValues.status_marked_error = nowIso();
  if (code) stageBeaconValues.status_marked_error_code = String(code);

  await patchImportPrimaryJob({
    sessionId,
    cosmosEnabled: true,
    patch: {
      job_state: "error",
      stage_beacon: String(stageBeacon || "primary_search_started"),
      last_error: {
        code: String(code || "UNKNOWN"),
        message: String(message || "Job failed"),
        ...(details && typeof details === "object" ? details : {}),
      },
      last_heartbeat_at: nowIso(),
      updated_at: nowIso(),
      lock_expires_at: null,
      locked_by: null,
    },
  }).catch(() => null);

  return await getImportPrimaryJob({ sessionId, cosmosEnabled: true }).catch(() => null);
}

async function savePrimaryJobCompanies(container, { sessionId, primaryJob, stageBeaconValues }) {
  if (STATUS_NO_ORCHESTRATION) return { saved: 0, saved_ids: [] };
  if (!container || !sessionId) return { saved: 0, saved_ids: [] };

  const companies = Array.isArray(primaryJob?.companies) ? primaryJob.companies : [];
  if (companies.length === 0) return { saved: 0, saved_ids: [] };

  const saved_ids = [];
  const failed_items = [];
  const skipped_items = [];
  const now = new Date().toISOString();

  for (const company of companies.slice(0, 25)) {
    try {
      const companyName = String(company?.company_name || company?.name || "").trim();
      if (!companyName) { skipped_items.push({ reason: "no_name" }); continue; }

      const websiteUrl = String(company?.website_url || company?.canonical_url || company?.url || "").trim();

      let domain = "";
      if (websiteUrl) {
        try {
          const u = new URL(websiteUrl.includes("://") ? websiteUrl : `https://${websiteUrl}`);
          domain = String(u.hostname || "").toLowerCase().replace(/^www\./, "").trim();
        } catch {}
      }
      if (!domain) { skipped_items.push({ company_name: companyName, reason: "no_domain" }); continue; }

      let existingId = null;
      try {
        const existingQuery = {
          query: `SELECT TOP 1 c.id FROM c WHERE c.normalized_domain = @domain AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)`,
          parameters: [{ name: "@domain", value: domain }],
        };
        const { resources } = await container.items.query(existingQuery, { partitionKey: domain }).fetchAll();
        if (resources.length > 0) existingId = String(resources[0].id || "").trim();
      } catch {}

      if (existingId) {
        saved_ids.push(existingId);
        skipped_items.push({ company_name: companyName, reason: "existing", existing_id: existingId });
        continue;
      }

      const companyId = `company_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      const headquartersLocation = String(company?.headquarters_location || "").trim();
      const mfgLocs = Array.isArray(company?.manufacturing_locations)
        ? company.manufacturing_locations.map((l) => typeof l === "string" ? l.trim() : String(l?.formatted || l?.address || l?.location || "").trim()).filter(Boolean)
        : [];
      const curatedReviews = Array.isArray(company?.curated_reviews)
        ? company.curated_reviews.filter((r) => r && typeof r === "object")
        : [];
      const reviewCount = Number.isFinite(Number(company?.review_count))
        ? Number(company.review_count)
        : curatedReviews.length;
      const industries = Array.isArray(company?.industries) ? company.industries : [];
      const keywords = Array.isArray(company?.keywords || company?.product_keywords)
        ? (company.keywords || company.product_keywords)
        : [];

      const doc = {
        id: companyId,
        company_name: companyName,
        name: company?.name || companyName,
        url: websiteUrl,
        website_url: websiteUrl,
        canonical_url: domain ? `https://${domain}/` : websiteUrl,
        industries,
        product_keywords: Array.isArray(keywords) ? keywords.join(", ") : String(keywords || ""),
        keywords: Array.isArray(keywords) ? keywords : [],
        normalized_domain: domain,
        partition_key: domain,
        tagline: String(company?.tagline || "").trim(),
        headquarters_location: headquartersLocation,
        hq_unknown: Boolean(company?.hq_unknown),
        hq_unknown_reason: String(company?.hq_unknown_reason || "").trim(),
        headquarters_locations: Array.isArray(company?.headquarters_locations) ? company.headquarters_locations : [],
        manufacturing_locations: mfgLocs,
        mfg_unknown: Boolean(company?.mfg_unknown),
        mfg_unknown_reason: String(company?.mfg_unknown_reason || "").trim(),
        manufacturing_geocodes: Array.isArray(company?.manufacturing_geocodes) ? company.manufacturing_geocodes : [],
        curated_reviews: curatedReviews,
        review_count: reviewCount,
        reviews_last_updated_at: now,
        review_cursor: {
          exhausted: false,
          last_error: null,
          updated_at: now,
          count: reviewCount,
        },
        reviews_stage_status: "pending",
        red_flag: Boolean(company?.red_flag),
        red_flag_reason: String(company?.red_flag_reason || "").trim(),
        location_confidence: company?.location_confidence || "medium",
        social: company?.social || {},
        amazon_url: String(company?.amazon_url || "").trim(),
        logo_url: null,
        logo_status: "pending",
        logo_import_status: "pending",
        logo_stage_status: "deferred",
        rating_icon_type: "star",
        source: "primary_worker_bridge",
        session_id: sessionId,
        import_session_id: sessionId,
        import_created_at: now,
        created_at: now,
        updated_at: now,
        resume_needed: true,
        import_missing_fields: ["headquarters_location", "manufacturing_locations", "curated_reviews", "logo_url"],
        import_missing_reason: {
          headquarters_location: headquartersLocation ? "ok" : "missing",
          manufacturing_locations: mfgLocs.length > 0 ? "ok" : "missing",
          curated_reviews: curatedReviews.length > 0 ? "ok" : "missing",
          logo_url: "missing",
        },
      };

      try { patchCompanyWithSearchText(doc); } catch {}

      const res = await upsertDoc(container, doc);
      if (res?.ok) {
        saved_ids.push(companyId);
      } else {
        failed_items.push({ company_name: companyName, error: res?.error || "upsert_failed" });
      }
    } catch (e) {
      failed_items.push({ company_name: company?.company_name || "unknown", error: e?.message || String(e) });
    }
  }

  if (saved_ids.length > 0) {
    try {
      const sessionDocId = `_import_session_${sessionId}`;
      const sessionDoc = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);
      await upsertDoc(container, {
        ...(sessionDoc && typeof sessionDoc === "object" ? sessionDoc : {
          id: sessionDocId,
          session_id: sessionId,
          normalized_domain: "import",
          partition_key: "import",
          type: "import_control",
          created_at: now,
        }),
        status: "complete",
        stage_beacon: "primary_bridge_saved",
        saved: saved_ids.length,
        companies_count: saved_ids.length,
        saved_company_ids_verified: saved_ids,
        saved_verified_count: saved_ids.length,
        resume_needed: true,
        completed_at: now,
        updated_at: now,
      }).catch(() => null);
    } catch {}

    try {
      await upsertDoc(container, {
        id: `_import_complete_${sessionId}`,
        session_id: sessionId,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        completed_at: now,
        updated_at: now,
        reason: "primary_bridge_save",
        saved: saved_ids.length,
        saved_ids,
        saved_company_ids_verified: saved_ids,
        saved_verified_count: saved_ids.length,
        skipped: skipped_items.length,
        failed: failed_items.length,
        skipped_ids: [],
        failed_items,
      }).catch(() => null);
    } catch {}
  }

  stageBeaconValues.status_primary_bridge_save_attempted = nowIso();
  stageBeaconValues.status_primary_bridge_saved_count = saved_ids.length;
  stageBeaconValues.status_primary_bridge_failed_count = failed_items.length;
  stageBeaconValues.status_primary_bridge_skipped_count = skipped_items.length;

  return { saved: saved_ids.length, saved_ids, failed_items, skipped_items };
}

async function fetchAuthoritativeSavedCompanies(container, { sessionId, sessionCreatedAt, normalizedDomain, createdAfter, limit = 200 }) {
  if (!container) return [];
  const n = Math.max(0, Math.min(Number(limit) || 0, 200));
  if (!n) return [];

  const q = {
    query: `
      SELECT c.id, c.company_name, c.name, c.url, c.website_url, c.created_at,
        c.normalized_domain, c.import_attempts, c.import_attempts_meta,
        c.industries, c.product_keywords, c.keywords,
        c.headquarters_location, c.manufacturing_locations,
        c.curated_reviews, c.review_count, c.review_cursor, c.reviews_stage_status, c.no_valid_reviews_found,
        c.tagline, c.logo_url, c.logo_stage_status,
        c.import_missing_fields, c.import_missing_reason, c.import_warnings,
        c.hq_unknown, c.hq_unknown_reason,
        c.mfg_unknown, c.mfg_unknown_reason,
        c.red_flag, c.red_flag_reason
      FROM c
      WHERE NOT STARTSWITH(c.id, '_import_')
        AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)
        AND (
          (IS_DEFINED(c.session_id) AND c.session_id = @sid)
          OR (IS_DEFINED(c.import_session_id) AND c.import_session_id = @sid)
          OR (IS_DEFINED(c.import_session) AND c.import_session = @sid)
          OR (IS_DEFINED(c.source_session_id) AND c.source_session_id = @sid)
          OR (IS_DEFINED(c.source_session) AND c.source_session = @sid)
        )
      ORDER BY c.created_at DESC
    `,
    parameters: [{ name: "@sid", value: sessionId }],
  };

  const { resources } = await container.items
    .query(q, { enableCrossPartitionQuery: true })
    .fetchAll();

  const out = Array.isArray(resources) ? resources : [];
  return out.slice(0, n);
}

module.exports = {
  STATUS_NO_ORCHESTRATION,
  getCompaniesPkPath,
  readControlDoc,
  hasAnyCompanyDocs,
  fetchRecentCompanies,
  fetchCompaniesByIds,
  fetchCompanyByNormalizedDomain,
  fetchCompaniesByIdsFull,
  upsertDoc,
  persistResumeBlocked,
  ensurePrimaryJobProgressFields,
  markPrimaryJobError,
  savePrimaryJobCompanies,
  fetchAuthoritativeSavedCompanies,
};
