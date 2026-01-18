let app;
try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {} };
}
let CosmosClient;
try {
  ({ CosmosClient } = require("@azure/cosmos"));
} catch {
  CosmosClient = null;
}
const { getSession: getImportSession } = require("../_importSessionStore");
const { getJob: getImportPrimaryJob, patchJob: patchImportPrimaryJob } = require("../_importPrimaryJobStore");
const { runPrimaryJob } = require("../_importPrimaryWorker");
const {
  buildInternalFetchHeaders,
  buildInternalFetchRequest,
  getInternalJobSecretInfo,
  getAcceptableInternalSecretsInfo,
} = require("../_internalJobAuth");

// IMPORTANT: pure handler module only (no app.http registrations). Loaded at cold start.
const { invokeResumeWorkerInProcess } = require("../import/resume-worker/handler");

const { getBuildInfo } = require("../_buildInfo");

const HANDLER_ID = "import-status";

const BUILD_INFO = (() => {
  try {
    return getBuildInfo();
  } catch {
    return { build_id: "" };
  }
})();
const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
} = require("../_cosmosPartitionKey");

const { computeEnrichmentHealth: computeEnrichmentHealthContract } = require("../_requiredFields");

const EMPTY_RESUME_DIAGNOSTICS = Object.freeze({
  resume: {
    needed: null,
    status: null,
    doc_created: null,
    triggered: null,
    trigger_error: null,
    trigger_error_details: null,
    gateway_key_attached: null,
    trigger_request_id: null,
    internal_auth_configured: null,
    missing_by_company: null,
  },
  resume_worker: {
    last_invoked_at: null,
    handler_entered_at: null,
    handler_entered_build_id: null,
    last_reject_layer: null,
    last_auth: null,
    last_finished_at: null,
    last_result: null,
    last_ok: null,
    last_http_status: null,
    last_trigger_request_id: null,
    last_gateway_key_attached: null,
    last_error: null,
    last_company_id: null,
    last_written_fields: null,
    last_stage_beacon: null,
    last_resume_needed: null,
  },
});

function cors(req) {
  const origin = req?.headers?.get?.("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
  };
}

function json(obj, status = 200, req, extraHeaders) {
  const payload = obj && typeof obj === "object" && !Array.isArray(obj)
    ? { ...obj, build_id: obj.build_id || String(BUILD_INFO.build_id || "") }
    : obj;

  return {
    status,
    headers: {
      ...cors(req),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Api-Handler": HANDLER_ID,
      "X-Api-Build-Id": String(BUILD_INFO.build_id || ""),
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
    },
    body: JSON.stringify(payload),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeDomain(raw) {
  const host = String(raw || "").trim().toLowerCase();
  if (!host) return "";
  return host.replace(/^www\./, "");
}

function extractNormalizedDomainFromQuery(rawQuery) {
  const q = String(rawQuery || "").trim();
  if (!q) return "";

  try {
    const url = q.includes("://") ? new URL(q) : new URL(`https://${q}`);
    return normalizeDomain(url.hostname || "");
  } catch {
    return "";
  }
}

function computeCreatedAfterIso(createdAtIso, minutes) {
  const raw = String(createdAtIso || "").trim();
  const ms = Date.parse(raw) || 0;
  if (!ms) return "";
  const delta = Math.max(0, Number(minutes) || 0) * 60 * 1000;
  return new Date(ms - delta).toISOString();
}

function deriveDomainAndCreatedAfter({ sessionDoc, acceptDoc }) {
  const sessionCreatedAt =
    (typeof sessionDoc?.created_at === "string" && sessionDoc.created_at.trim() ? sessionDoc.created_at.trim() : "") ||
    (typeof acceptDoc?.created_at === "string" && acceptDoc.created_at.trim() ? acceptDoc.created_at.trim() : "") ||
    "";

  const request = sessionDoc?.request && typeof sessionDoc.request === "object" ? sessionDoc.request : null;
  const query = request && typeof request.query === "string" ? request.query : "";

  const normalizedDomain = extractNormalizedDomainFromQuery(query);

  // If we have to fall back by domain, keep the window tight.
  const createdAfter = computeCreatedAfterIso(sessionCreatedAt, 10);

  return { normalizedDomain, createdAfter, sessionCreatedAt };
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.trunc(n);
}

function getHeartbeatTimestamp(job) {
  const hb = Date.parse(job?.last_heartbeat_at || "") || 0;
  if (hb) return hb;
  const updated = Date.parse(job?.updated_at || "") || 0;
  if (updated) return updated;
  const started = Date.parse(job?.started_at || "") || 0;
  return started || 0;
}

function getJobCreatedTimestamp(job) {
  const created = Date.parse(job?.created_at || "") || 0;
  if (created) return created;
  const updated = Date.parse(job?.updated_at || "") || 0;
  if (updated) return updated;
  const started = Date.parse(job?.started_at || "") || 0;
  return started || 0;
}

function computePrimaryProgress(job, nowTs, hardMaxRuntimeMs) {
  const state = String(job?.job_state || "queued");
  const startedAtTs = Date.parse(job?.started_at || "") || 0;
  const createdAtTs = getJobCreatedTimestamp(job);

  const startTs = startedAtTs || (state === "queued" ? createdAtTs || nowTs : nowTs);
  const elapsedMs = Math.max(0, nowTs - startTs);

  const upstreamCallsMade = toPositiveInt(job?.upstream_calls_made, 0);
  const candidatesFound = Number.isFinite(Number(job?.companies_candidates_found))
    ? Math.max(0, Number(job.companies_candidates_found))
    : Number.isFinite(Number(job?.companies_count))
      ? Math.max(0, Number(job.companies_count))
      : 0;

  return {
    elapsed_ms: elapsedMs,
    remaining_budget_ms: Math.max(0, hardMaxRuntimeMs - elapsedMs),
    upstream_calls_made: upstreamCallsMade,
    companies_candidates_found: candidatesFound,
    early_exit_triggered: Boolean(job?.early_exit_triggered),
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

function computeEnrichmentHealth(company) {
  // Single source of truth: required-fields contract.
  return computeEnrichmentHealthContract(company);
}

// Back-compat naming used by status/reconciliation logic.
function computeContractEnrichmentHealth(company) {
  return computeEnrichmentHealthContract(company);
}

function normalizeMissingKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isTrueish(value) {
  if (value === true) return true;
  if (value === false) return false;
  const s = normalizeMissingKey(value);
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

function isTerminalMissingField(doc, field) {
  const d = doc && typeof doc === "object" ? doc : {};
  const f = String(field || "").trim();

  if (f === "headquarters_location") {
    if (isTrueish(d.hq_unknown)) return true;
    const val = normalizeMissingKey(d.headquarters_location);
    return val === "not disclosed" || val === "not_disclosed";
  }

  if (f === "manufacturing_locations") {
    if (isTrueish(d.mfg_unknown)) return true;

    const rawList = Array.isArray(d.manufacturing_locations)
      ? d.manufacturing_locations
      : d.manufacturing_locations == null
        ? []
        : [d.manufacturing_locations];

    const normalized = rawList
      .map((loc) => {
        if (typeof loc === "string") return normalizeMissingKey(loc);
        if (loc && typeof loc === "object") {
          return normalizeMissingKey(loc.formatted || loc.full_address || loc.address || loc.location);
        }
        return "";
      })
      .filter(Boolean);

    if (normalized.length === 0) return false;

    return normalized.every((v) => v === "not disclosed" || v === "not_disclosed");
  }

  if (f === "reviews") {
    const stage = normalizeMissingKey(d.reviews_stage_status || d.review_cursor?.reviews_stage_status);
    if (stage === "exhausted") return true;
    return Boolean(d.review_cursor && typeof d.review_cursor === "object" && d.review_cursor.exhausted === true);
  }

  if (f === "logo") {
    const stage = normalizeMissingKey(d.logo_stage_status || d.logo_status);
    return stage === "not_found_on_site";
  }

  return false;
}

function analyzeMissingFieldsForResume(docs) {
  const list = Array.isArray(docs) ? docs : [];

  let totalMissing = 0;
  let totalRetryableMissing = 0;
  let totalTerminalMissing = 0;

  for (const doc of list) {
    const health = computeContractEnrichmentHealth(doc);
    const missing = Array.isArray(health?.missing_fields) ? health.missing_fields : [];

    for (const field of missing) {
      totalMissing += 1;
      if (isTerminalMissingField(doc, field)) totalTerminalMissing += 1;
      else totalRetryableMissing += 1;
    }
  }

  const terminalOnly = totalMissing > 0 && totalRetryableMissing === 0;

  return {
    total_missing: totalMissing,
    total_retryable_missing: totalRetryableMissing,
    total_terminal_missing: totalTerminalMissing,
    terminal_only: terminalOnly,
  };
}

function summarizeEnrichmentHealth(savedCompanies) {
  const list = Array.isArray(savedCompanies) ? savedCompanies : [];
  const incomplete = list.filter((c) => Array.isArray(c?.enrichment_health?.missing_fields) && c.enrichment_health.missing_fields.length > 0);
  const missingCounts = {};

  for (const item of incomplete) {
    const missing = Array.isArray(item?.enrichment_health?.missing_fields) ? item.enrichment_health.missing_fields : [];
    for (const field of missing) {
      missingCounts[field] = (missingCounts[field] || 0) + 1;
    }
  }

  return {
    total: list.length,
    complete: Math.max(0, list.length - incomplete.length),
    incomplete: incomplete.length,
    missing_counts: missingCounts,
  };
}

function toSavedCompanies(docs) {
  const list = Array.isArray(docs) ? docs : [];
  return list
    .map((doc) => {
      const companyId = String(doc?.id || doc?.company_id || "").trim();
      if (!companyId) return null;

      const canonicalUrl = String(doc?.canonical_url || "").trim();
      const websiteUrl = String(doc?.website_url || doc?.url || "").trim();

      return {
        company_id: companyId,
        company_name: String(doc?.company_name || doc?.name || "").trim() || "Unknown company",
        canonical_url: canonicalUrl,
        website_url: websiteUrl || canonicalUrl,
        enrichment_health: computeEnrichmentHealth(doc),
        import_missing_fields: Array.isArray(doc?.import_missing_fields) ? doc.import_missing_fields : [],
        import_missing_reason:
          doc?.import_missing_reason && typeof doc.import_missing_reason === "object" && !Array.isArray(doc.import_missing_reason)
            ? doc.import_missing_reason
            : null,
        import_warnings: Array.isArray(doc?.import_warnings) ? doc.import_warnings.slice(0, 25) : [],
      };
    })
    .filter(Boolean);
}

function inferReconcileStrategy(docs, sessionId) {
  const list = Array.isArray(docs) ? docs : [];
  if (list.some((d) => String(d?.import_session_id || "").trim() === sessionId)) return "import_session_id";
  if (list.some((d) => String(d?.session_id || "").trim() === sessionId)) return "session_id";
  return "created_at_fallback";
}

function normalizeErrorPayload(value) {
  if (!value) return null;
  if (typeof value === "string") return { message: value };
  if (typeof value === "object") return value;
  return { message: String(value) };
}

async function upsertDoc(container, doc) {
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

async function fetchAuthoritativeSavedCompanies(container, { sessionId, sessionCreatedAt, normalizedDomain, createdAfter, limit = 200 }) {
  if (!container) return [];
  const n = Math.max(0, Math.min(Number(limit) || 0, 200));
  if (!n) return [];

  const createdAtIso = typeof sessionCreatedAt === "string" && sessionCreatedAt.trim() ? sessionCreatedAt.trim() : "";
  const domain = typeof normalizedDomain === "string" ? normalizedDomain.trim().toLowerCase() : "";
  const createdAfterIso = typeof createdAfter === "string" && createdAfter.trim() ? createdAfter.trim() : "";

  // Truthfulness: only count companies that are explicitly linked to this session.
  // Avoid domain/created_at fallbacks here because they can inflate saved counts.
  const q = {
    query: `
      SELECT c.id, c.company_name, c.name, c.url, c.website_url, c.created_at,
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

async function handler(req, context) {
  const method = String(req?.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: cors(req) };

  const url = new URL(req.url);
  const sessionId = String(url.searchParams.get("session_id") || "").trim();
  const take = Number(url.searchParams.get("take") || "10") || 10;
  const forceResume =
    String(
      url.searchParams.get("force_resume") ||
        url.searchParams.get("forceResume") ||
        url.searchParams.get("trigger_resume") ||
        ""
    ).trim() === "1";

  if (!sessionId) {
    return json({ ok: false, error: "Missing session_id", ...EMPTY_RESUME_DIAGNOSTICS }, 400, req);
  }

  const extraHeaders = { "x-session-id": sessionId };
  const jsonWithSessionId = (obj, status = 200) => json(obj, status, req, extraHeaders);

  const statusCheckedAt = nowIso();
  const stageBeaconValues = {
    status_checked_at: statusCheckedAt,
  };

  const internalSecretInfo = (() => {
    try {
      return getInternalJobSecretInfo();
    } catch {
      return { secret: "", secret_source: null };
    }
  })();

  const acceptableSecretsInfo = (() => {
    try {
      return getAcceptableInternalSecretsInfo();
    } catch {
      return [];
    }
  })();

  const internalAuthConfigured = Array.isArray(acceptableSecretsInfo) && acceptableSecretsInfo.length > 0;

  const gatewayKeyConfigured = Boolean(String(process.env.FUNCTION_KEY || "").trim());
  const internalJobSecretConfigured = Boolean(String(process.env.X_INTERNAL_JOB_SECRET || "").trim());

  const buildResumeAuthDiagnostics = () => ({
    gateway_key_configured: gatewayKeyConfigured,
    internal_job_secret_configured: internalJobSecretConfigured,
    acceptable_secret_sources: Array.isArray(acceptableSecretsInfo) ? acceptableSecretsInfo.map((c) => c.source) : [],
    internal_secret_source: internalSecretInfo?.secret_source || null,
  });

  const buildResumeStallError = () => {
    const missingGatewayKey = !gatewayKeyConfigured;
    const missingInternalSecret = !internalJobSecretConfigured;

    const root_cause = missingGatewayKey
      ? missingInternalSecret
        ? "missing_gateway_key_and_internal_secret"
        : "missing_gateway_key"
      : "missing_internal_secret";

    const message = missingGatewayKey
      ? "Missing FUNCTION_KEY; Azure gateway auth (x-functions-key) is not configured, so resume-worker calls can be rejected before JS runs."
      : "Missing X_INTERNAL_JOB_SECRET; internal handler auth is not configured for resume-worker calls.";

    return {
      code: missingGatewayKey
        ? missingInternalSecret
          ? "resume_worker_gateway_401_missing_gateway_key_and_internal_secret"
          : "resume_worker_gateway_401_missing_gateway_key"
        : "resume_worker_gateway_401_missing_internal_secret",
      root_cause,
      missing_gateway_key: missingGatewayKey,
      missing_internal_secret: missingInternalSecret,
      message,
    };
  };

  // Used for response shaping across all branches (memory-only, primary-job, cosmos-backed).
  let resume_status = null;

  let primaryJob = await getImportPrimaryJob({ sessionId, cosmosEnabled: true }).catch(() => null);

  if (primaryJob && primaryJob.job_state) {
    stageBeaconValues.status_seen_primary_job = nowIso();

    const HARD_MAX_RUNTIME_MS = Math.max(
      10_000,
      Number.isFinite(Number(process.env.IMPORT_PRIMARY_HARD_TIMEOUT_MS))
        ? Math.trunc(Number(process.env.IMPORT_PRIMARY_HARD_TIMEOUT_MS))
        : 300_000
    );

    const HEARTBEAT_STALE_MS = Number.isFinite(Number(process.env.IMPORT_HEARTBEAT_STALE_MS))
      ? Math.max(5_000, Number(process.env.IMPORT_HEARTBEAT_STALE_MS))
      : 330_000;

    let progress = computePrimaryProgress(primaryJob, Date.now(), HARD_MAX_RUNTIME_MS);

    // Deterministic staleness handling (status must never allow indefinite running).
    const preState = String(primaryJob.job_state);
    if (preState === "running") {
      const hbTs = getHeartbeatTimestamp(primaryJob);
      if (hbTs && Date.now() - hbTs > HEARTBEAT_STALE_MS) {
        primaryJob =
          (await markPrimaryJobError({
            sessionId,
            code: "stalled_worker",
            message: "Worker heartbeat stale",
            stageBeacon: String(primaryJob?.stage_beacon || "primary_search_started"),
            details: { heartbeat_stale_ms: Date.now() - hbTs },
            stageBeaconValues,
          })) || primaryJob;
      }
    }

    // Hard-timeout guard even if the worker isn't making progress.
    const stateAfterStall = String(primaryJob?.job_state || preState);
    progress = computePrimaryProgress(primaryJob, Date.now(), HARD_MAX_RUNTIME_MS);

    if ((stateAfterStall === "queued" || stateAfterStall === "running") && progress.elapsed_ms > HARD_MAX_RUNTIME_MS) {
      primaryJob =
        (await markPrimaryJobError({
          sessionId,
          code: "primary_timeout",
          message: "Primary search exceeded hard runtime limit",
          stageBeacon: "primary_timeout",
          details: {
            elapsed_ms: progress.elapsed_ms,
            hard_timeout_ms: HARD_MAX_RUNTIME_MS,
            note: "Marked by status staleness guard",
          },
          stageBeaconValues,
        })) || primaryJob;
    }

    const ensured = await ensurePrimaryJobProgressFields({
      sessionId,
      job: primaryJob,
      hardMaxRuntimeMs: HARD_MAX_RUNTIME_MS,
      stageBeaconValues,
    });
    primaryJob = ensured.job;
    progress = ensured.progress;

    const jobState = String(primaryJob.job_state);
    const shouldDrive = jobState === "queued" || jobState === "running";

    if (jobState === "running") stageBeaconValues.status_seen_running = nowIso();

    let workerResult = null;
    if (shouldDrive) {
      stageBeaconValues.status_invoked_worker = nowIso();

      workerResult = await runPrimaryJob({
        context,
        sessionId,
        cosmosEnabled: true,
        invocationSource: "status",
      }).catch((e) => {
        stageBeaconValues.status_worker_error = nowIso();
        stageBeaconValues.status_worker_error_detail = typeof e?.message === "string" ? e.message : String(e);
        return null;
      });

      stageBeaconValues.status_worker_returned = nowIso();

      const claimed = Boolean(workerResult?.body?.meta?.worker_claimed);
      if (claimed) stageBeaconValues.status_worker_claimed = nowIso();
      else stageBeaconValues.status_worker_no_claim = nowIso();

      if (workerResult?.body?.status === "error" || workerResult?.body?.ok === false) {
        stageBeaconValues.status_worker_error = stageBeaconValues.status_worker_error || nowIso();
      }

      primaryJob = await getImportPrimaryJob({ sessionId, cosmosEnabled: true }).catch(() => primaryJob);
    }

    const finalJobState = String(primaryJob?.job_state || jobState);
    const status =
      finalJobState === "complete"
        ? "complete"
        : finalJobState === "error"
          ? "error"
          : finalJobState === "running"
            ? "running"
            : "queued";

    const state = status === "error" ? "failed" : status === "complete" ? "complete" : "running";

    let report = null;
    let saved = 0;
    let savedCompanies = [];
    let savedCompanyDocs = [];

    let reconciled = false;
    let reconcile_strategy = null;
    let reconciled_saved_ids = [];

    let saved_verified_count = null;
    let saved_company_ids_verified = [];
    let saved_company_ids_unverified = [];
    let saved_company_urls = [];
    let save_outcome = null;
    let resume_error = null;
    let resume_error_details = null;

    try {
      const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
      const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
      const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
      const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

      if (endpoint && key && CosmosClient) {
        const client = new CosmosClient({ endpoint, key });
        const container = client.database(databaseId).container(containerId);

        const [sessionDoc, completionDoc, acceptDoc, resumeDoc] = await Promise.all([
          readControlDoc(container, `_import_session_${sessionId}`, sessionId),
          readControlDoc(container, `_import_complete_${sessionId}`, sessionId),
          readControlDoc(container, `_import_accept_${sessionId}`, sessionId),
          readControlDoc(container, `_import_resume_${sessionId}`, sessionId),
        ]);

        const domainMeta = deriveDomainAndCreatedAfter({ sessionDoc, acceptDoc });

        const completionVerifiedIds = Array.isArray(completionDoc?.saved_company_ids_verified)
          ? completionDoc.saved_company_ids_verified
          : Array.isArray(completionDoc?.saved_ids)
            ? completionDoc.saved_ids
            : [];

        const sessionVerifiedIds = Array.isArray(sessionDoc?.saved_company_ids_verified)
          ? sessionDoc.saved_company_ids_verified
          : Array.isArray(sessionDoc?.saved_ids)
            ? sessionDoc.saved_ids
            : [];

        saved_company_ids_verified = (completionVerifiedIds.length > 0 ? completionVerifiedIds : sessionVerifiedIds)
          .map((id) => String(id || "").trim())
          .filter(Boolean);

        saved_verified_count =
          (typeof completionDoc?.saved_verified_count === "number" && Number.isFinite(completionDoc.saved_verified_count)
            ? completionDoc.saved_verified_count
            : null) ??
          (typeof sessionDoc?.saved_verified_count === "number" && Number.isFinite(sessionDoc.saved_verified_count)
            ? sessionDoc.saved_verified_count
            : null) ??
          (saved_company_ids_verified.length > 0 ? saved_company_ids_verified.length : null);

        saved_company_ids_unverified = Array.isArray(sessionDoc?.saved_company_ids_unverified)
          ? sessionDoc.saved_company_ids_unverified
          : [];

        saved_company_urls = Array.isArray(sessionDoc?.saved_company_urls) ? sessionDoc.saved_company_urls : [];

        save_outcome =
          typeof sessionDoc?.save_outcome === "string" && sessionDoc.save_outcome.trim()
            ? sessionDoc.save_outcome.trim()
            : typeof completionDoc?.save_outcome === "string" && completionDoc.save_outcome.trim()
              ? completionDoc.save_outcome.trim()
              : null;

        resume_error =
          typeof sessionDoc?.resume_error === "string" && sessionDoc.resume_error.trim() ? sessionDoc.resume_error.trim() : null;

        resume_error_details =
          sessionDoc?.resume_error_details && typeof sessionDoc.resume_error_details === "object"
            ? sessionDoc.resume_error_details
            : null;

        const completionSavedIds = Array.isArray(completionDoc?.saved_ids) ? completionDoc.saved_ids : [];
        const completionSaved = typeof completionDoc?.saved === "number" ? completionDoc.saved : null;
        const sessionSaved = typeof sessionDoc?.saved === "number" ? sessionDoc.saved : null;
        saved = completionSaved ?? sessionSaved ?? 0;

        if (completionSavedIds.length > 0) {
          stageBeaconValues.status_fetching_saved_companies = nowIso();
          const savedDocs = await fetchCompaniesByIds(container, completionSavedIds).catch(() => []);
          savedCompanyDocs = savedDocs;
          savedCompanies = toSavedCompanies(savedDocs);
          stageBeaconValues.status_fetched_saved_companies = nowIso();
        }

        // If the control doc only knows "saved" but not the saved_ids (or they weren't persisted yet),
        // still return the saved company doc(s) so the UI run history row isn't blank.
        if (Number(saved || 0) > 0 && (!Array.isArray(savedCompanyDocs) || savedCompanyDocs.length === 0)) {
          stageBeaconValues.status_fetching_saved_companies_fallback = nowIso();
          const fallbackDocs = await fetchRecentCompanies(container, {
            sessionId,
            take: Math.max(1, Math.min(200, Math.max(Number(saved) || 0, Number(take) || 10))),
            normalizedDomain: domainMeta.normalizedDomain,
            createdAfter: domainMeta.createdAfter,
          }).catch(() => []);

          if (Array.isArray(fallbackDocs) && fallbackDocs.length > 0) {
            savedCompanyDocs = fallbackDocs;
            savedCompanies = toSavedCompanies(fallbackDocs);
            stageBeaconValues.status_fetched_saved_companies_fallback = nowIso();
          }
        }

        // Authoritative reconciliation: async primary runs can persist companies even when the completion/session report is stale.
        if (Number(saved || 0) === 0) {
          stageBeaconValues.status_reconcile_saved_probe = nowIso();

          const authoritativeDocs = await fetchAuthoritativeSavedCompanies(container, {
            sessionId,
            sessionCreatedAt: domainMeta.sessionCreatedAt,
            normalizedDomain: domainMeta.normalizedDomain,
            createdAfter: domainMeta.createdAfter,
            limit: 200,
          }).catch(() => []);

          if (authoritativeDocs.length > 0) {
            const authoritativeIds = authoritativeDocs.map((d) => String(d?.id || "").trim()).filter(Boolean);
            const reason =
              String(primaryJob?.stage_beacon || "").trim() === "primary_early_exit" ? "saved_after_primary_async" : "post_primary_reconciliation";

            reconciled = true;
            reconcile_strategy = inferReconcileStrategy(authoritativeDocs, sessionId);
            reconciled_saved_ids = authoritativeIds;

            saved = authoritativeDocs.length;
            savedCompanyDocs = authoritativeDocs;
            savedCompanies = toSavedCompanies(authoritativeDocs);
            stageBeaconValues.status_reconciled_saved = nowIso();
            stageBeaconValues.status_reconciled_saved_count = saved;

            // Persist the corrected summary (best-effort). Never treat primary_early_exit as authoritative for saved=0.
            const now = nowIso();

            if (completionDoc) {
              await upsertDoc(container, {
                ...completionDoc,
                saved,
                saved_ids: authoritativeIds,
                reason,
                reconciled_at: now,
                updated_at: now,
              }).catch(() => null);
            }

            if (sessionDoc) {
              await upsertDoc(container, {
                ...sessionDoc,
                saved,
                companies_count: saved,
                reconciliation_reason: reason,
                reconciled_at: now,
                updated_at: now,
              }).catch(() => null);
            }
          } else {
            stageBeaconValues.status_reconciled_saved_none = nowIso();
          }
        }

        report = {
          session: sessionDoc
            ? {
                created_at: sessionDoc?.created_at || null,
                request_id: sessionDoc?.request_id || null,
                status: sessionDoc?.status || null,
                stage_beacon: sessionDoc?.stage_beacon || null,
                resume_needed: Boolean(sessionDoc?.resume_needed),
                request: sessionDoc?.request && typeof sessionDoc.request === "object" ? sessionDoc.request : null,
              }
            : null,
          accepted: Boolean(acceptDoc),
          accept: acceptDoc
            ? {
                accepted_at: acceptDoc?.accepted_at || acceptDoc?.created_at || null,
                reason: acceptDoc?.reason || null,
                stage_beacon: acceptDoc?.stage_beacon || null,
                remaining_ms: Number.isFinite(Number(acceptDoc?.remaining_ms)) ? Number(acceptDoc.remaining_ms) : null,
              }
            : null,
          completion: completionDoc
            ? {
                completed_at: completionDoc?.completed_at || completionDoc?.created_at || null,
                reason: completionDoc?.reason || null,
                saved: completionSaved,
                skipped: typeof completionDoc?.skipped === "number" ? completionDoc.skipped : null,
                failed: typeof completionDoc?.failed === "number" ? completionDoc.failed : null,
                saved_ids: completionSavedIds,
                skipped_ids: Array.isArray(completionDoc?.skipped_ids) ? completionDoc.skipped_ids : [],
                skipped_duplicates: Array.isArray(completionDoc?.skipped_duplicates) ? completionDoc.skipped_duplicates : [],
                failed_items: Array.isArray(completionDoc?.failed_items) ? completionDoc.failed_items : [],
              }
            : null,
          resume: resumeDoc
            ? {
                status: resumeDoc?.status || null,
                attempt: Number.isFinite(Number(resumeDoc?.attempt)) ? Number(resumeDoc.attempt) : 0,
                lock_expires_at: resumeDoc?.lock_expires_at || null,
                updated_at: resumeDoc?.updated_at || null,
              }
            : null,
        };
      }
    } catch {
      report = null;
      saved = 0;
      savedCompanies = [];
    }

    if (!report) {
      report = {
        session: null,
        accepted: false,
        accept: null,
        completion: null,
      };
    }

    report.primary_job = primaryJob
      ? {
          id: primaryJob?.id || null,
          job_state: finalJobState,
          stage_beacon: primaryJob?.stage_beacon || null,
          attempt: Number.isFinite(Number(primaryJob?.attempt)) ? Number(primaryJob.attempt) : 0,
          last_error: primaryJob?.last_error || null,
          created_at: primaryJob?.created_at || null,
          updated_at: primaryJob?.updated_at || null,
        }
      : null;

    const savedDocsForHealth =
      Array.isArray(savedCompanyDocs) && savedCompanyDocs.length > 0
        ? savedCompanyDocs
        : Array.isArray(primaryJob?.companies)
          ? primaryJob.companies
          : [];

    const saved_companies = toSavedCompanies(savedDocsForHealth);
    const enrichment_health_summary = summarizeEnrichmentHealth(saved_companies);

    // Always surface "verified save" fields while running so the Admin UI can render
    // stable saved counts + Open company links.
    if (!Number.isFinite(Number(saved_verified_count))) {
      saved_verified_count = saved_company_ids_verified.length > 0 ? saved_company_ids_verified.length : 0;
    }

    if (Array.isArray(saved_company_ids_verified) && saved_company_ids_verified.length === 0 && saved_companies.length > 0) {
      saved_company_ids_verified = saved_companies
        .map((c) => String(c?.company_id || "").trim())
        .filter(Boolean)
        .slice(0, 50);
    }

    if (Number(saved || 0) !== Number(saved_verified_count || 0)) {
      saved = Number(saved_verified_count || 0);
    }

    const resumeNeededFromSession = Boolean(report?.session && report.session.resume_needed);

    // Recompute missing fields on every status call, then reconcile terminal-only completion.
    // If the only missing fields are terminal (HQ/MFG "Not disclosed", reviews exhausted, logo not_found_on_site),
    // status must report resume_needed=false so imports do not stall forever.
    const resumeMissingAnalysis = analyzeMissingFieldsForResume(savedDocsForHealth);
    const resumeNeededFromHealth = resumeMissingAnalysis.total_retryable_missing > 0;

    stageBeaconValues.status_resume_missing_total = resumeMissingAnalysis.total_missing;
    stageBeaconValues.status_resume_missing_retryable = resumeMissingAnalysis.total_retryable_missing;
    stageBeaconValues.status_resume_missing_terminal = resumeMissingAnalysis.total_terminal_missing;
    if (resumeMissingAnalysis.terminal_only) stageBeaconValues.status_resume_terminal_only = nowIso();

    const missing_by_company = saved_companies
      .filter((c) => Array.isArray(c?.enrichment_health?.missing_fields) && c.enrichment_health.missing_fields.length > 0)
      .map((c) => ({
        company_id: c.company_id,
        company_name: c.company_name,
        website_url: c.website_url,
        missing_fields: c.enrichment_health.missing_fields,
      }));

    const resumeDocExists = Boolean(report?.resume);

    // If the saved companies are only missing terminal fields, ignore stale control-doc resume_needed/resume-doc existence.
    const resume_needed = resumeMissingAnalysis.terminal_only
      ? false
      : Boolean(resumeNeededFromSession || resumeNeededFromHealth || resumeDocExists);

    // Reflect terminal-only completion in the report payload as well.
    if (resumeMissingAnalysis.terminal_only && report?.session) {
      report.session.resume_needed = false;
      report.session.status = "complete";
      report.session.stage_beacon = "complete";
    } else if (report?.session && report.session.resume_needed === true && resume_needed === false) {
      report.session.resume_needed = false;
    }

    let resume_doc_created = false;
    let resume_triggered = false;
    let resume_trigger_error = null;
    let resume_trigger_error_details = null;
    let resume_gateway_key_attached = null;
    let resume_trigger_request_id = null;

    let resume_status = null;
    // Resume-worker is invoked in-process (no internal HTTP call), so Azure gateway/host-key requirements
    // do not gate the resume trigger.
    const resumeStalledByGatewayAuth = false;

    try {
      const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
      const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
      const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
      const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

      if (resume_needed && endpoint && key && CosmosClient) {
        const client = new CosmosClient({ endpoint, key });
        const container = client.database(databaseId).container(containerId);
        const resumeDocId = `_import_resume_${sessionId}`;

        const currentResume = await readControlDoc(container, resumeDocId, sessionId).catch(() => null);

        if (!currentResume) {
          const now = nowIso();
          await upsertDoc(container, {
            id: resumeDocId,
            session_id: sessionId,
            normalized_domain: "import",
            partition_key: "import",
            type: "import_control",
            created_at: now,
            updated_at: now,
            status: resumeStalledByGatewayAuth ? "stalled" : "queued",
            resume_auth: buildResumeAuthDiagnostics(),
            ...(resumeStalledByGatewayAuth
              ? {
                  stalled_at: now,
                  last_error: buildResumeStallError(),
                }
              : {}),
            missing_by_company,
          }).catch(() => null);
          resume_doc_created = true;
        }

        const resumeDoc = currentResume || (await readControlDoc(container, resumeDocId, sessionId).catch(() => null));
        const resumeStatusRaw = String(resumeDoc?.status || "").trim();
        const lockUntil = Date.parse(String(resumeDoc?.lock_expires_at || "")) || 0;

        let resumeStatus = resumeStatusRaw;

        if (resumeStalledByGatewayAuth) {
          const stalledAt = nowIso();
          const stall = buildResumeStallError();
          resumeStatus = "stalled";

          await upsertDoc(container, {
            ...resumeDoc,
            status: "stalled",
            stalled_at: stalledAt,
            resume_auth: buildResumeAuthDiagnostics(),
            last_error: buildResumeStallError(),
            updated_at: stalledAt,
            lock_expires_at: null,
          }).catch(() => null);

          try {
            const sessionDocId = `_import_session_${sessionId}`;
            const sessionDocForStall = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);
            if (sessionDocForStall && typeof sessionDocForStall === "object") {
              await upsertDoc(container, {
                ...sessionDocForStall,
                resume_error: stall.code,
                resume_error_details: {
                  root_cause: stall.root_cause,
                  message: stall.message,
                  missing_gateway_key: Boolean(stall.missing_gateway_key),
                  missing_internal_secret: Boolean(stall.missing_internal_secret),
                  ...buildResumeAuthDiagnostics(),
                  updated_at: stalledAt,
                },
                resume_needed: true,
                resume_worker_last_http_status: 401,
                resume_worker_last_reject_layer: "gateway",
                updated_at: stalledAt,
              }).catch(() => null);
            }
          } catch {}
        }

        resume_status = resumeStatus;
        const resumeUpdatedTs = Date.parse(String(resumeDoc?.updated_at || "")) || 0;
        const resumeAgeMs = resumeUpdatedTs ? Math.max(0, Date.now() - resumeUpdatedTs) : 0;

        // Hard stall detector: queued forever with no handler entry marker => label stalled.
        if (resumeDoc && resumeStatus === "queued" && resumeAgeMs > 90_000) {
          const sessionDocId = `_import_session_${sessionId}`;
          const sessionDocForStall = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);
          const enteredTs = Date.parse(String(sessionDocForStall?.resume_worker_handler_entered_at || "")) || 0;

          // If the worker never reached the handler after the resume doc was queued/updated, it's a gateway/host-key rejection.
          if (!enteredTs || (resumeUpdatedTs && enteredTs < resumeUpdatedTs)) {
            const stalledAt = nowIso();
            resumeStatus = "stalled";

            await upsertDoc(container, {
              ...resumeDoc,
              status: "stalled",
              stalled_at: stalledAt,
              last_error: {
                code: "resume_stalled_no_worker_entry",
                message: "Resume doc queued > 90s with no resume-worker handler entry marker",
              },
              updated_at: stalledAt,
              lock_expires_at: null,
            }).catch(() => null);

            if (sessionDocForStall && typeof sessionDocForStall === "object") {
              await upsertDoc(container, {
                ...sessionDocForStall,
                resume_error: "resume_stalled_no_worker_entry",
                resume_error_details: {
                  root_cause: "resume_stalled_no_worker_entry",
                  message: "Resume doc queued > 90s and resume-worker handler entry marker never updated",
                  updated_at: stalledAt,
                },
                resume_needed: true,
                updated_at: stalledAt,
              }).catch(() => null);
            }
          }
        }

        const canTrigger = !resumeStalledByGatewayAuth && (!lockUntil || Date.now() >= lockUntil);

        if (
          canTrigger &&
          (resumeStatus === "queued" || resumeStatus === "error" || resumeStatus === "stalled" || (forceResume && resumeStatus !== "running"))
        ) {
          const triggerAttemptAt = nowIso();
          stageBeaconValues.status_trigger_resume_worker = triggerAttemptAt;

          const workerRequest = buildInternalFetchRequest({
            job_kind: "import_resume",
          });

          const workerRes = await (async () => {
            try {
              const invokeRes = await invokeResumeWorkerInProcess({
                session_id: sessionId,
                context,
                workerRequest,
              });

              resume_gateway_key_attached = Boolean(invokeRes.gateway_key_attached);
              resume_trigger_request_id = invokeRes.request_id || workerRequest.request_id;

              return {
                ok: Boolean(invokeRes.ok),
                status: Number(invokeRes.status || 0) || 0,
                text: async () => String(invokeRes.bodyText || ""),
                _error: invokeRes.error,
              };
            } catch (e) {
              resume_gateway_key_attached = Boolean(workerRequest.gateway_key_attached);
              resume_trigger_request_id = workerRequest.request_id;
              return { ok: false, status: 0, text: async () => "", _error: e };
            }
          })();

          let workerText = "";
          try {
            if (workerRes && typeof workerRes.text === "function") workerText = await workerRes.text();
          } catch {}

          resume_triggered = Boolean(workerRes?.ok);
          if (!resume_triggered) {
            const statusCode = Number(workerRes?.status || 0) || 0;
            const preview = typeof workerText === "string" && workerText ? workerText.slice(0, 2000) : "";

            resume_trigger_error = workerRes?._error?.message || `resume_worker_http_${statusCode}`;
            resume_trigger_error_details = {
              invocation: "in_process",
              http_status: statusCode,
              response_text_preview: preview || null,
              gateway_key_attached: Boolean(resume_gateway_key_attached),
              request_id: resume_trigger_request_id || null,
            };

            // Persist deterministic diagnosis signals so AdminImport can render a concrete message.
            try {
              const sessionDocId = `_import_session_${sessionId}`;
              const sessionDocAfter = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);

              const enteredTs = Date.parse(String(sessionDocAfter?.resume_worker_handler_entered_at || "")) || 0;
              const attemptTs = Date.parse(String(triggerAttemptAt || "")) || Date.now();

              const rejectLayer =
                statusCode === 401
                  ? enteredTs && enteredTs >= attemptTs - 5000
                    ? "handler"
                    : "gateway"
                  : null;

              if (sessionDocAfter && typeof sessionDocAfter === "object") {
                await upsertDoc(container, {
                  ...sessionDocAfter,
                  resume_error: resume_trigger_error,
                  resume_error_details: resume_trigger_error_details,
                  resume_needed: true,
                  resume_worker_last_http_status: statusCode,
                  resume_worker_last_reject_layer: rejectLayer,
                  resume_worker_last_trigger_request_id: resume_trigger_request_id || null,
                  resume_worker_last_gateway_key_attached: Boolean(resume_gateway_key_attached),
                  updated_at: nowIso(),
                }).catch(() => null);
              }
            } catch {}
          }
        }
      }
    } catch (e) {
      resume_trigger_error = e?.message || String(e);
    }

    const forceComplete = Boolean(resumeMissingAnalysis?.terminal_only);

    const effectiveStatus = forceComplete ? "complete" : status === "error" ? "error" : status;
    const effectiveState = forceComplete ? "complete" : status === "error" ? "failed" : state;
    const effectiveJobState = forceComplete ? "complete" : finalJobState;

    const stageBeaconFromPrimary =
      typeof primaryJob?.stage_beacon === "string" && primaryJob.stage_beacon.trim()
        ? primaryJob.stage_beacon.trim()
        : status === "complete"
          ? "primary_complete"
          : status === "queued"
            ? "primary_search_started"
            : status === "running"
              ? "primary_search_started"
              : "primary_search_started";

    const sessionStageBeacon =
      typeof report?.session?.stage_beacon === "string" && report.session.stage_beacon.trim()
        ? report.session.stage_beacon.trim()
        : "";

    const shouldShowCompleteBeacon = Boolean((effectiveStatus === "complete" && !resume_needed) || resumeMissingAnalysis?.terminal_only);

    const effectiveStageBeacon = shouldShowCompleteBeacon
      ? "complete"
      : resume_needed
        ? "enrichment_resume_pending"
        : sessionStageBeacon || stageBeaconFromPrimary;

    stageBeaconValues.status_enrichment_health_summary = nowIso();
    stageBeaconValues.status_enrichment_incomplete = enrichment_health_summary.incomplete;

    if (resumeStalledByGatewayAuth) {
      const stall = buildResumeStallError();
      resume_status ||= "stalled";

      // Ensure status does not look like "running forever" when the environment cannot
      // authenticate internal resume-worker calls.
      if (!resume_error) resume_error = stall.code;
      if (!resume_error_details) {
        resume_error_details = {
          root_cause: stall.root_cause,
          message: stall.message,
          missing_gateway_key: Boolean(stall.missing_gateway_key),
          missing_internal_secret: Boolean(stall.missing_internal_secret),
          ...buildResumeAuthDiagnostics(),
          updated_at: nowIso(),
        };
      }

      // Mirror deterministic 'gateway' rejection semantics for UI rendering.
      if (typeof sessionDoc !== "undefined" && sessionDoc && typeof sessionDoc === "object") {
        sessionDoc.resume_worker_last_reject_layer = "gateway";
        if (typeof sessionDoc.resume_worker_last_http_status !== "number") {
          sessionDoc.resume_worker_last_http_status = 401;
        }
      }
    }

    return jsonWithSessionId(
      {
        ok: true,
        session_id: sessionId,
        status: effectiveStatus,
        state: effectiveState,
        job_state: effectiveJobState,
        stage_beacon: effectiveStageBeacon,
        stage_beacon_values: stageBeaconValues,
        primary_job_state: effectiveJobState,
        last_heartbeat_at: primaryJob?.last_heartbeat_at || null,
        lock_until: primaryJob?.lock_expires_at || null,
        attempts: Number.isFinite(Number(primaryJob?.attempt)) ? Number(primaryJob.attempt) : 0,
        last_error: primaryJob?.last_error || null,
        worker_meta: workerResult?.body?.meta || null,
        elapsed_ms: Number(progress?.elapsed_ms),
        remaining_budget_ms: Number(progress?.remaining_budget_ms),
        upstream_calls_made: Number(progress?.upstream_calls_made),
        companies_candidates_found: Number(progress?.companies_candidates_found),
        early_exit_triggered: Boolean(progress?.early_exit_triggered),
        companies_count:
          Number(saved || 0) > 0
            ? Number(saved)
            : Number.isFinite(Number(primaryJob?.companies_count))
              ? Number(primaryJob.companies_count)
              : 0,
        items: effectiveStatus === "error" ? [] : Array.isArray(primaryJob?.companies) ? primaryJob.companies : [],
        saved,
        saved_verified_count,
        saved_company_ids_verified,
        saved_company_ids_unverified,
        saved_company_urls,
        save_outcome,
        resume_error,
        resume_error_details,
        enrichment_last_write_error: (typeof sessionDoc !== "undefined" && sessionDoc)
          ? sessionDoc?.enrichment_last_write_error || null
          : null,
        reconciled,
        reconcile_strategy,
        reconciled_saved_ids,
        saved_companies,
        resume_needed,
        resume: {
          needed: resume_needed,
          status: resume_status || null,
          doc_created: Boolean(report?.resume) || resume_doc_created,
          triggered: resume_triggered,
          trigger_error: resume_trigger_error,
          trigger_error_details: resume_trigger_error_details,
          gateway_key_attached: Boolean(resume_gateway_key_attached),
          trigger_request_id: resume_trigger_request_id || null,
          internal_auth_configured: Boolean(internalAuthConfigured),
          ...buildResumeAuthDiagnostics(),
          missing_by_company,
        },
        resume_worker: (typeof sessionDoc !== "undefined" && sessionDoc)
          ? {
              last_invoked_at: sessionDoc?.resume_worker_last_invoked_at || null,
              handler_entered_at: sessionDoc?.resume_worker_handler_entered_at || null,
              handler_entered_build_id: sessionDoc?.resume_worker_handler_entered_build_id || null,
              last_reject_layer: sessionDoc?.resume_worker_last_reject_layer || null,
              last_auth: sessionDoc?.resume_worker_last_auth || null,
              last_finished_at: sessionDoc?.resume_worker_last_finished_at || null,
              last_result: sessionDoc?.resume_worker_last_result || null,
              last_ok: typeof sessionDoc?.resume_worker_last_ok === "boolean" ? sessionDoc.resume_worker_last_ok : null,
              last_http_status:
                typeof sessionDoc?.resume_worker_last_http_status === "number" ? sessionDoc.resume_worker_last_http_status : null,
              last_trigger_request_id: sessionDoc?.resume_worker_last_trigger_request_id || null,
              last_gateway_key_attached:
                typeof sessionDoc?.resume_worker_last_gateway_key_attached === "boolean"
                  ? sessionDoc.resume_worker_last_gateway_key_attached
                  : null,
              last_error: sessionDoc?.resume_worker_last_error || null,
              last_company_id: sessionDoc?.resume_worker_last_company_id || null,
              last_written_fields: Array.isArray(sessionDoc?.resume_worker_last_written_fields)
                ? sessionDoc.resume_worker_last_written_fields
                : null,
              last_stage_beacon: sessionDoc?.resume_worker_last_stage_beacon || null,
              last_resume_needed:
                typeof sessionDoc?.resume_worker_last_resume_needed === "boolean"
                  ? sessionDoc.resume_worker_last_resume_needed
                  : null,
            }
          : null,
        enrichment_health_summary,
        primary_job: {
          id: primaryJob?.id || null,
          job_state: finalJobState,
          attempt: Number.isFinite(Number(primaryJob?.attempt)) ? Number(primaryJob.attempt) : 0,
          attempts: Number.isFinite(Number(primaryJob?.attempt)) ? Number(primaryJob.attempt) : 0,
          last_error: primaryJob?.last_error || null,
          elapsed_ms: Number(progress?.elapsed_ms),
          remaining_budget_ms: Number(progress?.remaining_budget_ms),
          upstream_calls_made: Number(progress?.upstream_calls_made),
          companies_candidates_found: Number(progress?.companies_candidates_found),
          early_exit_triggered: Boolean(progress?.early_exit_triggered),
          last_heartbeat_at: primaryJob?.last_heartbeat_at || null,
          lock_expires_at: primaryJob?.lock_expires_at || null,
          locked_by: primaryJob?.locked_by || null,
          etag: primaryJob?._etag || primaryJob?.etag || null,
          storage: primaryJob?.storage || null,
        },
        inline_budget_ms: Number.isFinite(Number(primaryJob?.inline_budget_ms)) ? Number(primaryJob.inline_budget_ms) : 20_000,
        requested_deadline_ms:
          primaryJob?.requested_deadline_ms === null || primaryJob?.requested_deadline_ms === undefined
            ? null
            : Number.isFinite(Number(primaryJob.requested_deadline_ms))
              ? Number(primaryJob.requested_deadline_ms)
              : null,
        requested_stage_ms_primary:
          primaryJob?.requested_stage_ms_primary === null || primaryJob?.requested_stage_ms_primary === undefined
            ? null
            : Number.isFinite(Number(primaryJob.requested_stage_ms_primary))
              ? Number(primaryJob.requested_stage_ms_primary)
              : null,
        note:
          typeof primaryJob?.note === "string" && primaryJob.note.trim()
            ? primaryJob.note.trim()
            : "start endpoint is inline capped; long primary runs async",
        report,
      },
      200,
      req
    );
  }

  const mem = getImportSession(sessionId);
  if (mem) {
    stageBeaconValues.status_seen_session_memory = nowIso();
  }

  const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
  const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
  const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
  const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

  if (!endpoint || !key) {
    if (primaryJob) {
      const jobState = String(primaryJob.job_state || "queued");
      const status = jobState === "error" ? "error" : jobState === "complete" ? "complete" : jobState === "running" ? "running" : "queued";
      const state = status === "error" ? "failed" : status === "complete" ? "complete" : "running";

      return jsonWithSessionId(
        {
          ok: true,
          session_id: sessionId,
          status,
          state,
          stage_beacon:
            typeof primaryJob.stage_beacon === "string" && primaryJob.stage_beacon.trim()
              ? primaryJob.stage_beacon.trim()
              : status === "complete"
                ? "primary_complete"
                : status === "error"
                  ? "primary_search_started"
                  : status === "running"
                    ? "primary_search_started"
                    : "primary_search_started",
          stage_beacon_values: stageBeaconValues,
          primary_job_state: jobState,
          last_heartbeat_at: primaryJob?.last_heartbeat_at || null,
          lock_until: primaryJob?.lock_expires_at || null,
          attempts: Number.isFinite(Number(primaryJob?.attempt)) ? Number(primaryJob.attempt) : 0,
          last_error: primaryJob?.last_error || null,
          elapsed_ms: Number.isFinite(Number(primaryJob?.elapsed_ms)) ? Number(primaryJob.elapsed_ms) : null,
          remaining_budget_ms: Number.isFinite(Number(primaryJob?.remaining_budget_ms)) ? Number(primaryJob.remaining_budget_ms) : null,
          upstream_calls_made: Number.isFinite(Number(primaryJob?.upstream_calls_made)) ? Number(primaryJob.upstream_calls_made) : 0,
          companies_candidates_found: Number.isFinite(Number(primaryJob?.companies_candidates_found))
            ? Number(primaryJob.companies_candidates_found)
            : Number.isFinite(Number(primaryJob?.companies_count))
              ? Number(primaryJob.companies_count)
              : 0,
          early_exit_triggered: Boolean(primaryJob?.early_exit_triggered),
          companies_count: Number.isFinite(Number(primaryJob.companies_count)) ? Number(primaryJob.companies_count) : 0,
          items: Array.isArray(primaryJob.companies) ? primaryJob.companies : [],
          ...EMPTY_RESUME_DIAGNOSTICS,
          resume_needed: false,
          resume_error: null,
          resume_error_details: null,
          resume: {
            ...EMPTY_RESUME_DIAGNOSTICS.resume,
            needed: false,
          },
          resume_worker: EMPTY_RESUME_DIAGNOSTICS.resume_worker,
          primary_job: {
            id: primaryJob.id || null,
            job_state: jobState,
            attempt: Number.isFinite(Number(primaryJob.attempt)) ? Number(primaryJob.attempt) : 0,
            attempts: Number.isFinite(Number(primaryJob.attempt)) ? Number(primaryJob.attempt) : 0,
            last_error: primaryJob.last_error || null,
            elapsed_ms: Number.isFinite(Number(primaryJob?.elapsed_ms)) ? Number(primaryJob.elapsed_ms) : null,
            remaining_budget_ms: Number.isFinite(Number(primaryJob?.remaining_budget_ms)) ? Number(primaryJob.remaining_budget_ms) : null,
            upstream_calls_made: Number.isFinite(Number(primaryJob?.upstream_calls_made)) ? Number(primaryJob.upstream_calls_made) : 0,
            companies_candidates_found: Number.isFinite(Number(primaryJob?.companies_candidates_found))
              ? Number(primaryJob.companies_candidates_found)
              : Number.isFinite(Number(primaryJob?.companies_count))
                ? Number(primaryJob.companies_count)
                : 0,
            early_exit_triggered: Boolean(primaryJob?.early_exit_triggered),
            last_heartbeat_at: primaryJob?.last_heartbeat_at || null,
            lock_expires_at: primaryJob?.lock_expires_at || null,
            locked_by: primaryJob?.locked_by || null,
            etag: primaryJob?._etag || primaryJob?.etag || null,
            storage: primaryJob.storage || null,
          },
          inline_budget_ms: Number.isFinite(Number(primaryJob.inline_budget_ms)) ? Number(primaryJob.inline_budget_ms) : 20_000,
          requested_deadline_ms:
            primaryJob.requested_deadline_ms === null || primaryJob.requested_deadline_ms === undefined
              ? null
              : Number.isFinite(Number(primaryJob.requested_deadline_ms))
                ? Number(primaryJob.requested_deadline_ms)
                : null,
          requested_stage_ms_primary:
            primaryJob.requested_stage_ms_primary === null || primaryJob.requested_stage_ms_primary === undefined
              ? null
              : Number.isFinite(Number(primaryJob.requested_stage_ms_primary))
                ? Number(primaryJob.requested_stage_ms_primary)
                : null,
          note:
            typeof primaryJob.note === "string" && primaryJob.note.trim()
              ? primaryJob.note.trim()
              : "start endpoint is inline capped; long primary runs async",
        },
        200,
        req
      );
    }

    if (mem) {
      const memCompaniesCount = Number.isFinite(Number(mem.companies_count)) ? Number(mem.companies_count) : 0;
      const memVerifiedIds = Array.isArray(mem.saved_company_ids_verified) ? mem.saved_company_ids_verified : [];
      const memVerifiedCount = Number.isFinite(Number(mem.saved_verified_count))
        ? Number(mem.saved_verified_count)
        : memVerifiedIds.length;

      const saved_verified_count = memVerifiedCount;
      const saved_company_ids_verified = memVerifiedIds;
      const saved_company_ids_unverified = Array.isArray(mem.saved_company_ids_unverified) ? mem.saved_company_ids_unverified : [];
      const saved_company_urls = Array.isArray(mem.saved_company_urls) ? mem.saved_company_urls : [];
      const save_outcome = typeof mem.save_outcome === "string" && mem.save_outcome.trim() ? mem.save_outcome.trim() : null;
      const resume_needed = typeof mem.resume_needed === "boolean" ? mem.resume_needed : false;
      const resume_error = typeof mem.resume_error === "string" && mem.resume_error.trim() ? mem.resume_error.trim() : null;
      const resume_error_details =
        mem.resume_error_details && typeof mem.resume_error_details === "object" ? mem.resume_error_details : null;

      const saved = Number.isFinite(Number(mem.saved)) ? Number(mem.saved) : saved_verified_count;

      return jsonWithSessionId(
        {
          ok: true,
          session_id: sessionId,
          status: mem.status || "running",
          state: mem.status === "complete" ? "complete" : mem.status === "failed" ? "failed" : "running",
          job_state: null,
          stage_beacon: mem.stage_beacon || "init",
          stage_beacon_values: stageBeaconValues,
          elapsed_ms: null,
          remaining_budget_ms: null,
          upstream_calls_made: 0,
          companies_candidates_found: 0,
          early_exit_triggered: false,
          primary_job_state: null,
          last_heartbeat_at: null,
          lock_until: null,
          attempts: 0,
          last_error: null,
          companies_count: memCompaniesCount,
          saved,
          saved_verified_count,
          saved_company_ids_verified,
          saved_company_ids_unverified,
          saved_company_urls,
          save_outcome,
          ...EMPTY_RESUME_DIAGNOSTICS,
          resume_needed,
          resume_error:
            resume_needed && !gatewayKeyConfigured
              ? buildResumeStallError().code
              : resume_error,
          resume_error_details:
            resume_needed && !gatewayKeyConfigured
              ? (() => {
                  const stall = buildResumeStallError();
                  return {
                    root_cause: stall.root_cause,
                    http_status: 401,
                    message: stall.message,
                    missing_gateway_key: Boolean(stall.missing_gateway_key),
                    missing_internal_secret: Boolean(stall.missing_internal_secret),
                    ...buildResumeAuthDiagnostics(),
                    updated_at: nowIso(),
                  };
                })()
              : resume_error_details,
          resume: {
            ...EMPTY_RESUME_DIAGNOSTICS.resume,
            needed: resume_needed,
            status: resume_needed && !gatewayKeyConfigured ? "stalled" : null,
            trigger_error:
              resume_needed && !gatewayKeyConfigured
                ? buildResumeStallError().code
                : resume_error,
            trigger_error_details:
              resume_needed && !gatewayKeyConfigured
                ? (() => {
                    const stall = buildResumeStallError();
                    return {
                      root_cause: stall.root_cause,
                      http_status: 401,
                      message: stall.message,
                      missing_gateway_key: Boolean(stall.missing_gateway_key),
                      missing_internal_secret: Boolean(stall.missing_internal_secret),
                      ...buildResumeAuthDiagnostics(),
                      updated_at: nowIso(),
                    };
                  })()
                : resume_error_details,
            internal_auth_configured: Boolean(internalAuthConfigured),
            ...buildResumeAuthDiagnostics(),
          },
          resume_worker: {
            ...EMPTY_RESUME_DIAGNOSTICS.resume_worker,
            last_reject_layer: resume_needed && !gatewayKeyConfigured ? "gateway" : null,
            last_http_status: resume_needed && !gatewayKeyConfigured ? 401 : null,
          },
          saved_companies: [],
        },
        200,
        req
      );
    }

    return jsonWithSessionId({ ok: false, error: "Unknown session_id", session_id: sessionId, ...EMPTY_RESUME_DIAGNOSTICS }, 404);
  }

  try {
    if (!CosmosClient) {
      if (mem) {
        const memCompaniesCount = Number.isFinite(Number(mem.companies_count)) ? Number(mem.companies_count) : 0;
        const memVerifiedIds = Array.isArray(mem.saved_company_ids_verified) ? mem.saved_company_ids_verified : [];
        const memVerifiedCount = Number.isFinite(Number(mem.saved_verified_count))
          ? Number(mem.saved_verified_count)
          : memVerifiedIds.length;

        const saved_verified_count = memVerifiedCount;
        const saved_company_ids_verified = memVerifiedIds;
        const saved_company_ids_unverified = Array.isArray(mem.saved_company_ids_unverified) ? mem.saved_company_ids_unverified : [];
        const saved_company_urls = Array.isArray(mem.saved_company_urls) ? mem.saved_company_urls : [];
        const save_outcome = typeof mem.save_outcome === "string" && mem.save_outcome.trim() ? mem.save_outcome.trim() : null;
        const resume_needed = typeof mem.resume_needed === "boolean" ? mem.resume_needed : false;
        const resume_error = typeof mem.resume_error === "string" && mem.resume_error.trim() ? mem.resume_error.trim() : null;
      const resume_error_details =
        mem.resume_error_details && typeof mem.resume_error_details === "object" ? mem.resume_error_details : null;

        const saved = Number.isFinite(Number(mem.saved)) ? Number(mem.saved) : saved_verified_count;

        return jsonWithSessionId(
          {
            ok: true,
            session_id: sessionId,
            status: mem.status || "running",
            state: mem.status === "complete" ? "complete" : mem.status === "failed" ? "failed" : "running",
            job_state: null,
            stage_beacon: mem.stage_beacon || "init",
            stage_beacon_values: stageBeaconValues,
            elapsed_ms: null,
            remaining_budget_ms: null,
            upstream_calls_made: 0,
            companies_candidates_found: 0,
            early_exit_triggered: false,
            primary_job_state: null,
            last_heartbeat_at: null,
            lock_until: null,
            attempts: 0,
            last_error: null,
            companies_count: memCompaniesCount,
            saved,
            saved_verified_count,
            saved_company_ids_verified,
            saved_company_ids_unverified,
            saved_company_urls,
            save_outcome,
          ...EMPTY_RESUME_DIAGNOSTICS,
          resume_needed,
          resume_error:
            resume_needed && !gatewayKeyConfigured
              ? buildResumeStallError().code
              : resume_error,
          resume_error_details:
            resume_needed && !gatewayKeyConfigured
              ? (() => {
                  const stall = buildResumeStallError();
                  return {
                    root_cause: stall.root_cause,
                    http_status: 401,
                    message: stall.message,
                    missing_gateway_key: Boolean(stall.missing_gateway_key),
                    missing_internal_secret: Boolean(stall.missing_internal_secret),
                    ...buildResumeAuthDiagnostics(),
                    updated_at: nowIso(),
                  };
                })()
              : resume_error_details,
          resume: {
            ...EMPTY_RESUME_DIAGNOSTICS.resume,
            needed: resume_needed,
            status: resume_needed && !gatewayKeyConfigured ? "stalled" : null,
            trigger_error:
              resume_needed && !gatewayKeyConfigured
                ? buildResumeStallError().code
                : resume_error,
            trigger_error_details:
              resume_needed && !gatewayKeyConfigured
                ? (() => {
                    const stall = buildResumeStallError();
                    return {
                      root_cause: stall.root_cause,
                      http_status: 401,
                      message: stall.message,
                      missing_gateway_key: Boolean(stall.missing_gateway_key),
                      missing_internal_secret: Boolean(stall.missing_internal_secret),
                      ...buildResumeAuthDiagnostics(),
                      updated_at: nowIso(),
                    };
                  })()
                : resume_error_details,
            internal_auth_configured: Boolean(internalAuthConfigured),
            ...buildResumeAuthDiagnostics(),
          },
          resume_worker: {
            ...EMPTY_RESUME_DIAGNOSTICS.resume_worker,
            last_reject_layer: resume_needed && !gatewayKeyConfigured ? "gateway" : null,
            last_http_status: resume_needed && !gatewayKeyConfigured ? 401 : null,
          },
          saved_companies: [],
          },
          200,
          req
        );
      }

      return jsonWithSessionId(
        {
          ok: false,
          session_id: sessionId,
          error: "Cosmos client module unavailable",
          code: "COSMOS_MODULE_MISSING",
          ...EMPTY_RESUME_DIAGNOSTICS,
        },
        200
      );
    }

    const client = new CosmosClient({ endpoint, key });
    const container = client.database(databaseId).container(containerId);

    const sessionDocId = `_import_session_${sessionId}`;
    const completionDocId = `_import_complete_${sessionId}`;
    const timeoutDocId = `_import_timeout_${sessionId}`;
    const stopDocId = `_import_stop_${sessionId}`;
    const errorDocId = `_import_error_${sessionId}`;
    const acceptDocId = `_import_accept_${sessionId}`;

    const [sessionDoc, completionDoc, timeoutDoc, stopDoc, errorDoc, acceptDoc, resumeDoc] = await Promise.all([
      readControlDoc(container, sessionDocId, sessionId),
      readControlDoc(container, completionDocId, sessionId),
      readControlDoc(container, timeoutDocId, sessionId),
      readControlDoc(container, stopDocId, sessionId),
      readControlDoc(container, errorDocId, sessionId),
      readControlDoc(container, acceptDocId, sessionId),
      readControlDoc(container, `_import_resume_${sessionId}`, sessionId),
    ]);

    let known = Boolean(sessionDoc || completionDoc || timeoutDoc || stopDoc || errorDoc || acceptDoc);
    if (!known) known = await hasAnyCompanyDocs(container, sessionId);

    if (!known) {
      return jsonWithSessionId({ ok: false, error: "Unknown session_id", session_id: sessionId, ...EMPTY_RESUME_DIAGNOSTICS }, 404);
    }

    stageBeaconValues.status_seen_control_docs = nowIso();

    const errorPayload = normalizeErrorPayload(errorDoc?.error || null);
    const timedOut = Boolean(timeoutDoc);
    const stopped = Boolean(stopDoc);
    const completed = Boolean(completionDoc);

    const domainMeta = deriveDomainAndCreatedAfter({ sessionDoc, acceptDoc });

    const items = await fetchRecentCompanies(container, {
      sessionId,
      take,
      normalizedDomain: domainMeta.normalizedDomain,
      createdAfter: domainMeta.createdAfter,
    }).catch(() => []);
    const completionVerifiedIds = Array.isArray(completionDoc?.saved_company_ids_verified)
      ? completionDoc.saved_company_ids_verified
      : Array.isArray(completionDoc?.saved_ids)
        ? completionDoc.saved_ids
        : [];

    const sessionVerifiedIds = Array.isArray(sessionDoc?.saved_company_ids_verified)
      ? sessionDoc.saved_company_ids_verified
      : Array.isArray(sessionDoc?.saved_ids)
        ? sessionDoc.saved_ids
        : [];

    let savedIds = (completionVerifiedIds.length > 0 ? completionVerifiedIds : sessionVerifiedIds)
      .map((id) => String(id || "").trim())
      .filter(Boolean);

    const derivedVerifiedCount = savedIds.length;

    const savedVerifiedCount =
      (typeof completionDoc?.saved_verified_count === "number" ? completionDoc.saved_verified_count : null) ??
      (typeof sessionDoc?.saved_verified_count === "number" ? sessionDoc.saved_verified_count : null) ??
      (derivedVerifiedCount > 0 ? derivedVerifiedCount : null);

    // Truthfulness: `saved` must come from verified fields only.
    // Never infer `saved` from candidate items or attempted writes.
    let saved = Number.isFinite(Number(savedVerifiedCount)) ? Number(savedVerifiedCount) : 0;

    let savedDocs = savedIds.length > 0 ? await fetchCompaniesByIds(container, savedIds).catch(() => []) : [];
    let saved_companies = savedDocs.length > 0 ? toSavedCompanies(savedDocs) : [];
    let completionReason = typeof completionDoc?.reason === "string" ? completionDoc.reason : null;

    let reconciled = false;
    let reconcile_strategy = null;
    let reconciled_saved_ids = [];

    // Authoritative reconciliation for control-plane vs data-plane mismatch (retroactive).
    if (Number(saved || 0) === 0) {
      stageBeaconValues.status_reconcile_saved_probe = nowIso();

      const authoritativeDocs = await fetchAuthoritativeSavedCompanies(container, {
        sessionId,
        sessionCreatedAt: domainMeta.sessionCreatedAt,
        normalizedDomain: domainMeta.normalizedDomain,
        createdAfter: domainMeta.createdAfter,
        limit: 200,
      }).catch(() => []);

      if (authoritativeDocs.length > 0) {
        const authoritativeIds = authoritativeDocs.map((d) => String(d?.id || "").trim()).filter(Boolean);
        const beaconForReason =
          (typeof acceptDoc?.stage_beacon === "string" && acceptDoc.stage_beacon.trim() ? acceptDoc.stage_beacon.trim() : "") ||
          (typeof sessionDoc?.stage_beacon === "string" && sessionDoc.stage_beacon.trim() ? sessionDoc.stage_beacon.trim() : "") ||
          (typeof completionDoc?.reason === "string" && completionDoc.reason.trim() ? completionDoc.reason.trim() : "");

        const reason =
          beaconForReason === "primary_early_exit" ? "saved_after_primary_async" : "post_primary_reconciliation";

        reconciled = true;
        reconcile_strategy = inferReconcileStrategy(authoritativeDocs, sessionId);
        reconciled_saved_ids = authoritativeIds;

        saved = authoritativeDocs.length;
        savedIds = authoritativeIds;
        savedDocs = authoritativeDocs;
        saved_companies = toSavedCompanies(authoritativeDocs);
        completionReason = reason;

        stageBeaconValues.status_reconciled_saved = nowIso();
        stageBeaconValues.status_reconciled_saved_count = saved;

        // Persist the corrected summary (best-effort)
        const now = nowIso();

        if (completionDoc) {
          await upsertDoc(container, {
            ...completionDoc,
            saved,
            saved_ids: authoritativeIds,
            reason,
            reconciled_at: now,
            updated_at: now,
          }).catch(() => null);
        }

        if (sessionDoc) {
          await upsertDoc(container, {
            ...sessionDoc,
            saved,
            companies_count: saved,
            reconciliation_reason: reason,
            reconciled_at: now,
            updated_at: now,
          }).catch(() => null);
        }
      } else {
        stageBeaconValues.status_reconciled_saved_none = nowIso();
      }
    }

    const lastCreatedAt = Array.isArray(items) && items.length > 0 ? String(items[0]?.created_at || "") : "";

    let stage_beacon =
      (typeof errorDoc?.stage === "string" && errorDoc.stage.trim() ? errorDoc.stage.trim() : null) ||
      (typeof errorDoc?.error?.step === "string" && errorDoc.error.step.trim() ? errorDoc.error.step.trim() : null) ||
      (typeof sessionDoc?.stage_beacon === "string" && sessionDoc.stage_beacon.trim() ? sessionDoc.stage_beacon.trim() : null) ||
      (typeof acceptDoc?.stage_beacon === "string" && acceptDoc.stage_beacon.trim() ? acceptDoc.stage_beacon.trim() : null) ||
      (completed ? "complete" : timedOut ? "timeout" : stopped ? "stopped" : "running");

    const cosmosTarget = (() => {
      const pick = (key) =>
        (sessionDoc && sessionDoc[key] != null ? sessionDoc[key] : null) ??
        (completionDoc && completionDoc[key] != null ? completionDoc[key] : null) ??
        (acceptDoc && acceptDoc[key] != null ? acceptDoc[key] : null) ??
        null;

      const diag = {
        cosmos_account_host_redacted: pick("cosmos_account_host_redacted"),
        cosmos_db_name: pick("cosmos_db_name"),
        cosmos_container_name: pick("cosmos_container_name"),
        cosmos_container_partition_key_path: pick("cosmos_container_partition_key_path"),
      };

      const hasAny = Object.values(diag).some((v) => typeof v === "string" ? v.trim() : v != null);
      return hasAny ? diag : null;
    })();

    const report = {
      session: sessionDoc
        ? {
            created_at: sessionDoc?.created_at || null,
            request_id: sessionDoc?.request_id || null,
            status: sessionDoc?.status || null,
            stage_beacon: sessionDoc?.stage_beacon || null,
            resume_needed: Boolean(sessionDoc?.resume_needed),
          }
        : null,
      accepted: Boolean(acceptDoc),
      accept: acceptDoc
        ? {
            accepted_at: acceptDoc?.accepted_at || acceptDoc?.created_at || null,
            reason: acceptDoc?.reason || null,
            stage_beacon: acceptDoc?.stage_beacon || null,
            remaining_ms: Number.isFinite(Number(acceptDoc?.remaining_ms)) ? Number(acceptDoc.remaining_ms) : null,
          }
        : null,
      completion: completionDoc
        ? {
            completed_at: completionDoc?.completed_at || completionDoc?.created_at || null,
            reason: completionReason || null,
            saved: typeof completionDoc?.saved === "number" ? completionDoc.saved : null,
            skipped: typeof completionDoc?.skipped === "number" ? completionDoc.skipped : null,
            failed: typeof completionDoc?.failed === "number" ? completionDoc.failed : null,
            saved_ids: savedIds,
            skipped_ids: Array.isArray(completionDoc?.skipped_ids) ? completionDoc.skipped_ids : [],
            failed_items: Array.isArray(completionDoc?.failed_items) ? completionDoc.failed_items : [],
          }
        : null,
      resume: resumeDoc
        ? {
            status: resumeDoc?.status || null,
            attempt: Number.isFinite(Number(resumeDoc?.attempt)) ? Number(resumeDoc.attempt) : 0,
            lock_expires_at: resumeDoc?.lock_expires_at || null,
            updated_at: resumeDoc?.updated_at || null,
          }
        : null,
    };

    const enrichment_health_summary = summarizeEnrichmentHealth(saved_companies);

    const resumeMissingAnalysis = analyzeMissingFieldsForResume(savedDocs);
    const resumeNeededFromHealth = resumeMissingAnalysis.total_retryable_missing > 0;

    const forceComplete = Boolean(resumeMissingAnalysis.terminal_only);
    if (forceComplete) stage_beacon = "complete";

    stageBeaconValues.status_resume_missing_total = resumeMissingAnalysis.total_missing;
    stageBeaconValues.status_resume_missing_retryable = resumeMissingAnalysis.total_retryable_missing;
    stageBeaconValues.status_resume_missing_terminal = resumeMissingAnalysis.total_terminal_missing;
    if (resumeMissingAnalysis.terminal_only) stageBeaconValues.status_resume_terminal_only = nowIso();

    const missing_by_company = saved_companies
      .filter((c) => Array.isArray(c?.enrichment_health?.missing_fields) && c.enrichment_health.missing_fields.length > 0)
      .map((c) => ({
        company_id: c.company_id,
        company_name: c.company_name,
        website_url: c.website_url,
        missing_fields: c.enrichment_health.missing_fields,
      }));

    // Terminal-only missing fields must not keep the session "running".
    const resume_needed = resumeMissingAnalysis.terminal_only
      ? false
      : Boolean(sessionDoc?.resume_needed) || resumeNeededFromHealth || Boolean(resumeDoc);

    if (resumeMissingAnalysis.terminal_only && sessionDoc && sessionDoc.resume_needed) {
      const now = nowIso();
      sessionDoc.resume_needed = false;
      sessionDoc.status = "complete";
      sessionDoc.stage_beacon = "complete";
      sessionDoc.updated_at = now;
      await upsertDoc(container, { ...sessionDoc }).catch(() => null);
    }

    let resume_doc_created = false;
    let resume_triggered = false;
    let resume_trigger_error = null;
    let resume_trigger_error_details = null;
    let resume_gateway_key_attached = null;
    let resume_trigger_request_id = null;

    let resume_status = null;
    const resumeStalledByGatewayAuth = Boolean(resume_needed && !gatewayKeyConfigured);

    if (resume_needed) {
      try {
        const resumeDocId = `_import_resume_${sessionId}`;
        let currentResume = resumeDoc;

        if (!currentResume) {
          const now = nowIso();
          await upsertDoc(container, {
            id: resumeDocId,
            session_id: sessionId,
            normalized_domain: "import",
            partition_key: "import",
            type: "import_control",
            created_at: now,
            updated_at: now,
            status: resumeStalledByGatewayAuth ? "stalled" : "queued",
            resume_auth: buildResumeAuthDiagnostics(),
            ...(resumeStalledByGatewayAuth
              ? {
                  stalled_at: now,
                  last_error: buildResumeStallError(),
                }
              : {}),
            missing_by_company,
          }).catch(() => null);
          resume_doc_created = true;

          currentResume = await readControlDoc(container, resumeDocId, sessionId).catch(() => null);
        }

        let resumeStatus = String(currentResume?.status || "").trim();
        const lockUntil = Date.parse(String(currentResume?.lock_expires_at || "")) || 0;

        if (resumeStalledByGatewayAuth) {
          const stalledAt = nowIso();
          const stall = buildResumeStallError();
          resumeStatus = "stalled";

          await upsertDoc(container, {
            ...currentResume,
            status: "stalled",
            stalled_at: stalledAt,
            resume_auth: buildResumeAuthDiagnostics(),
            last_error: buildResumeStallError(),
            lock_expires_at: null,
            updated_at: stalledAt,
          }).catch(() => null);

          if (sessionDoc && typeof sessionDoc === "object") {
            const details = {
              root_cause: stall.root_cause,
              message: stall.message,
              missing_gateway_key: Boolean(stall.missing_gateway_key),
              missing_internal_secret: Boolean(stall.missing_internal_secret),
              ...buildResumeAuthDiagnostics(),
              updated_at: stalledAt,
            };

            // Ensure subsequent response shaping reads the deterministic failure signals.
            sessionDoc.resume_error = stall.code;
            sessionDoc.resume_error_details = details;
            sessionDoc.resume_worker_last_http_status = 401;
            sessionDoc.resume_worker_last_reject_layer = "gateway";

            await upsertDoc(container, {
              ...sessionDoc,
              resume_error: stall.code,
              resume_error_details: details,
              resume_needed: true,
              resume_worker_last_http_status: 401,
              resume_worker_last_reject_layer: "gateway",
              updated_at: stalledAt,
            }).catch(() => null);
          }
        }

        resume_status = resumeStatus;

        const canTrigger = !resumeStalledByGatewayAuth && (!lockUntil || Date.now() >= lockUntil);

        if (
          canTrigger &&
          (resumeStatus === "queued" || resumeStatus === "error" || resumeStatus === "stalled" || (forceResume && resumeStatus !== "running"))
        ) {
          const triggerAttemptAt = nowIso();
          stageBeaconValues.status_trigger_resume_worker = triggerAttemptAt;

          const workerRequest = buildInternalFetchRequest({
            job_kind: "import_resume",
          });

          const workerRes = await (async () => {
            try {
              const invokeRes = await invokeResumeWorkerInProcess({
                session_id: sessionId,
                context,
                workerRequest,
              });

              resume_gateway_key_attached = Boolean(invokeRes.gateway_key_attached);
              resume_trigger_request_id = invokeRes.request_id || workerRequest.request_id;

              return {
                ok: Boolean(invokeRes.ok),
                status: Number(invokeRes.status || 0) || 0,
                text: async () => String(invokeRes.bodyText || ""),
                _error: invokeRes.error,
              };
            } catch (e) {
              resume_gateway_key_attached = Boolean(workerRequest.gateway_key_attached);
              resume_trigger_request_id = workerRequest.request_id;
              return { ok: false, status: 0, text: async () => "", _error: e };
            }
          })();

          let workerText = "";
          try {
            if (workerRes && typeof workerRes.text === "function") workerText = await workerRes.text();
          } catch {}

          resume_triggered = Boolean(workerRes?.ok);
          if (!resume_triggered) {
            const statusCode = Number(workerRes?.status || 0) || 0;
            const preview = typeof workerText === "string" && workerText ? workerText.slice(0, 2000) : "";

            resume_trigger_error = workerRes?._error?.message || `resume_worker_http_${statusCode}`;
            resume_trigger_error_details = {
              invocation: "in_process",
              http_status: statusCode,
              response_text_preview: preview || null,
              gateway_key_attached: Boolean(resume_gateway_key_attached),
              request_id: resume_trigger_request_id || null,
            };

            // Persist deterministic diagnosis signals so AdminImport can render a concrete message.
            try {
              const sessionDocId = `_import_session_${sessionId}`;
              const sessionDocAfter = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);

              const enteredTs = Date.parse(String(sessionDocAfter?.resume_worker_handler_entered_at || "")) || 0;
              const attemptTs = Date.parse(String(triggerAttemptAt || "")) || Date.now();

              const rejectLayer =
                statusCode === 401
                  ? enteredTs && enteredTs >= attemptTs - 5000
                    ? "handler"
                    : "gateway"
                  : null;

              if (sessionDocAfter && typeof sessionDocAfter === "object") {
                await upsertDoc(container, {
                  ...sessionDocAfter,
                  resume_error: resume_trigger_error,
                  resume_error_details: resume_trigger_error_details,
                  resume_needed: true,
                  resume_worker_last_http_status: statusCode,
                  resume_worker_last_reject_layer: rejectLayer,
                  resume_worker_last_trigger_request_id: resume_trigger_request_id || null,
                  resume_worker_last_gateway_key_attached: Boolean(resume_gateway_key_attached),
                  updated_at: nowIso(),
                }).catch(() => null);
              }
            } catch {}
          }
        }
      } catch (e) {
        resume_trigger_error = e?.message || String(e);
      }

      if (resume_trigger_error && sessionDoc) {
        const now = nowIso();
        await upsertDoc(container, {
          ...sessionDoc,
          resume_error: String(resume_trigger_error || "").trim(),
          resume_error_details:
            resume_trigger_error_details && typeof resume_trigger_error_details === "object" ? resume_trigger_error_details : null,
          resume_error_at: now,
          updated_at: now,
        }).catch(() => null);
      }
    }

    const effectiveCompleted = forceComplete || (completed && !resume_needed);

    const saved_verified_count =
      sessionDoc && typeof sessionDoc.saved_verified_count === "number" && Number.isFinite(sessionDoc.saved_verified_count)
        ? sessionDoc.saved_verified_count
        : Number.isFinite(Number(savedVerifiedCount))
          ? Number(savedVerifiedCount)
          : Number(saved || 0) || 0;

    const saved_company_ids_verified = Array.isArray(sessionDoc?.saved_company_ids_verified)
      ? sessionDoc.saved_company_ids_verified
      : Array.isArray(savedIds)
        ? savedIds
        : [];

    const saved_company_ids_unverified = Array.isArray(sessionDoc?.saved_company_ids_unverified)
      ? sessionDoc.saved_company_ids_unverified
      : [];

    const save_outcome =
      typeof sessionDoc?.save_outcome === "string" && sessionDoc.save_outcome.trim()
        ? sessionDoc.save_outcome.trim()
        : typeof completionDoc?.save_outcome === "string" && completionDoc.save_outcome.trim()
          ? completionDoc.save_outcome.trim()
          : null;

    const saved_company_urls = Array.isArray(sessionDoc?.saved_company_urls)
      ? sessionDoc.saved_company_urls
      : Array.isArray(completionDoc?.saved_company_urls)
        ? completionDoc.saved_company_urls
        : [];

    const resume_error =
      typeof sessionDoc?.resume_error === "string" && sessionDoc.resume_error.trim() ? sessionDoc.resume_error.trim() : null;

    const resume_error_details =
      sessionDoc?.resume_error_details && typeof sessionDoc.resume_error_details === "object" ? sessionDoc.resume_error_details : null;

    const requestObj = sessionDoc?.request && typeof sessionDoc.request === "object" ? sessionDoc.request : null;
    const requestQueryTypes = Array.isArray(requestObj?.queryTypes)
      ? requestObj.queryTypes.map((t) => String(t || "").trim()).filter(Boolean)
      : [];
    const isCompanyUrlImport = requestQueryTypes.includes("company_url");

    if (errorPayload || timedOut || stopped) {
      const errorOut =
        errorPayload ||
        (timedOut
          ? { code: "IMPORT_TIMEOUT", message: "Import timed out" }
          : stopped
            ? { code: "IMPORT_STOPPED", message: "Import was stopped" }
            : null);

      return jsonWithSessionId(
        {
          ok: true,
          session_id: sessionId,
          status: "error",
          state: "failed",
          job_state: null,
          stage_beacon,
          stage_beacon_values: stageBeaconValues,
          ...(cosmosTarget ? cosmosTarget : {}),
          primary_job_state: null,
          elapsed_ms: null,
          remaining_budget_ms: null,
          upstream_calls_made: 0,
          companies_candidates_found: 0,
          early_exit_triggered: false,
          last_heartbeat_at: null,
          lock_until: null,
          attempts: 0,
          last_error: errorOut,
          companies_count: saved,
          error: errorOut,
          items,
          saved,
          saved_verified_count,
          saved_company_ids_verified,
          saved_company_ids_unverified,
          saved_company_urls,
          save_outcome,
          resume_error,
          resume_error_details,
        resume_error_details,
        enrichment_last_write_error: (typeof sessionDoc !== "undefined" && sessionDoc)
          ? sessionDoc?.enrichment_last_write_error || null
          : null,
        reconciled,
          reconcile_strategy,
          reconciled_saved_ids,
          saved_companies,
          resume_needed,
          resume: {
          needed: resume_needed,
          status: resume_status || null,
            doc_created: Boolean(report?.resume) || resume_doc_created,
            triggered: resume_triggered,
            trigger_error: resume_trigger_error,
          trigger_error_details: resume_trigger_error_details,
          gateway_key_attached: Boolean(resume_gateway_key_attached),
          trigger_request_id: resume_trigger_request_id || null,
          internal_auth_configured: Boolean(internalAuthConfigured),
          ...buildResumeAuthDiagnostics(),
          missing_by_company,
        },
        resume_worker: (typeof sessionDoc !== "undefined" && sessionDoc)
          ? {
              last_invoked_at: sessionDoc?.resume_worker_last_invoked_at || null,
              handler_entered_at: sessionDoc?.resume_worker_handler_entered_at || null,
              handler_entered_build_id: sessionDoc?.resume_worker_handler_entered_build_id || null,
              last_reject_layer: sessionDoc?.resume_worker_last_reject_layer || null,
              last_auth: sessionDoc?.resume_worker_last_auth || null,
              last_finished_at: sessionDoc?.resume_worker_last_finished_at || null,
              last_result: sessionDoc?.resume_worker_last_result || null,
              last_ok: typeof sessionDoc?.resume_worker_last_ok === "boolean" ? sessionDoc.resume_worker_last_ok : null,
              last_http_status:
                typeof sessionDoc?.resume_worker_last_http_status === "number" ? sessionDoc.resume_worker_last_http_status : null,
              last_trigger_request_id: sessionDoc?.resume_worker_last_trigger_request_id || null,
              last_gateway_key_attached:
                typeof sessionDoc?.resume_worker_last_gateway_key_attached === "boolean"
                  ? sessionDoc.resume_worker_last_gateway_key_attached
                  : null,
              last_error: sessionDoc?.resume_worker_last_error || null,
              last_company_id: sessionDoc?.resume_worker_last_company_id || null,
              last_written_fields: Array.isArray(sessionDoc?.resume_worker_last_written_fields)
                ? sessionDoc.resume_worker_last_written_fields
                : null,
              last_stage_beacon: sessionDoc?.resume_worker_last_stage_beacon || null,
              last_resume_needed:
                typeof sessionDoc?.resume_worker_last_resume_needed === "boolean"
                  ? sessionDoc.resume_worker_last_resume_needed
                  : null,
            }
          : null,
        enrichment_health_summary,
          lastCreatedAt,
          timedOut,
          stopped,
          report,
        },
        200,
        req
      );
    }

    if (isCompanyUrlImport && effectiveCompleted && saved_verified_count === 0) {
      const failed_items =
        Array.isArray(completionDoc?.failed_items)
          ? completionDoc.failed_items
          : Array.isArray(sessionDoc?.failed_items)
            ? sessionDoc.failed_items
            : [];

      const skipped_ids = Array.isArray(completionDoc?.skipped_ids)
        ? completionDoc.skipped_ids
        : Array.isArray(sessionDoc?.skipped_ids)
          ? sessionDoc.skipped_ids
          : [];

      const errorOut = {
        code: "COSMOS_SAVE_FAILED",
        message: "company_url import completed without a persisted seed company",
      };

      return jsonWithSessionId(
        {
          ok: false,
          root_cause: "cosmos_save_failed",
          session_id: sessionId,
          status: "error",
          state: "failed",
          job_state: null,
          stage_beacon: "cosmos_save_failed",
          stage_beacon_values: stageBeaconValues,
          ...(cosmosTarget ? cosmosTarget : {}),
          primary_job_state: null,
          elapsed_ms: null,
          remaining_budget_ms: null,
          upstream_calls_made: 0,
          companies_candidates_found: 0,
          early_exit_triggered: false,
          last_heartbeat_at: null,
          lock_until: null,
          attempts: 0,
          last_error: errorOut,
          companies_count: 0,
          error: errorOut,
          items,
          saved: 0,
          saved_verified_count: 0,
          saved_company_ids_verified: [],
          saved_company_ids_unverified,
          saved_company_urls,
          save_outcome,
          resume_error,
          resume_error_details,
        resume_error_details,
          save_report: {
            saved: 0,
            saved_verified_count: 0,
            skipped:
              typeof completionDoc?.skipped === "number"
                ? completionDoc.skipped
                : typeof sessionDoc?.skipped === "number"
                  ? sessionDoc.skipped
                  : 0,
            failed:
              typeof completionDoc?.failed === "number"
                ? completionDoc.failed
                : typeof sessionDoc?.failed === "number"
                  ? sessionDoc.failed
                  : 0,
            skipped_ids,
            failed_items,
          },
          reconciled,
          reconcile_strategy,
          reconciled_saved_ids,
          saved_companies,
          resume_needed: false,
          resume: {
            needed: false,
            doc_created: false,
            triggered: false,
            trigger_error: null,
            missing_by_company: [],
          },
        resume_worker: (typeof sessionDoc !== "undefined" && sessionDoc)
          ? {
              last_invoked_at: sessionDoc?.resume_worker_last_invoked_at || null,
              handler_entered_at: sessionDoc?.resume_worker_handler_entered_at || null,
              handler_entered_build_id: sessionDoc?.resume_worker_handler_entered_build_id || null,
              last_reject_layer: sessionDoc?.resume_worker_last_reject_layer || null,
              last_auth: sessionDoc?.resume_worker_last_auth || null,
              last_finished_at: sessionDoc?.resume_worker_last_finished_at || null,
              last_result: sessionDoc?.resume_worker_last_result || null,
              last_ok: typeof sessionDoc?.resume_worker_last_ok === "boolean" ? sessionDoc.resume_worker_last_ok : null,
              last_http_status:
                typeof sessionDoc?.resume_worker_last_http_status === "number" ? sessionDoc.resume_worker_last_http_status : null,
              last_trigger_request_id: sessionDoc?.resume_worker_last_trigger_request_id || null,
              last_gateway_key_attached:
                typeof sessionDoc?.resume_worker_last_gateway_key_attached === "boolean"
                  ? sessionDoc.resume_worker_last_gateway_key_attached
                  : null,
              last_error: sessionDoc?.resume_worker_last_error || null,
              last_company_id: sessionDoc?.resume_worker_last_company_id || null,
              last_written_fields: Array.isArray(sessionDoc?.resume_worker_last_written_fields)
                ? sessionDoc.resume_worker_last_written_fields
                : null,
              last_stage_beacon: sessionDoc?.resume_worker_last_stage_beacon || null,
              last_resume_needed:
                typeof sessionDoc?.resume_worker_last_resume_needed === "boolean"
                  ? sessionDoc.resume_worker_last_resume_needed
                  : null,
            }
          : null,
        enrichment_health_summary,
          lastCreatedAt,
          timedOut,
          stopped,
          report,
        },
        200,
        req
      );
    }

    if (effectiveCompleted) {
      return jsonWithSessionId(
        {
          ok: true,
          session_id: sessionId,
          status: "complete",
          state: "complete",
          job_state: null,
          stage_beacon,
          stage_beacon_values: stageBeaconValues,
          ...(cosmosTarget ? cosmosTarget : {}),
          primary_job_state: null,
          elapsed_ms: null,
          remaining_budget_ms: null,
          upstream_calls_made: 0,
          companies_candidates_found: 0,
          early_exit_triggered: false,
          last_heartbeat_at: null,
          lock_until: null,
          attempts: 0,
          last_error: null,
          companies_count: saved,
          result: {
            saved,
            skipped: typeof completionDoc?.skipped === "number" ? completionDoc.skipped : null,
            failed: typeof completionDoc?.failed === "number" ? completionDoc.failed : null,
            completed_at: completionDoc?.completed_at || completionDoc?.created_at || null,
            reason: completionReason || null,
            saved_ids: savedIds,
            skipped_ids: Array.isArray(completionDoc?.skipped_ids) ? completionDoc.skipped_ids : [],
            failed_items: Array.isArray(completionDoc?.failed_items) ? completionDoc.failed_items : [],
          },
          items,
          saved,
          saved_verified_count,
          saved_company_ids_verified,
          saved_company_ids_unverified,
          saved_company_urls,
          save_outcome,
          resume_error,
          resume_error_details,
        resume_error_details,
        enrichment_last_write_error: (typeof sessionDoc !== "undefined" && sessionDoc)
          ? sessionDoc?.enrichment_last_write_error || null
          : null,
        reconciled,
          reconcile_strategy,
          reconciled_saved_ids,
          saved_companies,
          resume_needed,
          resume: {
          needed: resume_needed,
          status: resume_status || null,
            doc_created: Boolean(report?.resume) || resume_doc_created,
            triggered: resume_triggered,
            trigger_error: resume_trigger_error,
          trigger_error_details: resume_trigger_error_details,
          gateway_key_attached: Boolean(resume_gateway_key_attached),
          trigger_request_id: resume_trigger_request_id || null,
          internal_auth_configured: Boolean(internalAuthConfigured),
          ...buildResumeAuthDiagnostics(),
          missing_by_company,
        },
        resume_worker: (typeof sessionDoc !== "undefined" && sessionDoc)
          ? {
              last_invoked_at: sessionDoc?.resume_worker_last_invoked_at || null,
              handler_entered_at: sessionDoc?.resume_worker_handler_entered_at || null,
              handler_entered_build_id: sessionDoc?.resume_worker_handler_entered_build_id || null,
              last_reject_layer: sessionDoc?.resume_worker_last_reject_layer || null,
              last_auth: sessionDoc?.resume_worker_last_auth || null,
              last_finished_at: sessionDoc?.resume_worker_last_finished_at || null,
              last_result: sessionDoc?.resume_worker_last_result || null,
              last_ok: typeof sessionDoc?.resume_worker_last_ok === "boolean" ? sessionDoc.resume_worker_last_ok : null,
              last_http_status:
                typeof sessionDoc?.resume_worker_last_http_status === "number" ? sessionDoc.resume_worker_last_http_status : null,
              last_trigger_request_id: sessionDoc?.resume_worker_last_trigger_request_id || null,
              last_gateway_key_attached:
                typeof sessionDoc?.resume_worker_last_gateway_key_attached === "boolean"
                  ? sessionDoc.resume_worker_last_gateway_key_attached
                  : null,
              last_error: sessionDoc?.resume_worker_last_error || null,
              last_company_id: sessionDoc?.resume_worker_last_company_id || null,
              last_written_fields: Array.isArray(sessionDoc?.resume_worker_last_written_fields)
                ? sessionDoc.resume_worker_last_written_fields
                : null,
              last_stage_beacon: sessionDoc?.resume_worker_last_stage_beacon || null,
              last_resume_needed:
                typeof sessionDoc?.resume_worker_last_resume_needed === "boolean"
                  ? sessionDoc.resume_worker_last_resume_needed
                  : null,
            }
          : null,
        enrichment_health_summary,
          lastCreatedAt,
          report,
        },
        200,
        req
      );
    }

    return jsonWithSessionId(
      {
        ok: true,
        session_id: sessionId,
        status: "running",
        state: "running",
        job_state: null,
        stage_beacon: resume_needed ? "enrichment_resume_pending" : stage_beacon,
        stage_beacon_values: stageBeaconValues,
        ...(cosmosTarget ? cosmosTarget : {}),
        primary_job_state: null,
        elapsed_ms: null,
        remaining_budget_ms: null,
        upstream_calls_made: 0,
        companies_candidates_found: 0,
        early_exit_triggered: false,
        last_heartbeat_at: null,
        lock_until: null,
        attempts: 0,
        last_error: null,
        companies_count: saved,
        items,
        saved,
        saved_verified_count,
        saved_company_ids_verified,
        saved_company_ids_unverified,
        saved_company_urls,
        save_outcome,
        resume_error,
        resume_error_details,
        enrichment_last_write_error: (typeof sessionDoc !== "undefined" && sessionDoc)
          ? sessionDoc?.enrichment_last_write_error || null
          : null,
        reconciled,
        reconcile_strategy,
        reconciled_saved_ids,
        saved_companies,
        resume_needed,
        resume: {
          needed: resume_needed,
          status: resume_status || null,
          doc_created: Boolean(report?.resume) || resume_doc_created,
          triggered: resume_triggered,
          trigger_error: resume_trigger_error,
          trigger_error_details: resume_trigger_error_details,
          gateway_key_attached: Boolean(resume_gateway_key_attached),
          trigger_request_id: resume_trigger_request_id || null,
          internal_auth_configured: Boolean(internalAuthConfigured),
          ...buildResumeAuthDiagnostics(),
          missing_by_company,
        },
        resume_worker: (typeof sessionDoc !== "undefined" && sessionDoc)
          ? {
              last_invoked_at: sessionDoc?.resume_worker_last_invoked_at || null,
              handler_entered_at: sessionDoc?.resume_worker_handler_entered_at || null,
              handler_entered_build_id: sessionDoc?.resume_worker_handler_entered_build_id || null,
              last_reject_layer: sessionDoc?.resume_worker_last_reject_layer || null,
              last_auth: sessionDoc?.resume_worker_last_auth || null,
              last_finished_at: sessionDoc?.resume_worker_last_finished_at || null,
              last_result: sessionDoc?.resume_worker_last_result || null,
              last_ok: typeof sessionDoc?.resume_worker_last_ok === "boolean" ? sessionDoc.resume_worker_last_ok : null,
              last_http_status:
                typeof sessionDoc?.resume_worker_last_http_status === "number" ? sessionDoc.resume_worker_last_http_status : null,
              last_trigger_request_id: sessionDoc?.resume_worker_last_trigger_request_id || null,
              last_gateway_key_attached:
                typeof sessionDoc?.resume_worker_last_gateway_key_attached === "boolean"
                  ? sessionDoc.resume_worker_last_gateway_key_attached
                  : null,
              last_error: sessionDoc?.resume_worker_last_error || null,
              last_company_id: sessionDoc?.resume_worker_last_company_id || null,
              last_written_fields: Array.isArray(sessionDoc?.resume_worker_last_written_fields)
                ? sessionDoc.resume_worker_last_written_fields
                : null,
              last_stage_beacon: sessionDoc?.resume_worker_last_stage_beacon || null,
              last_resume_needed:
                typeof sessionDoc?.resume_worker_last_resume_needed === "boolean"
                  ? sessionDoc.resume_worker_last_resume_needed
                  : null,
            }
          : null,
        enrichment_health_summary,
        lastCreatedAt,
        report,
      },
      200,
      req
    );
  } catch (e) {
    const msg = e?.message || String(e);
    try {
      console.error(`[import-status] session=${sessionId} error: ${msg}`);
    } catch {}
    return jsonWithSessionId(
      {
        ok: false,
        session_id: sessionId,
        error: "Status handler failure",
        code: "STATUS_HANDLER_FAILURE",
        detail: msg,
      },
      200
    );
  }
}

function deprecatedHandler(req) {
  const method = String(req?.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: cors(req) };

  const url = new URL(req.url);
  const canonicalPath = "/api/import/status";
  const location = `${canonicalPath}${url.search || ""}`;

  return json(
    {
      ok: false,
      deprecated: true,
      deprecated_route: "/api/import-status",
      canonical_route: canonicalPath,
      redirect_to: location,
      message: "Deprecated. Use GET /api/import/status",
    },
    308,
    req,
    {
      Location: location,
      "Cache-Control": "no-store",
    }
  );
}

app.http("import-status", {
  route: "import/status",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler,
});

app.http("import-status-alt", {
  route: "import-status",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: deprecatedHandler,
});

module.exports = { _test: { handler } };
