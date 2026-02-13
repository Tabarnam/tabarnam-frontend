/**
 * Pure utility functions extracted from import-status/index.js.
 * No Cosmos DB, no external I/O — only deterministic logic.
 */

const {
  computeEnrichmentHealth: computeEnrichmentHealthContract,
  deriveMissingReason,
  isTerminalMissingField,
} = require("../_requiredFields");

// ── Constants ──────────────────────────────────────────────────────────────────

const RESUME_WATCHDOG_STALE_MS = Number.isFinite(Number(process.env.RESUME_WATCHDOG_STALE_MS))
  ? Math.max(5_000, Math.trunc(Number(process.env.RESUME_WATCHDOG_STALE_MS)))
  : 2 * 60_000;

const MAX_RESUME_CYCLES_SINGLE = Number.isFinite(Number(process.env.MAX_RESUME_CYCLES_SINGLE))
  ? Math.max(1, Math.trunc(Number(process.env.MAX_RESUME_CYCLES_SINGLE)))
  : 10;

const MAX_RESUME_CYCLES_SINGLE_TIMEOUT_ONLY = 15;

const INFRA_RETRYABLE_MISSING_REASONS = new Set([
  "upstream_unreachable",
  "upstream_timeout",
  "missing_xai_config",
]);

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
    last_trigger_result: null,
    last_trigger_ok: null,
    last_trigger_http_status: null,
    last_gateway_key_attached: null,
    last_error: null,
    last_company_id: null,
    last_written_fields: null,
    last_stage_beacon: null,
    last_resume_needed: null,
  },
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function toMs(ts) {
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(t) ? t : null;
}

function normalizeKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
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
  const createdAfter = computeCreatedAfterIso(sessionCreatedAt, 10);

  return { normalizedDomain, createdAfter, sessionCreatedAt };
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.trunc(n);
}

function normalizeErrorPayload(value) {
  if (!value) return null;
  if (typeof value === "string") return { message: value };
  if (typeof value === "object") return value;
  return { message: String(value) };
}

// ── Resume status logic ────────────────────────────────────────────────────────

function computeEffectiveResumeStatus({ resumeDoc, sessionDoc, stopDoc }) {
  if (stopDoc) {
    return { effective_resume_status: "stopped", progress_notice: null };
  }

  const statusRaw = String(resumeDoc?.status || "").trim().toLowerCase();
  if (statusRaw === "terminal" || statusRaw === "exhausted") {
    return { effective_resume_status: "terminal", progress_notice: null };
  }

  if (statusRaw === "complete") {
    return { effective_resume_status: "complete", progress_notice: null };
  }

  if (statusRaw === "done") {
    return { effective_resume_status: "complete", progress_notice: null };
  }

  const lockUntil = Date.parse(String(resumeDoc?.lock_expires_at || "")) || 0;
  if (lockUntil && Date.now() < lockUntil) {
    return { effective_resume_status: "running", progress_notice: null };
  }

  const lastActivityIso =
    String(
      sessionDoc?.resume_worker_last_finished_at ||
        sessionDoc?.resume_worker_handler_entered_at ||
        resumeDoc?.last_finished_at ||
        resumeDoc?.handler_entered_at ||
        resumeDoc?.last_invoked_at ||
        ""
    ).trim();

  const lastActivityMs = Date.parse(lastActivityIso) || 0;
  const stale = Boolean(lastActivityMs) && Date.now() - lastActivityMs > RESUME_WATCHDOG_STALE_MS;

  const resumeError =
    sessionDoc?.resume_error ||
    sessionDoc?.resume_worker_last_error ||
    resumeDoc?.resume_error ||
    resumeDoc?.last_error ||
    null;

  if (stale && resumeError) {
    return {
      effective_resume_status: "stalled",
      progress_notice: "Enrichment stalled. Manual intervention required.",
    };
  }

  if (statusRaw === "running") return { effective_resume_status: "running", progress_notice: null };
  if (statusRaw === "queued") return { effective_resume_status: "queued", progress_notice: null };

  if (stale) {
    return {
      effective_resume_status: "stalled",
      progress_notice: "Enrichment stalled. Manual intervention required.",
    };
  }

  return { effective_resume_status: statusRaw || "queued", progress_notice: null };
}

// ── Single-company mode detection ──────────────────────────────────────────────

function isSingleCompanyModeFromSession({ sessionDoc, savedCount, itemsCount }) {
  if (sessionDoc?.single_company_mode === true) return true;
  if (sessionDoc?.request_kind === "import-one") return true;

  const limit = Number(sessionDoc?.request?.limit ?? sessionDoc?.request?.Limit ?? 0);
  if (Number.isFinite(limit) && limit === 1) return true;

  const companiesCount = Number(savedCount || 0) || 0;
  if (companiesCount === 1) return true;

  const itemCount = Number(itemsCount || 0) || 0;
  if (itemCount === 1) return true;

  return false;
}

function isSingleCompanyModeFromSessionWithReason({ sessionDoc, savedCount, itemsCount }) {
  const single_company_mode_raw = sessionDoc?.single_company_mode;
  const request_kind_raw = sessionDoc?.request_kind;
  const request_limit_raw = sessionDoc?.request?.limit ?? sessionDoc?.request?.Limit;

  const inputs = {
    single_company_mode_raw,
    single_company_mode_type: typeof single_company_mode_raw,
    request_kind_raw,
    request_kind_type: typeof request_kind_raw,
    request_limit_raw,
    request_limit_type: typeof request_limit_raw,
    savedCount,
    itemsCount,
  };

  if (sessionDoc?.single_company_mode === true) {
    return { decision: true, reason: "flag_true", inputs };
  }

  if (sessionDoc?.request_kind === "import-one") {
    return { decision: true, reason: "request_kind_import_one", inputs };
  }

  const limit = Number(request_limit_raw ?? 0);
  if (Number.isFinite(limit) && limit === 1) {
    return { decision: true, reason: "limit_one", inputs };
  }

  const companiesCount = Number(savedCount || 0) || 0;
  if (companiesCount === 1) {
    return { decision: true, reason: "saved_count_one", inputs };
  }

  const itemCount = Number(itemsCount || 0) || 0;
  if (itemCount === 1) {
    return { decision: true, reason: "items_count_one", inputs };
  }

  return { decision: false, reason: "fallback_false", inputs };
}

// ── Worker progress & force-terminalize logic ──────────────────────────────────

function hasRecentWorkerProgress(resumeWorker, nowMs, windowMs) {
  const finished = toMs(resumeWorker?.last_finished_at);
  const entered = toMs(resumeWorker?.handler_entered_at);
  const newest = Math.max(finished || 0, entered || 0);
  if (!newest) return false;
  return nowMs - newest < windowMs;
}

function isInfraRetryableMissingReason(reason) {
  const r = normalizeKey(reason);
  if (!r) return false;
  if (INFRA_RETRYABLE_MISSING_REASONS.has(r)) return true;
  if (r.startsWith("upstream_http_")) return true;
  return false;
}

function collectInfraRetryableMissing(docs) {
  const list = Array.isArray(docs) ? docs : [];
  const out = [];

  for (const doc of list) {
    const missing = Array.isArray(computeEnrichmentHealthContract(doc)?.missing_fields)
      ? computeEnrichmentHealthContract(doc).missing_fields
      : [];

    for (const field of missing) {
      const reason = deriveMissingReason(doc, field) || normalizeKey(doc?.import_missing_reason?.[field] || "");
      if (!isInfraRetryableMissingReason(reason)) continue;
      out.push({
        company_id: String(doc?.id || doc?.company_id || "").trim() || null,
        field,
        missing_reason: reason,
      });
    }
  }

  return out;
}

function shouldForceTerminalizeSingle({
  single,
  resume_needed,
  resume_status,
  resume_cycle_count,
  resume_worker,
  resume_stuck_ms,
  infra_only_timeout,
  retryable_missing_count,
  actively_processing,
}) {
  if (!single) return { force: false, reason: null };
  if (!resume_needed) return { force: false, reason: null };
  if (actively_processing) return { force: false, reason: null };

  const cycles = Number(resume_cycle_count || 0) || 0;
  const maxCycles = infra_only_timeout
    ? Math.max(MAX_RESUME_CYCLES_SINGLE, MAX_RESUME_CYCLES_SINGLE_TIMEOUT_ONLY)
    : MAX_RESUME_CYCLES_SINGLE;

  const retryableMissing = Number(retryable_missing_count || 0) || 0;

  if (retryableMissing > 0 && cycles < maxCycles) return { force: false, reason: null };

  if (cycles >= maxCycles) return { force: true, reason: "max_cycles" };

  const status = String(resume_status || "").trim();
  if (status !== "queued") return { force: false, reason: null };

  const stuckMs = Number(resume_stuck_ms || 0) || 0;
  if (!stuckMs) return { force: false, reason: null };

  const nowMs = Date.now();
  const noRecentProgress = !hasRecentWorkerProgress(resume_worker, nowMs, stuckMs);
  if (noRecentProgress) return { force: true, reason: "queued_timeout_no_progress" };

  return { force: false, reason: null };
}

// ── Company document transforms ────────────────────────────────────────────────

function forceTerminalizeCompanyDocForSingle(doc) {
  const d = doc && typeof doc === "object" ? { ...doc } : {};

  d.import_missing_reason ||= {};
  d.import_attempts ||= {};

  d.industries = [];
  d.industries_unknown = true;
  d.import_missing_reason.industries = "exhausted";

  d.tagline = "";
  d.tagline_unknown = true;
  d.import_missing_reason.tagline = "exhausted";

  d.product_keywords = "";
  d.product_keywords_unknown = true;
  if (!Array.isArray(d.keywords)) d.keywords = [];
  d.import_missing_reason.product_keywords = d.import_missing_reason.product_keywords || "exhausted";

  d.reviews_stage_status = "incomplete";
  d.review_cursor = d.review_cursor && typeof d.review_cursor === "object" ? d.review_cursor : {};
  if (!Array.isArray(d.review_cursor.attempted_urls)) d.review_cursor.attempted_urls = [];
  d.review_cursor.exhausted = true;
  d.review_cursor.reviews_stage_status = "incomplete";
  d.review_cursor.incomplete_reason = d.review_cursor.incomplete_reason || "exhausted";
  d.review_cursor.exhausted_at = d.review_cursor.exhausted_at || nowIso();
  d.import_missing_reason.reviews = "exhausted";

  if (!d.logo_url) {
    d.logo_stage_status = d.logo_stage_status || "missing";
    d.import_missing_reason.logo = "exhausted";
  }

  try {
    const recomputed = computeEnrichmentHealthContract(d);
    if (recomputed && Array.isArray(recomputed.missing_fields)) d.import_missing_fields = recomputed.missing_fields;
  } catch {}

  d.updated_at = nowIso();
  return d;
}

function finalizeReviewsForCompletion(doc, { reason } = {}) {
  if (!doc || typeof doc !== "object") return false;

  const curated = Array.isArray(doc?.curated_reviews)
    ? doc.curated_reviews.filter((r) => r && typeof r === "object")
    : [];

  const stageRaw = String(doc?.reviews_stage_status || doc?.review_cursor?.reviews_stage_status || "").trim();
  const stage = normalizeKey(stageRaw);

  const okWithFour = stage === "ok" && curated.length >= 4;
  if (okWithFour) return false;

  const needsFinalize = !stage || stage === "pending" || stage === "exhausted" || stage === "ok";
  if (!needsFinalize && stage !== "incomplete") return false;

  let changed = false;

  doc.review_cursor = doc.review_cursor && typeof doc.review_cursor === "object" ? doc.review_cursor : {};

  if (!Array.isArray(doc.review_cursor.attempted_urls)) {
    doc.review_cursor.attempted_urls = [];
    changed = true;
  }

  const nextReason = String(reason || "").trim() || "exhausted";

  if (normalizeKey(doc.review_cursor.incomplete_reason || "") !== normalizeKey(nextReason)) {
    if (!doc.review_cursor.incomplete_reason) {
      doc.review_cursor.incomplete_reason = nextReason;
      changed = true;
    }
  }

  if (doc.review_cursor.exhausted !== true) {
    doc.review_cursor.exhausted = true;
    changed = true;
  }

  if (!doc.review_cursor.exhausted_at) {
    doc.review_cursor.exhausted_at = nowIso();
    changed = true;
  }

  if (normalizeKey(doc.review_cursor.reviews_stage_status) !== "incomplete") {
    doc.review_cursor.reviews_stage_status = "incomplete";
    changed = true;
  }

  if (normalizeKey(doc.reviews_stage_status) !== "incomplete") {
    doc.reviews_stage_status = "incomplete";
    changed = true;
  }

  doc.import_missing_reason ||= {};
  if (normalizeKey(doc.import_missing_reason.reviews) !== "exhausted") {
    doc.import_missing_reason.reviews = "exhausted";
    changed = true;
  }

  return changed;
}

function reconcileLowQualityToTerminal(doc, maxAttempts = 2) {
  if (!doc || typeof doc !== "object") return false;

  doc.import_attempts ||= {};
  doc.import_missing_reason ||= {};

  let changed = false;

  try {
    const industriesList = Array.isArray(doc.industries) ? doc.industries : [];
    if (industriesList.length === 1 && normalizeKey(industriesList[0]) === "unknown") {
      doc.industries = [];
      doc.industries_unknown = true;
      if (!doc.import_missing_reason.industries) doc.import_missing_reason.industries = "not_found";
      changed = true;
    }

    if (normalizeKey(doc.tagline) === "unknown") {
      doc.tagline = "";
      doc.tagline_unknown = true;
      if (!doc.import_missing_reason.tagline) doc.import_missing_reason.tagline = "not_found";
      changed = true;
    }

    if (normalizeKey(doc.product_keywords) === "unknown") {
      doc.product_keywords = "";
      if (!Array.isArray(doc.keywords)) doc.keywords = [];
      doc.product_keywords_unknown = true;
      if (!doc.import_missing_reason.product_keywords) doc.import_missing_reason.product_keywords = "not_found";
      changed = true;
    }
  } catch {}

  const fields = ["industries", "tagline", "product_keywords"];
  for (const f of fields) {
    const reason = String(doc.import_missing_reason[f] || "").trim().toLowerCase();
    const attempts = Number(doc.import_attempts[f] || 0);

    if (reason === "low_quality" && attempts >= maxAttempts) {
      doc.import_missing_reason[f] = "low_quality_terminal";

      if (f === "industries") {
        doc.industries = [];
        doc.industries_unknown = true;
      }

      if (f === "tagline") {
        doc.tagline = "";
        doc.tagline_unknown = true;
      }

      if (f === "product_keywords") {
        doc.product_keywords = "";
        if (!Array.isArray(doc.keywords)) doc.keywords = [];
        doc.product_keywords_unknown = true;
      }

      changed = true;
    }
  }

  return changed;
}

/**
 * Derives the resume-specific stage beacon value from resume state.
 *
 * @param {object} opts
 * @param {string}  opts.resume_status
 * @param {boolean} opts.forceComplete
 * @param {boolean} opts.resume_needed
 * @param {number}  opts.retryableMissingCount
 * @returns {string|null}
 */
function deriveResumeStageBeacon({ resume_status, forceComplete, resume_needed, retryableMissingCount }) {
  const s = String(resume_status || "").trim();
  if (!forceComplete && !resume_needed) return null;
  if (s === "blocked") return "enrichment_resume_blocked";
  if (s === "queued") return "enrichment_resume_queued";
  if (s === "running") return "enrichment_resume_running";
  if (s === "stalled") return "enrichment_resume_stalled";
  if (s === "error") return "enrichment_resume_error";
  if (retryableMissingCount > 0) return "enrichment_incomplete_retryable";
  return "complete";
}

/**
 * Reconcile low-quality company docs to terminal state and stamp beacons.
 *
 * @param {Array}  docs              - Company docs to evaluate
 * @param {object} stageBeaconValues - Mutable beacon map
 * @returns {number} Count of docs reconciled
 */
function reconcileLowQualityDocs(docs, stageBeaconValues) {
  const lowQualityMaxAttempts = Number.isFinite(Number(process.env.NON_GROK_LOW_QUALITY_MAX_ATTEMPTS))
    ? Math.max(1, Math.trunc(Number(process.env.NON_GROK_LOW_QUALITY_MAX_ATTEMPTS)))
    : 2;

  let count = 0;
  for (const doc of Array.isArray(docs) ? docs : []) {
    if (reconcileLowQualityToTerminal(doc, lowQualityMaxAttempts)) {
      count += 1;
    }
  }

  if (count > 0) {
    stageBeaconValues.status_reconciled_low_quality_terminal = nowIso();
    stageBeaconValues.status_reconciled_low_quality_terminal_count = count;
  }

  return count;
}

function applyTerminalOnlyCompletion(out, reason) {
  const stamp = new Date().toISOString();

  out.ok = true;
  out.completed = true;
  out.terminal_only = true;

  if ("error" in out) out.error = null;
  if ("last_error" in out) out.last_error = null;
  if ("root_cause" in out) out.root_cause = null;

  out.status = "complete";
  out.state = "complete";
  if (typeof out.job_state === "string") out.job_state = "complete";
  if (typeof out.primary_job_state === "string") out.primary_job_state = "complete";

  out.stage_beacon = "status_resume_terminal_only";

  out.resume_needed = false;

  out.resume = out.resume && typeof out.resume === "object" ? out.resume : {};
  out.resume.needed = false;
  out.resume.status = "complete";
  out.resume.triggered = false;
  out.resume.trigger_error = null;
  out.resume.trigger_error_details = null;

  if (out.report && typeof out.report === "object") {
    if (out.report.session && typeof out.report.session === "object") {
      out.report.session.resume_needed = false;
    }
    if (out.report.resume && typeof out.report.resume === "object") {
      out.report.resume.status = "complete";
    }
  }

  if (out.resume_worker && typeof out.resume_worker === "object") {
    if (typeof out.resume_worker.last_resume_needed === "boolean") out.resume_worker.last_resume_needed = false;
  }

  out.resume_error = null;
  out.resume_error_details = null;

  out.progress_error = null;
  out.progress_notice =
    "Completed (terminal-only): remaining missing fields are terminal (Not disclosed / exhausted / not found).";

  out.stage_beacon_values = out.stage_beacon_values || {};
  out.stage_beacon_values.status_resume_terminal_only = stamp;
  out.stage_beacon_values.status_resume_forced_terminalize_reason = reason;

  return out;
}

// ── Enrichment health analysis ─────────────────────────────────────────────────

function computeEnrichmentHealth(company) {
  return computeEnrichmentHealthContract(company);
}

function computeContractEnrichmentHealth(company) {
  return computeEnrichmentHealthContract(company);
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

function summarizeEnrichmentHealth(saved_companies) {
  const list = Array.isArray(saved_companies) ? saved_companies : [];
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
        // Actual field values for admin import display
        keywords: Array.isArray(doc?.keywords) ? doc.keywords : [],
        product_keywords: doc?.product_keywords ?? "",
        industries: Array.isArray(doc?.industries) ? doc.industries : [],
        tagline: typeof doc?.tagline === "string" ? doc.tagline : "",
        headquarters_location: doc?.headquarters_location ?? "",
        manufacturing_locations: Array.isArray(doc?.manufacturing_locations) ? doc.manufacturing_locations : [],
        logo_url: typeof doc?.logo_url === "string" ? doc.logo_url.trim() : "",
        curated_reviews: Array.isArray(doc?.curated_reviews) ? doc.curated_reviews : [],
        review_count: typeof doc?.review_count === "number" ? doc.review_count : 0,
        reviews_stage_status: typeof doc?.reviews_stage_status === "string" ? doc.reviews_stage_status : null,
        review_cursor: doc?.review_cursor && typeof doc.review_cursor === "object" ? doc.review_cursor : null,
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

// ── Primary job progress ───────────────────────────────────────────────────────

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

module.exports = {
  // Constants
  RESUME_WATCHDOG_STALE_MS,
  MAX_RESUME_CYCLES_SINGLE,
  MAX_RESUME_CYCLES_SINGLE_TIMEOUT_ONLY,
  INFRA_RETRYABLE_MISSING_REASONS,
  EMPTY_RESUME_DIAGNOSTICS,

  // Helpers
  nowIso,
  toMs,
  normalizeKey,
  normalizeDomain,
  extractNormalizedDomainFromQuery,
  computeCreatedAfterIso,
  deriveDomainAndCreatedAfter,
  toPositiveInt,
  normalizeErrorPayload,

  // Resume status
  computeEffectiveResumeStatus,

  // Single-company mode
  isSingleCompanyModeFromSession,
  isSingleCompanyModeFromSessionWithReason,

  // Worker progress & terminalize
  hasRecentWorkerProgress,
  isInfraRetryableMissingReason,
  collectInfraRetryableMissing,
  shouldForceTerminalizeSingle,

  // Resume stage beacon
  deriveResumeStageBeacon,

  // Low-quality reconciliation
  reconcileLowQualityDocs,

  // Document transforms
  forceTerminalizeCompanyDocForSingle,
  finalizeReviewsForCompletion,
  reconcileLowQualityToTerminal,
  applyTerminalOnlyCompletion,

  // Enrichment health
  computeEnrichmentHealth,
  computeContractEnrichmentHealth,
  analyzeMissingFieldsForResume,
  summarizeEnrichmentHealth,
  toSavedCompanies,
  inferReconcileStrategy,

  // Primary job progress
  getHeartbeatTimestamp,
  getJobCreatedTimestamp,
  computePrimaryProgress,
};
