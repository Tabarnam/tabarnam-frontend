let CosmosClient;
try {
  ({ CosmosClient } = require("@azure/cosmos"));
} catch {
  CosmosClient = null;
}

const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
} = require("../../_cosmosPartitionKey");

const {
  buildInternalFetchRequest,
  getInternalAuthDecision,
} = require("../../_internalJobAuth");

const { getBuildInfo } = require("../../_buildInfo");
const { getXAIEndpoint, getXAIKey, resolveXaiEndpointForModel } = require("../../_shared");
const {
  computeMissingFields,
  deriveMissingReason,
  isTerminalMissingReason,
  isTerminalMissingField,
  isRealValue,
} = require("../../_requiredFields");

const {
  fetchCuratedReviews,
  fetchHeadquartersLocation,
  fetchManufacturingLocations,
  fetchTagline,
  fetchIndustries,
  fetchProductKeywords,
} = require("../../_grokEnrichment");

const { enqueueResumeRun } = require("../../_enrichmentQueue");

const HANDLER_ID = "import-resume-worker";

const BUILD_INFO = (() => {
  try {
    return getBuildInfo();
  } catch {
    return { build_id: "" };
  }
})();

function cors(req) {
  const origin = req?.headers?.get?.("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers":
      "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id,x-tabarnam-internal,x-internal-secret,x-internal-job-secret,x-job-kind",
  };
}

function json(obj, status = 200, req) {
  const siteName = String(process.env.WEBSITE_SITE_NAME || "unknown_site");
  const buildId =
    String(
      process.env.BUILD_ID ||
        process.env.VERCEL_GIT_COMMIT_SHA ||
        process.env.GITHUB_SHA ||
        BUILD_INFO.build_id ||
        "unknown_build"
    ) || "unknown_build";

  const payload = obj && typeof obj === "object" && !Array.isArray(obj)
    ? {
        ...obj,
        handler_id: HANDLER_ID,
        handler_version: siteName,
        site_name: siteName,
        site_hostname: String(process.env.WEBSITE_HOSTNAME || BUILD_INFO?.runtime?.website_hostname || ""),
        build_id: obj.build_id || buildId,
        build_id_source: obj.build_id_source || BUILD_INFO.build_id_source || null,
      }
    : obj;

  return {
    status,
    headers: {
      ...cors(req),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Api-Handler": HANDLER_ID,
      "X-Api-Build-Id": String(BUILD_INFO.build_id || ""),
    },
    body: JSON.stringify(payload),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function looksLikeUuid(value) {
  const s = String(value || "").trim();
  if (!s) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function normalizeKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isTimeoutLikeMessage(message) {
  const m = String(message ?? "").toLowerCase();
  if (!m) return false;
  return /\b(canceled|cancelled|timeout|timed out|abort|aborted)\b/i.test(m);
}

function safeJsonStringify(value, limit = 2000) {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string") return "";
    return text.length > limit ? text.slice(0, limit) : text;
  } catch {
    try {
      const text = String(value ?? "");
      return text.length > limit ? text.slice(0, limit) : text;
    } catch {
      return "";
    }
  }
}

function safeErrorMessage(err, limit = 500) {
  try {
    if (!err) return "";
    if (typeof err === "string") return err.length > limit ? err.slice(0, limit) : err;

    const msg = err?.message ?? err?.error;
    if (typeof msg === "string" && msg.trim()) return msg.length > limit ? msg.slice(0, limit) : msg;
    if (msg && typeof msg === "object") {
      const text = safeJsonStringify(msg, limit);
      return text || "[unserializable_error_message]";
    }

    if (err instanceof Error && typeof err.message === "string") {
      return err.message.length > limit ? err.message.slice(0, limit) : err.message;
    }

    const text = safeJsonStringify(err, limit);
    return text || "[unserializable_error]";
  } catch {
    return "";
  }
}

const GROK_ONLY_FIELDS = new Set([
  "headquarters_location",
  "manufacturing_locations",
  "reviews",
  "industries",
  "product_keywords",
]);

const GROK_RETRYABLE_STATUSES = new Set([
  "deferred",
  "upstream_unreachable",
  "upstream_timeout",
  "not_found",
  "not_disclosed_pending",
  "not_disclosed_candidate",
]);

function envInt(name, fallback, { min = 1, max = 25 } = {}) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(Math.trunc(raw), max));
}

const MAX_ATTEMPTS_REVIEWS = envInt("MAX_ATTEMPTS_REVIEWS", 3, { min: 1, max: 10 });
const MAX_ATTEMPTS_LOCATION = envInt("MAX_ATTEMPTS_LOCATION", 3, { min: 1, max: 10 });
const MAX_ATTEMPTS_INDUSTRIES = envInt("MAX_ATTEMPTS_INDUSTRIES", 3, { min: 1, max: 10 });
const MAX_ATTEMPTS_TAGLINE = envInt("MAX_ATTEMPTS_TAGLINE", 3, { min: 1, max: 10 });
const MAX_ATTEMPTS_KEYWORDS = envInt("MAX_ATTEMPTS_KEYWORDS", 3, { min: 1, max: 10 });
const MAX_ATTEMPTS_LOGO = envInt("MAX_ATTEMPTS_LOGO", 3, { min: 1, max: 10 });

const NON_GROK_LOW_QUALITY_MAX_ATTEMPTS = envInt("NON_GROK_LOW_QUALITY_MAX_ATTEMPTS", 2, { min: 1, max: 10 });

const MAX_RESUME_CYCLES = envInt("MAX_RESUME_CYCLES", 10, { min: 1, max: 50 });

function classifyLocationSource({ source_url, normalized_domain }) {
  const urlRaw = String(source_url || "").trim();
  const domain = String(normalized_domain || "").trim().toLowerCase();

  const out = {
    source_type: "other",
    source_method: "xai_live_search",
  };

  if (!urlRaw) return out;

  let host = "";
  try {
    const u = new URL(urlRaw);
    host = String(u.hostname || "").toLowerCase();
  } catch {
    host = "";
  }

  if (!host) return out;

  if (domain && domain !== "unknown" && (host === domain || host.endsWith(`.${domain}`))) {
    out.source_type = "official_site";
    return out;
  }

  if (
    host.includes("zoominfo.com") ||
    host.includes("crunchbase.com") ||
    host.includes("dnb.com") ||
    host.includes("linkedin.com")
  ) {
    out.source_type = "b2b_directory";
    return out;
  }

  if (
    host.includes("instagram.com") ||
    host.includes("facebook.com") ||
    host.includes("tiktok.com") ||
    host.includes("pinterest.com") ||
    host.includes("youtube.com") ||
    host === "x.com" ||
    host.includes("twitter.com")
  ) {
    out.source_type = "social";
    return out;
  }

  if (host.includes("amazon.") || host.includes("etsy.com") || host.includes("ebay.com") || host.includes("walmart.com")) {
    out.source_type = "marketplace";
    return out;
  }

  if (host.endsWith(".gov") || host.includes(".gov.")) {
    out.source_type = "government";
    return out;
  }

  if (host.includes("news") || host.includes("press") || host.includes("magazine") || host.includes("journal")) {
    out.source_type = "news";
    return out;
  }

  return out;
}

const DISALLOWED_LOCATION_PROVENANCE_HOSTS = new Set([
  "fiverr.com",
  "www.fiverr.com",
  "upwork.com",
  "www.upwork.com",
]);

function isDisallowedLocationSourceUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return false;
  try {
    const host = String(new URL(raw).hostname || "").toLowerCase();
    return DISALLOWED_LOCATION_PROVENANCE_HOSTS.has(host);
  } catch {
    return false;
  }
}

function mergeLocationSource(doc, { location_type, location, source_url, extracted_field, normalized_domain } = {}) {
  if (!doc || typeof doc !== "object") return false;

  const locType = String(location_type || "").trim();
  const loc = String(location || "").trim();
  const src = String(source_url || "").trim();
  if (!locType || !loc || !src) return false;

  if (isDisallowedLocationSourceUrl(src)) return false;

  doc.location_sources = Array.isArray(doc.location_sources) ? doc.location_sources : [];

  const prov = classifyLocationSource({ source_url: src, normalized_domain });

  const existing = doc.location_sources.find((x) => {
    if (!x || typeof x !== "object") return false;
    return String(x.location_type || "").trim() === locType && String(x.location || "").trim() === loc;
  });

  if (existing) {
    const urls = Array.isArray(existing.source_urls)
      ? existing.source_urls.map((u) => String(u || "").trim()).filter(Boolean)
      : String(existing.source_url || "").trim()
        ? [String(existing.source_url).trim()]
        : [];

    if (!urls.includes(src)) urls.push(src);

    existing.source_urls = urls;
    if (!String(existing.source_url || "").trim()) existing.source_url = urls[0] || src;

    if (!String(existing.source_method || "").trim()) existing.source_method = prov.source_method;
    if (!String(existing.source_type || "").trim() || existing.source_type === "other") existing.source_type = prov.source_type;

    if (!String(existing.extracted_field || "").trim() && extracted_field) existing.extracted_field = extracted_field;
    existing.extracted_at = nowIso();

    return true;
  }

  doc.location_sources.push({
    location_type: locType,
    location: loc,
    source_url: src,
    source_urls: [src],
    source_type: prov.source_type,
    source_method: prov.source_method,
    extracted_field: extracted_field || null,
    extracted_at: nowIso(),
  });

  return true;
}

function ensureAttemptsDetail(doc, field) {
  doc.import_attempts_detail ||= {};
  const existing = doc.import_attempts_detail[field];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) return existing;
  const created = { last_attempt_at: null, last_success_at: null, last_error: null, last_request_id: null };
  doc.import_attempts_detail[field] = created;
  return created;
}

function bumpFieldAttempt(doc, field, requestId) {
  doc.import_attempts ||= {};
  doc.import_attempts_meta ||= {};

  const last = doc.import_attempts_meta[field];
  if (last === requestId) {
    const meta = ensureAttemptsDetail(doc, field);
    if (!meta.last_attempt_at) meta.last_attempt_at = nowIso();
    if (!meta.last_request_id) meta.last_request_id = requestId || null;
    return false;
  }

  doc.import_attempts[field] = Number(doc.import_attempts[field] || 0) + 1;
  doc.import_attempts_meta[field] = requestId;

  const meta = ensureAttemptsDetail(doc, field);
  meta.last_attempt_at = nowIso();
  meta.last_request_id = requestId || null;

  return true;
}

function markFieldSuccess(doc, field) {
  const meta = ensureAttemptsDetail(doc, field);
  meta.last_success_at = nowIso();
  meta.last_error = null;
}

function markFieldError(doc, field, error) {
  const meta = ensureAttemptsDetail(doc, field);
  const message = safeErrorMessage(error) || "error";

  if (error && typeof error === "object" && !Array.isArray(error)) {
    meta.last_error = {
      ...error,
      message,
    };
    return;
  }

  meta.last_error = { message };
}

function ensureImportWarnings(doc) {
  if (!Array.isArray(doc.import_warnings)) doc.import_warnings = [];
  return doc.import_warnings;
}

function addImportWarning(doc, entry) {
  const list = ensureImportWarnings(doc);
  const field = String(entry?.field || "").trim();
  if (!field) return;
  const idx = list.findIndex((w) => w && typeof w === "object" && String(w.field || "").trim() === field);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
}

function attemptsFor(doc, field) {
  return Number(doc?.import_attempts?.[field] || 0);
}

function markEnrichmentIncomplete(doc, { reason, field } = {}) {
  if (!doc || typeof doc !== "object") return;

  const existingReason = String(doc.red_flag_reason || "").trim();
  const nextReason = `Enrichment incomplete: ${String(reason || "unknown").trim()}`;

  doc.red_flag = true;

  // Prefer a clear non-terminal reason when upstream is unreachable.
  if (!existingReason || /enrichment complete/i.test(existingReason) || /enrichment pending/i.test(existingReason)) {
    doc.red_flag_reason = field ? `${nextReason} (${field})` : nextReason;
  }
}

function terminalizeGrokField(doc, field, terminalReason) {
  doc.import_missing_reason ||= {};

  const reason = String(terminalReason || "exhausted").trim().toLowerCase();

  if (field === "headquarters_location") {
    // Only write the visible sentinel when we have exhausted attempts (or Grok repeatedly indicates not disclosed).
    if (reason === "not_disclosed") {
      doc.headquarters_location = "Not disclosed";
      doc.hq_unknown = true;
      doc.hq_unknown_reason = "not_disclosed";
      doc.import_missing_reason.headquarters_location = "not_disclosed";
      return;
    }

    // Exhausted due to repeated upstream failures or other terminalization.
    doc.hq_unknown = true;
    doc.hq_unknown_reason = "exhausted";
    doc.import_missing_reason.headquarters_location = "exhausted";
    if (typeof doc.headquarters_location !== "string") doc.headquarters_location = "";
    return;
  }

  if (field === "manufacturing_locations") {
    if (reason === "not_disclosed") {
      doc.manufacturing_locations = ["Not disclosed"];
      doc.mfg_unknown = true;
      doc.mfg_unknown_reason = "not_disclosed";
      doc.import_missing_reason.manufacturing_locations = "not_disclosed";
      return;
    }

    doc.mfg_unknown = true;
    doc.mfg_unknown_reason = "exhausted";
    doc.import_missing_reason.manufacturing_locations = "exhausted";
    if (!Array.isArray(doc.manufacturing_locations)) doc.manufacturing_locations = [];
    return;
  }

  if (field === "reviews") {
    if (!Array.isArray(doc.curated_reviews)) doc.curated_reviews = [];
    doc.review_count = typeof doc.review_count === "number" ? doc.review_count : doc.curated_reviews.length;

    const cursor =
      doc.review_cursor && typeof doc.review_cursor === "object" ? { ...doc.review_cursor } : {};

    const attemptedUrls = Array.isArray(cursor.attempted_urls) ? cursor.attempted_urls : [];
    const lastErrCode = normalizeKey(cursor?.last_error?.code || "");

    const incompleteReason =
      normalizeKey(cursor.incomplete_reason || "") ||
      (lastErrCode === "upstream_timeout" || lastErrCode === "upstream_unreachable" ? lastErrCode : "") ||
      "exhausted";

    // Required invariant: terminal completion must never leave reviews_stage_status="pending".
    // We keep the user-facing stage as "incomplete" and rely on cursor.exhausted for terminality.
    doc.reviews_stage_status = "incomplete";

    doc.review_cursor = {
      ...cursor,
      exhausted: true,
      reviews_stage_status: "incomplete",
      incomplete_reason: incompleteReason,
      attempted_urls: attemptedUrls,
      exhausted_at: nowIso(),
    };

    doc.import_missing_reason.reviews = "exhausted";
  }
}

function assertNoWebsiteFallback(field) {
  if (GROK_ONLY_FIELDS.has(field)) return true;
  return false;
}

function reconcileGrokTerminalState(doc) {
  if (!doc || typeof doc !== "object") return false;

  let changed = false;
  doc.import_missing_reason ||= {};

  // Placeholder hygiene: never persist "Unknown" as a canonical value for retryable fields.
  // It should stay missing (empty) and be represented via *_unknown flags + import_missing_reason.
  const industriesList = Array.isArray(doc.industries) ? doc.industries : [];
  if (
    industriesList.length === 1 &&
    normalizeKey(industriesList[0]) === "unknown" &&
    !isTerminalMissingField(doc, "industries")
  ) {
    doc.industries = [];
    doc.industries_unknown = true;
    if (!doc.import_missing_reason.industries) {
      doc.import_missing_reason.industries = normalizeKey(deriveMissingReason(doc, "industries")) || "not_found";
    }
    changed = true;
  }

  const productKeywordsRaw = typeof doc.product_keywords === "string" ? doc.product_keywords : "";
  if (normalizeKey(productKeywordsRaw) === "unknown" && !isTerminalMissingField(doc, "product_keywords")) {
    doc.product_keywords = "";
    if (!Array.isArray(doc.keywords)) doc.keywords = [];
    doc.product_keywords_unknown = true;
    if (!doc.import_missing_reason.product_keywords) {
      doc.import_missing_reason.product_keywords =
        normalizeKey(deriveMissingReason(doc, "product_keywords")) || "not_found";
    }
    changed = true;
  }

  const hqVal = normalizeKey(doc.headquarters_location);
  if (hqVal === "not disclosed" || hqVal === "not_disclosed") {
    const hqReason = normalizeKey(doc.import_missing_reason.headquarters_location || doc.hq_unknown_reason || "");
    const attempts = attemptsFor(doc, "headquarters_location");
    const confirmedTerminal = hqReason === "not_disclosed" || attempts >= MAX_ATTEMPTS_LOCATION;

    // If a placeholder sentinel was written too early, treat it as retryable and clear the visible value.
    if (!confirmedTerminal) {
      if (typeof doc.headquarters_location === "string" && doc.headquarters_location.trim()) {
        doc.headquarters_location = "";
        changed = true;
      }

      if (doc.hq_unknown !== true) {
        doc.hq_unknown = true;
        changed = true;
      }

      if (normalizeKey(doc.hq_unknown_reason) !== "pending_grok") {
        doc.hq_unknown_reason = "pending_grok";
        changed = true;
      }

      const stored = normalizeKey(doc.import_missing_reason.headquarters_location || "");
      if (!stored || stored === "not_disclosed") {
        doc.import_missing_reason.headquarters_location = "not_disclosed_pending";
        changed = true;
      }
    } else {
      if (doc.hq_unknown !== true) {
        doc.hq_unknown = true;
        changed = true;
      }
      if (normalizeKey(doc.hq_unknown_reason) !== "not_disclosed") {
        doc.hq_unknown_reason = "not_disclosed";
        changed = true;
      }
      if (normalizeKey(doc.import_missing_reason.headquarters_location) !== "not_disclosed") {
        doc.import_missing_reason.headquarters_location = "not_disclosed";
        changed = true;
      }
    }
  }

  const rawMfgList = Array.isArray(doc.manufacturing_locations)
    ? doc.manufacturing_locations
    : doc.manufacturing_locations == null
      ? []
      : [doc.manufacturing_locations];

  const normalizedMfg = rawMfgList
    .map((loc) => {
      if (typeof loc === "string") return normalizeKey(loc);
      if (loc && typeof loc === "object") {
        return normalizeKey(loc.formatted || loc.full_address || loc.address || loc.location);
      }
      return "";
    })
    .filter(Boolean);

  if (normalizedMfg.length > 0 && normalizedMfg.every((v) => v === "not disclosed" || v === "not_disclosed")) {
    const mfgReason = normalizeKey(doc.import_missing_reason.manufacturing_locations || doc.mfg_unknown_reason || "");
    const attempts = attemptsFor(doc, "manufacturing_locations");
    const confirmedTerminal = mfgReason === "not_disclosed" || attempts >= MAX_ATTEMPTS_LOCATION;

    if (!confirmedTerminal) {
      // Clear premature sentinel so the UI doesn't show "Not disclosed" until we've exhausted Grok attempts.
      if (Array.isArray(doc.manufacturing_locations) && doc.manufacturing_locations.length > 0) {
        doc.manufacturing_locations = [];
        changed = true;
      }

      if (doc.mfg_unknown !== true) {
        doc.mfg_unknown = true;
        changed = true;
      }

      if (normalizeKey(doc.mfg_unknown_reason) !== "pending_grok") {
        doc.mfg_unknown_reason = "pending_grok";
        changed = true;
      }

      const stored = normalizeKey(doc.import_missing_reason.manufacturing_locations || "");
      if (!stored || stored === "not_disclosed") {
        doc.import_missing_reason.manufacturing_locations = "not_disclosed_pending";
        changed = true;
      }
    } else {
      const existingList = Array.isArray(doc.manufacturing_locations) ? doc.manufacturing_locations : [];
      if (!(existingList.length === 1 && normalizeKey(existingList[0]) === "not disclosed")) {
        doc.manufacturing_locations = ["Not disclosed"];
        changed = true;
      }

      if (doc.mfg_unknown !== true) {
        doc.mfg_unknown = true;
        changed = true;
      }
      if (normalizeKey(doc.mfg_unknown_reason) !== "not_disclosed") {
        doc.mfg_unknown_reason = "not_disclosed";
        changed = true;
      }
      if (normalizeKey(doc.import_missing_reason.manufacturing_locations) !== "not_disclosed") {
        doc.import_missing_reason.manufacturing_locations = "not_disclosed";
        changed = true;
      }
    }
  }

  const reviewsStage = normalizeKey(doc.reviews_stage_status || doc.review_cursor?.reviews_stage_status);
  const cursorExhausted = Boolean(doc.review_cursor && typeof doc.review_cursor === "object" && doc.review_cursor.exhausted === true);

  if (reviewsStage === "exhausted" || cursorExhausted) {
    // Terminal completion marker for reviews is cursor.exhausted.
    // We keep the *user-facing* stage as "incomplete" (never "pending"/"exhausted").
    const cursor = doc.review_cursor && typeof doc.review_cursor === "object" ? { ...doc.review_cursor } : {};

    if (cursor.exhausted !== true) {
      cursor.exhausted = true;
      changed = true;
    }

    const nextStage = "incomplete";

    if (!doc.reviews_stage_status || normalizeKey(doc.reviews_stage_status) === "pending" || normalizeKey(doc.reviews_stage_status) === "exhausted") {
      doc.reviews_stage_status = nextStage;
      changed = true;
    }

    if (!cursor.reviews_stage_status || normalizeKey(cursor.reviews_stage_status) === "pending" || normalizeKey(cursor.reviews_stage_status) === "exhausted") {
      cursor.reviews_stage_status = nextStage;
      changed = true;
    }

    if (!cursor.exhausted_at) {
      cursor.exhausted_at = nowIso();
      changed = true;
    }

    cursor.attempted_urls = Array.isArray(cursor.attempted_urls) ? cursor.attempted_urls : [];
    cursor.incomplete_reason = normalizeKey(cursor.incomplete_reason || "") || "exhausted";

    doc.review_cursor = cursor;

    if (normalizeKey(doc.import_missing_reason.reviews) !== "exhausted") {
      doc.import_missing_reason.reviews = "exhausted";
      changed = true;
    }
  }

  return changed;
}

function computeRetryableMissingFields(doc) {
  const baseMissing = computeMissingFields(doc);
  return (Array.isArray(baseMissing) ? baseMissing : []).filter((f) => !isTerminalMissingField(doc, f));
}

function terminalizeNonGrokField(doc, field, reason) {
  doc.import_missing_reason ||= {};

  const f = normalizeKey(field);

  // Robustness rule: never write placeholder strings like "Unknown" into canonical fields.
  // Keep canonical fields empty/unset and encode missingness via *_unknown flags + import_missing_reason.
  if (f === "industries") {
    doc.industries = [];
    doc.industries_unknown = true;
    doc.import_missing_reason.industries = reason;
    return;
  }

  if (f === "tagline") {
    doc.tagline = "";
    doc.tagline_unknown = true;
    doc.import_missing_reason.tagline = reason;
    return;
  }

  if (f === "product_keywords") {
    doc.product_keywords = "";
    if (!Array.isArray(doc.keywords)) doc.keywords = [];
    doc.product_keywords_unknown = true;
    doc.import_missing_reason.product_keywords = reason;
    return;
  }

  if (f === "logo") {
    if (!String(doc.logo_stage_status || "").trim()) doc.logo_stage_status = "missing";
    doc.import_missing_reason.logo = reason;
    return;
  }
}

function forceTerminalizeNonGrokFields(doc) {
  const missing = Array.isArray(doc?.import_missing_fields) ? doc.import_missing_fields : computeMissingFields(doc);

  for (const field of missing) {
    const f = normalizeKey(field);
    if (f === "industries") terminalizeNonGrokField(doc, "industries", "exhausted");
    if (f === "tagline") terminalizeNonGrokField(doc, "tagline", "exhausted");
    if (f === "product_keywords") terminalizeNonGrokField(doc, "product_keywords", "exhausted");
    if (f === "logo") terminalizeNonGrokField(doc, "logo", "exhausted");
    if (f === "reviews") terminalizeGrokField(doc, "reviews");
  }
}

async function bestEffortPatchSessionDoc({ container, sessionId, patch }) {
  if (!container || !sessionId || !patch) return { ok: false, error: "missing_inputs" };

  const sessionDocId = `_import_session_${sessionId}`;
  const existing = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);

  const base = existing && typeof existing === "object"
    ? existing
    : {
        id: sessionDocId,
        session_id: sessionId,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_session",
        created_at: nowIso(),
      };

  const next = {
    ...base,
    ...(patch && typeof patch === "object" ? patch : {}),
    updated_at: nowIso(),
  };

  await upsertDoc(container, next).catch(() => null);
  return { ok: true };
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

  for (const partitionKeyValue of candidates) {
    try {
      const item =
        partitionKeyValue !== undefined
          ? container.item(id, partitionKeyValue)
          : container.item(id);
      const { resource } = await item.read();
      return resource || null;
    } catch (e) {
      if (e?.code === 404) return null;
    }
  }

  return null;
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

async function readStopControl(container, sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return null;
  const id = `_import_stop_${sid}`;
  return await readControlDoc(container, id, sid).catch(() => null);
}

async function isSessionStopped(container, sessionId) {
  const doc = await readStopControl(container, sessionId);
  if (!doc) return false;
  // Accept both legacy stop docs (type=import_stop) and the newer control-shaped docs (stopped=true).
  if (doc.stopped === true) return true;
  if (String(doc.type || "").trim() === "import_stop") return true;
  return true;
}

async function fetchSeedCompanies(container, sessionId, limit = 25) {
  if (!container) return [];
  const n = Math.max(1, Math.min(Number(limit) || 10, 50));

  const q = {
    query: `
      SELECT TOP ${n}
        c.id, c.company_name, c.name, c.url, c.website_url, c.normalized_domain,
        c.industries, c.product_keywords, c.keywords,
        c.headquarters_location, c.manufacturing_locations,
        c.curated_reviews, c.review_count, c.review_cursor,
        c.red_flag, c.red_flag_reason,
        c.hq_unknown, c.hq_unknown_reason,
        c.mfg_unknown, c.mfg_unknown_reason,
        c.source, c.source_stage, c.seed_ready,
        c.primary_candidate, c.seed,
        c.import_missing_fields, c.import_missing_reason, c.import_warnings
      FROM c
      WHERE (c.session_id = @sid OR c.import_session_id = @sid)
        AND NOT STARTSWITH(c.id, '_import_')
        AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)
      ORDER BY c.created_at DESC
    `,
    parameters: [{ name: "@sid", value: sessionId }],
  };

  const { resources } = await container.items
    .query(q, { enableCrossPartitionQuery: true })
    .fetchAll();

  return Array.isArray(resources) ? resources : [];
}

async function fetchCompaniesByIds(container, ids) {
  if (!container) return [];
  const list = Array.isArray(ids) ? ids.map((v) => String(v || "").trim()).filter(Boolean) : [];
  if (list.length === 0) return [];

  const unique = Array.from(new Set(list)).slice(0, 25);
  const params = unique.map((id, idx) => ({ name: `@id${idx}`, value: id }));
  const inClause = unique.map((_, idx) => `@id${idx}`).join(", ");

  const q = {
    query: `SELECT * FROM c WHERE c.id IN (${inClause})`,
    parameters: params,
  };

  const { resources } = await container.items.query(q, { enableCrossPartitionQuery: true }).fetchAll();
  return Array.isArray(resources) ? resources : [];
}

async function resumeWorkerHandler(req, context) {
  const method = String(req?.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: cors(req) };
  if (method !== "POST") {
    return json(
      {
        ok: false,
        session_id: null,
        handler_entered_at: nowIso(),
        did_work: false,
        did_work_reason: "method_not_allowed",
        error: "Method not allowed",
      },
      405,
      req
    );
  }

  const url = new URL(req.url);
  const noCosmosMode = String(url.searchParams.get("no_cosmos") || "").trim() === "1";
  const cosmosEnabled = !noCosmosMode;

  const parseBoundedInt = (value, fallback, { min = 1, max = 50 } = {}) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(Math.trunc(n), max));
  };

  let body = {};
  try {
    if (typeof req?.json === "function") {
      body = (await req.json().catch(() => ({}))) || {};
    } else {
      const txt = await req.text();
      if (txt) body = JSON.parse(txt);
    }
  } catch {}

  const handler_entered_at = nowIso();

  const sessionId = String(body?.session_id || body?.sessionId || url.searchParams.get("session_id") || "").trim();

  const batchLimit = parseBoundedInt(
    body?.batch_limit ?? body?.batchLimit ?? url.searchParams.get("batch_limit") ?? url.searchParams.get("batchLimit"),
    25,
    { min: 1, max: 50 }
  );

  // Default deadline increased to 15 minutes (900000ms) to allow thorough XAI enrichment.
  // xAI web searches must never timeout - each field can take 1-5 minutes for accurate results.
  // With 6 fields per company, we need at least 6-30 minutes total budget.
  const deadlineMs = parseBoundedInt(
    body?.deadline_ms ?? body?.deadlineMs ?? url.searchParams.get("deadline_ms") ?? url.searchParams.get("deadlineMs"),
    900000,
    { min: 1000, max: 1800000 }
  );

  const forceTerminalizeSingle =
    String(
      body?.force_terminalize_single ||
        body?.forceTerminalizeSingle ||
        url.searchParams.get("force_terminalize_single") ||
        url.searchParams.get("forceTerminalizeSingle") ||
        ""
    ).trim() === "1";

  let did_work = false;
  let did_work_reason = null;

  if (!sessionId) {
    return json(
      {
        ok: false,
        session_id: null,
        handler_entered_at,
        did_work,
        did_work_reason: "missing_session_id",
        error: "Missing session_id",
      },
      200,
      req
    );
  }

  // Deterministic diagnosis marker: if this never updates, the request never reached the handler
  // (e.g. rejected at gateway/host key layer).
  try {
    console.log(`[${HANDLER_ID}] handler_entered`, {
      session_id: sessionId,
      entered_at: handler_entered_at,
      build_id: String(BUILD_INFO.build_id || ""),
    });
  } catch {}

  let cosmosContainer = null;
  if (cosmosEnabled) {
    try {
      const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
      const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
      const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
      const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

      if (endpoint && key && CosmosClient) {
        const client = new CosmosClient({ endpoint, key });
        cosmosContainer = client.database(databaseId).container(containerId);

        await bestEffortPatchSessionDoc({
          container: cosmosContainer,
          sessionId,
          patch: {
            resume_worker_handler_entered_at: handler_entered_at,
            resume_worker_handler_entered_build_id: String(BUILD_INFO.build_id || ""),
          },
        });
      }
    } catch {}
  }

  const inProcessTrusted = Boolean(req && req.__in_process === true);
  const authDecision = inProcessTrusted
    ? {
        auth_ok: true,
        auth_method_used: "in-process",
        secret_source: "in-process",
        internal_flag_present: true,
      }
    : getInternalAuthDecision(req);

  if (!authDecision.auth_ok) {
    if (cosmosContainer) {
      await bestEffortPatchSessionDoc({
        container: cosmosContainer,
        sessionId,
        patch: {
          resume_worker_last_http_status: 401,
          resume_worker_last_reject_layer: "handler",
          resume_worker_last_auth: authDecision,
          resume_worker_last_finished_at: handler_entered_at,
          resume_worker_last_error: "unauthorized",
        },
      }).catch(() => null);
    }

    return json(
      {
        ok: false,
        session_id: sessionId,
        handler_entered_at,
        did_work,
        did_work_reason: "unauthorized",
        error: "Unauthorized",
        auth: authDecision,
      },
      401,
      req
    );
  }

  if (!cosmosEnabled) {
    return json(
      {
        ok: false,
        session_id: sessionId,
        handler_entered_at,
        did_work,
        did_work_reason: "no_cosmos",
        root_cause: "no_cosmos",
        retryable: false,
      },
      200,
      req
    );
  }

  const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
  const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
  const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
  const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

  if (!CosmosClient || !endpoint || !key) {
    return json(
      {
        ok: false,
        session_id: sessionId,
        handler_entered_at,
        did_work,
        did_work_reason: "cosmos_not_configured",
        root_cause: "cosmos_not_configured",
        retryable: false,
        details: {
          has_cosmos_module: Boolean(CosmosClient),
          has_endpoint: Boolean(endpoint),
          has_key: Boolean(key),
        },
      },
      200,
      req
    );
  }

  const client = new CosmosClient({ endpoint, key });
  const container = client.database(databaseId).container(containerId);

  const gracefulExit = async (reason) => {
    const updatedAt = nowIso();
    try {
      await bestEffortPatchSessionDoc({
        container,
        sessionId,
        patch: {
          resume_worker_last_finished_at: updatedAt,
          resume_worker_last_result: reason,
          updated_at: updatedAt,
        },
      }).catch(() => null);
    } catch {}

    return json(
      {
        ok: true,
        result: reason,
        session_id: sessionId,
        handler_entered_at,
        did_work: false,
        did_work_reason: reason,
        resume_needed: reason === "stopped" ? false : true,
        stopped: reason === "stopped",
      },
      200,
      req
    );
  };


  const resumeDocId = `_import_resume_${sessionId}`;
  const sessionDocId = `_import_session_${sessionId}`;
  const completionDocId = `_import_complete_${sessionId}`;

  let [resumeDoc, sessionDoc, completionDoc] = await Promise.all([
    readControlDoc(container, resumeDocId, sessionId).catch(() => null),
    readControlDoc(container, sessionDocId, sessionId).catch(() => null),
    readControlDoc(container, completionDocId, sessionId).catch(() => null),
  ]);

  // Required: resume worker must always upsert a resume control doc every run.
  if (!resumeDoc) {
    const now = nowIso();
    const savedIds = Array.isArray(sessionDoc?.saved_company_ids)
      ? sessionDoc.saved_company_ids
      : Array.isArray(sessionDoc?.saved_ids)
        ? sessionDoc.saved_ids
        : Array.isArray(sessionDoc?.saved_company_ids_verified)
          ? sessionDoc.saved_company_ids_verified
          : Array.isArray(sessionDoc?.saved_company_ids_unverified)
            ? sessionDoc.saved_company_ids_unverified
            : Array.isArray(completionDoc?.saved_company_ids_verified)
              ? completionDoc.saved_company_ids_verified
              : Array.isArray(completionDoc?.saved_ids)
                ? completionDoc.saved_ids
                : [];

    const created = {
      id: resumeDocId,
      session_id: sessionId,
      normalized_domain: "import",
      partition_key: "import",
      type: "import_control",
      created_at: now,
      updated_at: now,
      status: "queued",
      doc_created: false,
      saved_company_ids: savedIds.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 50),
      missing_by_company: [],
    };

    const upsertResult = await upsertDoc(container, created).catch(() => ({ ok: false }));
    const doc_created = Boolean(upsertResult && upsertResult.ok);

    resumeDoc = { ...created, doc_created };

    if (doc_created) {
      // Refresh from Cosmos so we always operate on the authoritative doc.
      resumeDoc = (await readControlDoc(container, resumeDocId, sessionId).catch(() => null)) || resumeDoc;
    }
  }

  // Stop doc is authoritative: if stopped, persist status and exit (no self-scheduling).
  if (await isSessionStopped(container, sessionId)) {
    const stoppedAt = nowIso();

    await upsertDoc(container, {
      ...(resumeDoc && typeof resumeDoc === "object" ? resumeDoc : {}),
      id: resumeDocId,
      session_id: sessionId,
      normalized_domain: "import",
      partition_key: "import",
      type: "import_control",
      status: "stopped",
      last_result: "stopped",
      last_error: null,
      next_allowed_run_at: null,
      lock_expires_at: null,
      last_finished_at: stoppedAt,
      updated_at: stoppedAt,
    }).catch(() => null);

    await bestEffortPatchSessionDoc({
      container,
      sessionId,
      patch: {
        resume_needed: false,
        resume_updated_at: stoppedAt,
        resume_worker_last_finished_at: stoppedAt,
        resume_worker_last_result: "stopped",
        updated_at: stoppedAt,
      },
    }).catch(() => null);

    return gracefulExit("stopped");
  }

  const nextAllowedMs = Date.parse(String(resumeDoc?.next_allowed_run_at || "")) || 0;
  if (nextAllowedMs && Date.now() < nextAllowedMs) {
    const delayMs = Math.max(0, nextAllowedMs - Date.now());
    const cycleCount = Number.isFinite(Number(resumeDoc?.cycle_count)) ? Number(resumeDoc.cycle_count) : 0;

    const enqueueRes = await enqueueResumeRun({
      session_id: sessionId,
      reason: "backoff_retry",
      requested_by: "resume_worker",
      enqueue_at: nowIso(),
      cycle_count: cycleCount,
      run_after_ms: delayMs,
    }).catch(() => ({ ok: false }));

    if (enqueueRes?.ok) {
      const queuedAt = nowIso();
      await upsertDoc(container, {
        ...(resumeDoc && typeof resumeDoc === "object" ? resumeDoc : {}),
        id: resumeDocId,
        session_id: sessionId,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        status: "queued",
        last_result: "backoff_wait",
        last_ok: true,
        last_error: null,
        lock_expires_at: null,
        updated_at: queuedAt,
      }).catch(() => null);

      await bestEffortPatchSessionDoc({
        container,
        sessionId,
        patch: {
          resume_worker_last_enqueued_at: queuedAt,
          resume_worker_last_enqueue_reason: "backoff_retry",
          resume_worker_last_enqueue_ok: true,
          resume_worker_last_enqueue_error: null,
          resume_updated_at: queuedAt,
          updated_at: queuedAt,
        },
      }).catch(() => null);

      return gracefulExit("backoff_wait");
    }

    const stalledAt = nowIso();
    const enqueueErr = String(enqueueRes?.error || "enqueue_failed");

    await upsertDoc(container, {
      ...(resumeDoc && typeof resumeDoc === "object" ? resumeDoc : {}),
      id: resumeDocId,
      session_id: sessionId,
      normalized_domain: "import",
      partition_key: "import",
      type: "import_control",
      status: "stalled",
      last_result: "backoff_enqueue_failed",
      last_ok: false,
      last_error: enqueueErr,
      resume_error: {
        code: "ENQUEUE_FAILED",
        message: enqueueErr,
        at: stalledAt,
      },
      lock_expires_at: null,
      updated_at: stalledAt,
    }).catch(() => null);

    await bestEffortPatchSessionDoc({
      container,
      sessionId,
      patch: {
        resume_worker_last_enqueued_at: stalledAt,
        resume_worker_last_enqueue_reason: "backoff_retry",
        resume_worker_last_enqueue_ok: false,
        resume_worker_last_enqueue_error: enqueueErr,
        resume_updated_at: stalledAt,
        updated_at: stalledAt,
      },
    }).catch(() => null);

    return gracefulExit("stalled");
  }

  // Queue idempotency: if a message is for a different cycle than the current resume doc,
  // treat it as stale/duplicate to avoid duplicate work storms.
  const msgCycleCount = Number.isFinite(Number(body?.cycle_count)) ? Number(body.cycle_count) : null;
  const docCycleCount = Number.isFinite(Number(resumeDoc?.cycle_count)) ? Number(resumeDoc.cycle_count) : null;
  if (msgCycleCount !== null && docCycleCount !== null && msgCycleCount !== docCycleCount) {
    return gracefulExit(msgCycleCount < docCycleCount ? "duplicate" : "future_message");
  }

  const lockUntil = Date.parse(String(resumeDoc?.lock_expires_at || "")) || 0;
  if (lockUntil && Date.now() < lockUntil) {
    // Heartbeat: the handler ran, but work is prevented by the resume lock.
    await upsertDoc(container, {
      ...(resumeDoc && typeof resumeDoc === "object" ? resumeDoc : {}),
      id: resumeDocId,
      session_id: sessionId,
      normalized_domain: "import",
      partition_key: "import",
      type: "import_control",
      last_invoked_at: handler_entered_at,
      handler_entered_at,
      last_finished_at: handler_entered_at,
      last_ok: true,
      last_result: "resume_locked",
      last_error: null,
      lock_expires_at: resumeDoc?.lock_expires_at || null,
      updated_at: handler_entered_at,
    }).catch(() => null);

    return json(
      {
        ok: true,
        result: "locked",
        session_id: sessionId,
        handler_entered_at,
        did_work,
        did_work_reason: "resume_locked",
        lock_expires_at: resumeDoc.lock_expires_at,
      },
      200,
      req
    );
  }

  did_work = true;

  const attempt = Number.isFinite(Number(resumeDoc?.attempt)) ? Number(resumeDoc.attempt) : 0;
  const thisLockExpiresAt = new Date(Date.now() + 60_000).toISOString();
  const invokedAt = nowIso();

  const resumeControlUpsert = await upsertDoc(container, {
    ...(resumeDoc && typeof resumeDoc === "object" ? resumeDoc : {}),
    id: resumeDocId,
    session_id: sessionId,
    normalized_domain: "import",
    partition_key: "import",
    type: "import_control",
    doc_created: true,
    status: "running",
    attempt: attempt + 1,
    enrichment_started_at: resumeDoc?.enrichment_started_at || invokedAt,
    last_invoked_at: invokedAt,
    handler_entered_at,
    lock_expires_at: thisLockExpiresAt,
    updated_at: nowIso(),
  }).catch(() => ({ ok: false }));

  const resume_control_doc_upsert_ok = Boolean(resumeControlUpsert && resumeControlUpsert.ok);
  if (resume_control_doc_upsert_ok && resumeDoc && typeof resumeDoc === "object") {
    resumeDoc.doc_created = true;
    resumeDoc.last_invoked_at = invokedAt;
    resumeDoc.attempt = attempt + 1;
  }

  // Retry accounting invariant:
  // - resume_cycle_count tracks actual resume-worker invocations (not /import/status trigger attempts).
  try {
    const cycleSessionDoc = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);
    if (cycleSessionDoc && typeof cycleSessionDoc === "object") {
      const nextCycleCount = (Number(cycleSessionDoc.resume_cycle_count || 0) || 0) + 1;
      const patched = {
        ...cycleSessionDoc,
        resume_cycle_count: nextCycleCount,
        resume_last_triggered_at: invokedAt,
        resume_worker_handler_entered_at: invokedAt,
        updated_at: nowIso(),
      };
      await upsertDoc(container, patched).catch(() => null);
      sessionDoc = patched;
    }
  } catch {}

  const requestId =
    String(req?.headers?.get?.("x-request-id") || req?.headers?.get?.("x-client-request-id") || "").trim() ||
    String(resumeDoc?.last_invoked_at || handler_entered_at);

  let upstreamCallsMade =
    typeof resumeDoc?.upstream_calls_made === "number" && Number.isFinite(resumeDoc.upstream_calls_made)
      ? Math.max(0, resumeDoc.upstream_calls_made)
      : 0;

  let upstreamCallsMadeThisRun = 0;

  const noteUpstreamCall = () => {
    upstreamCallsMade += 1;
    upstreamCallsMadeThisRun += 1;
  };

  const savedCompanyIds = Array.isArray(sessionDoc?.saved_company_ids)
    ? sessionDoc.saved_company_ids
    : Array.isArray(sessionDoc?.saved_ids)
      ? sessionDoc.saved_ids
      : Array.isArray(sessionDoc?.saved_company_ids_verified)
        ? sessionDoc.saved_company_ids_verified
        : Array.isArray(sessionDoc?.saved_company_ids_unverified)
          ? sessionDoc.saved_company_ids_unverified
          : Array.isArray(resumeDoc?.saved_company_ids)
            ? resumeDoc.saved_company_ids
            : Array.isArray(completionDoc?.saved_company_ids_verified)
              ? completionDoc.saved_company_ids_verified
              : Array.isArray(completionDoc?.saved_ids)
                ? completionDoc.saved_ids
                : [];

  const savedIds = Array.isArray(savedCompanyIds)
    ? savedCompanyIds.map((v) => String(v || "").trim()).filter(Boolean)
    : [];

  const requestLimit = Number(sessionDoc?.request?.limit ?? sessionDoc?.request?.Limit ?? 0);
  const singleCompanyMode = requestLimit === 1 || savedIds.length === 1;

  // In single-company mode, prefer the canonical saved IDs (usually 1 company) so we don't
  // split the deadline budget across lots of session docs and end up with tiny upstream timeouts.
  let seedDocs =
    singleCompanyMode && savedIds.length > 0
      ? await fetchCompaniesByIds(container, savedIds.slice(0, 5)).catch(() => [])
      : await fetchSeedCompanies(container, sessionId, batchLimit).catch(() => []);

  // If the session/company docs are missing the session_id markers (e.g. platform kill mid-flight),
  // fall back to canonical saved IDs persisted in the resume/session docs.
  if (seedDocs.length === 0) {
    const fallbackIds = Array.isArray(resumeDoc?.saved_company_ids) ? resumeDoc.saved_company_ids : [];
    if (fallbackIds.length > 0) {
      seedDocs = await fetchCompaniesByIds(container, fallbackIds).catch(() => []);
    }
  }

  // Idempotency: only attempt resume on company docs that still violate the required-fields contract.
  // Placeholders like "Unknown" do NOT count as present.
  if (seedDocs.length > 0) {
    const withMissing = seedDocs.filter((d) => computeRetryableMissingFields(d).length > 0);

    if (withMissing.length > 0) {
      seedDocs = withMissing;

      if (singleCompanyMode && seedDocs.length > 1) {
        const primary = seedDocs.find((d) => d?.primary_candidate) || seedDocs[0];
        seedDocs = primary ? [primary] : seedDocs.slice(0, 1);
      }
    } else {
      const updatedAt = nowIso();

      await upsertDoc(container, {
        ...resumeDoc,
        status: "complete",
        missing_by_company: [],
        last_trigger_result: {
          ok: true,
          status: 200,
          stage_beacon: "already_complete",
          resume_needed: false,
        },
        lock_expires_at: null,
        updated_at: updatedAt,
      }).catch(() => null);

      await bestEffortPatchSessionDoc({
        container,
        sessionId,
        patch: {
          resume_needed: false,
          resume_updated_at: updatedAt,
          updated_at: updatedAt,
        },
      }).catch(() => null);

      return json(
        {
          ok: true,
          session_id: sessionId,
          handler_entered_at,
          did_work: false,
          did_work_reason: "no_missing_required_fields",
          skipped: true,
          reason: "no_missing_required_fields",
          batch_limit: batchLimit,
          import_attempts_snapshot: seedDocs.slice(0, 5).map((d) => ({
            company_id: d?.id || null,
            normalized_domain: d?.normalized_domain || null,
            import_attempts: d?.import_attempts || {},
            import_missing_reason: d?.import_missing_reason || {},
            import_missing_fields: Array.isArray(d?.import_missing_fields) ? d.import_missing_fields : null,
          })),
        },
        200,
        req
      );
    }
  }

  // Forced terminalization path (status-driven) for single-company deterministic completion.
  if (forceTerminalizeSingle && seedDocs.length > 0) {
    const updatedAt = nowIso();

    for (const doc of seedDocs) {
      if (!doc || typeof doc !== "object") continue;

      const missingAll = computeMissingFields(doc);
      for (const field of Array.isArray(missingAll) ? missingAll : []) {
        const previousAttempts = attemptsFor(doc, field);
        bumpFieldAttempt(doc, field, requestId);
        if (field === "headquarters_location") terminalizeGrokField(doc, "headquarters_location", "exhausted");
        if (field === "manufacturing_locations") terminalizeGrokField(doc, "manufacturing_locations", "exhausted");

        if (field === "reviews") {
          doc.review_cursor = doc.review_cursor && typeof doc.review_cursor === "object" ? { ...doc.review_cursor } : {};
          if (!Array.isArray(doc.curated_reviews)) doc.curated_reviews = [];
          if (!Number.isFinite(Number(doc.review_count))) doc.review_count = doc.curated_reviews.length;

          const attemptedUrls = Array.isArray(doc.review_cursor.attempted_urls) ? doc.review_cursor.attempted_urls : [];
          const hadAttempts = previousAttempts > 0 || attemptedUrls.length > 0 || Boolean(doc.review_cursor.last_error);

          const reasonsObj = doc.import_missing_reason && typeof doc.import_missing_reason === "object" ? doc.import_missing_reason : {};
          const anyTimeout = Object.values(reasonsObj).some((v) => normalizeKey(v) === "upstream_timeout");

          const incompleteReasonRaw =
            normalizeKey(doc.review_cursor.incomplete_reason || "") ||
            normalizeKey(reasonsObj.reviews || "") ||
            (hadAttempts ? "attempted_but_incomplete" : "");

          const incomplete_reason = incompleteReasonRaw || (anyTimeout ? "upstream_timeout" : "terminalized_without_attempt");

          // Required invariant: terminal-only completion must never leave reviews_stage_status="pending".
          doc.reviews_stage_status = "incomplete";
          doc.review_cursor.reviews_stage_status = "incomplete";
          doc.review_cursor.incomplete_reason = incomplete_reason;
          doc.review_cursor.attempted_urls = attemptedUrls;

          // Mark terminal for required-fields logic while keeping user-facing stage as "incomplete".
          doc.review_cursor.exhausted = true;
          doc.review_cursor.exhausted_at = updatedAt;

          doc.import_missing_reason ||= {};
          doc.import_missing_reason.reviews = "exhausted";
        }
      }

      // Defensive: if required-fields computation failed to include reviews, still never leave them pending on forced completion.
      try {
        const stageRaw = normalizeKey(doc?.reviews_stage_status || doc?.review_cursor?.reviews_stage_status || "");
        const curatedCount = Array.isArray(doc?.curated_reviews) ? doc.curated_reviews.length : 0;
        const cursorExhausted = Boolean(doc?.review_cursor && typeof doc.review_cursor === "object" && doc.review_cursor.exhausted === true);
        const isOk = stageRaw === "ok" && curatedCount >= 4;

        if (!isOk && (stageRaw === "pending" || !cursorExhausted)) {
          const prevAttempts = attemptsFor(doc, "reviews");
          bumpFieldAttempt(doc, "reviews", requestId);

          doc.review_cursor = doc.review_cursor && typeof doc.review_cursor === "object" ? { ...doc.review_cursor } : {};
          if (!Array.isArray(doc.curated_reviews)) doc.curated_reviews = [];
          if (!Number.isFinite(Number(doc.review_count))) doc.review_count = doc.curated_reviews.length;

          const attemptedUrls = Array.isArray(doc.review_cursor.attempted_urls) ? doc.review_cursor.attempted_urls : [];
          const hadAttempts = prevAttempts > 0 || attemptedUrls.length > 0 || Boolean(doc.review_cursor.last_error);

          const reasonsObj = doc.import_missing_reason && typeof doc.import_missing_reason === "object" ? doc.import_missing_reason : {};
          const anyTimeout = Object.values(reasonsObj).some((v) => normalizeKey(v) === "upstream_timeout");

          const incompleteReasonRaw =
            normalizeKey(doc.review_cursor.incomplete_reason || "") ||
            normalizeKey(reasonsObj.reviews || "") ||
            (hadAttempts ? "attempted_but_incomplete" : "");

          const incomplete_reason = incompleteReasonRaw || (anyTimeout ? "upstream_timeout" : "terminalized_without_attempt");

          doc.reviews_stage_status = "incomplete";
          doc.review_cursor.reviews_stage_status = "incomplete";
          doc.review_cursor.incomplete_reason = incomplete_reason;
          doc.review_cursor.attempted_urls = attemptedUrls;
          doc.review_cursor.exhausted = true;
          doc.review_cursor.exhausted_at = updatedAt;

          doc.import_missing_reason ||= {};
          doc.import_missing_reason.reviews = "exhausted";
        }
      } catch {}

      forceTerminalizeNonGrokFields(doc);
      doc.import_missing_fields = computeMissingFields(doc);
      doc.updated_at = updatedAt;
      await upsertDoc(container, doc).catch(() => null);
    }

    await upsertDoc(container, {
      ...(resumeDoc && typeof resumeDoc === "object" ? resumeDoc : {}),
      id: resumeDocId,
      session_id: sessionId,
      normalized_domain: "import",
      partition_key: "import",
      type: "import_control",
      status: "complete",
      missing_by_company: [],
      last_trigger_result: {
        ok: true,
        status: 200,
        stage_beacon: "status_resume_terminal_only",
        resume_needed: false,
        forced_terminalize_single: true,
      },
      lock_expires_at: null,
      updated_at: updatedAt,
    }).catch(() => null);

    await bestEffortPatchSessionDoc({
      container,
      sessionId,
      patch: {
        resume_needed: false,
        status: "complete",
        stage_beacon: "status_resume_terminal_only",
        resume_terminal_only: true,
        resume_terminalized_at: updatedAt,
        resume_terminalized_reason: "forced_terminalize_single",
        updated_at: updatedAt,
      },
    }).catch(() => null);

    return json(
      {
        ok: true,
        session_id: sessionId,
        handler_entered_at,
        did_work: true,
        did_work_reason: "forced_terminalize_single",
        resume_needed: false,
        forced_terminalize_single: true,
        import_attempts_snapshot: seedDocs.slice(0, 5).map((d) => ({
          company_id: d?.id || null,
          normalized_domain: d?.normalized_domain || null,
          import_attempts: d?.import_attempts || {},
          import_missing_reason: d?.import_missing_reason || {},
          import_missing_fields: Array.isArray(d?.import_missing_fields) ? d.import_missing_fields : null,
        })),
      },
      200,
      req
    );
  }

  // Low-quality non-Grok fields (industries/product_keywords/tagline) must not be retryable forever.
  // Convert "low_quality" to terminal after a small number of attempts.
  if (seedDocs.length > 0) {
    const lowQualityFields = ["industries", "product_keywords", "tagline"];

    for (const doc of seedDocs) {
      if (!doc || typeof doc !== "object") continue;

      let changed = false;

      for (const field of lowQualityFields) {
        const storedReason = normalizeKey(doc?.import_missing_reason?.[field] || "");
        const derivedReason = normalizeKey(deriveMissingReason(doc, field));
        const reason = storedReason || derivedReason;
        if (reason !== "low_quality") continue;

        const bumped = bumpFieldAttempt(doc, field, requestId);
        if (bumped) changed = true;

        if (attemptsFor(doc, field) >= NON_GROK_LOW_QUALITY_MAX_ATTEMPTS) {
          terminalizeNonGrokField(doc, field, "low_quality_terminal");
          changed = true;
        } else {
          doc.import_missing_reason ||= {};
          // Keep the stored reason retryable until it converts to terminal.
          if (!doc.import_missing_reason[field]) doc.import_missing_reason[field] = "low_quality";
        }
      }

      if (changed) {
        doc.import_missing_fields = computeMissingFields(doc);
        doc.updated_at = nowIso();
        await upsertDoc(container, doc).catch(() => null);
      }
    }
  }

  // Mandatory ordered enrichment pass for required fields.
  // Resume-worker is authoritative; status must never orchestrate.
  {
    const ENRICH_FIELDS = [
      "tagline",
      "headquarters_location",
      "manufacturing_locations",
      "industries",
      "product_keywords",
      "reviews",
    ];

    // Minimum time budgets per field - realistic values based on actual xAI response times.
    // xAI API calls typically complete within 10-60 seconds.
    // These must be >= the values in _grokEnrichment.js XAI_STAGE_TIMEOUTS_MS.min + safety margin.
    const MIN_REQUIRED_MS_BY_FIELD = {
      tagline: 20_000,                  // 20 seconds min (light field)
      headquarters_location: 25_000,    // 25 seconds min (location field)
      manufacturing_locations: 25_000,  // 25 seconds min (location field)
      industries: 20_000,               // 20 seconds min (light field)
      product_keywords: 35_000,         // 35 seconds min (keywords field)
      reviews: 65_000,                  // 65 seconds min (reviews - multi-step)
    };

    const cycleCount = Number.isFinite(Number(resumeDoc?.cycle_count)) ? Number(resumeDoc.cycle_count) : 0;
    const isFreshSeed = cycleCount === 0;

    // With 5-minute deadline, we can attempt all fields in a single run
    const MAX_XAI_FIELDS_PER_RUN = 9999;
    let xaiFieldsAttemptedThisRun = 0;

    // Fresh seed invariant: no stage skipping.
    const skipStages = isFreshSeed ? [] : Array.isArray(resumeDoc?.skip_stages) ? resumeDoc.skip_stages : [];
    void skipStages;

    const nowAtStart = nowIso();
    const startedAtMs = Date.now();

    // Worker-written lifecycle timestamp (once).
    try {
      const existingStarted = String(sessionDoc?.enrichment_started_at || "").trim();
      if (!existingStarted) {
        await bestEffortPatchSessionDoc({
          container,
          sessionId,
          patch: {
            enrichment_started_at: nowAtStart,
            updated_at: nowAtStart,
          },
        }).catch(() => null);
        sessionDoc = { ...(sessionDoc && typeof sessionDoc === "object" ? sessionDoc : {}), enrichment_started_at: nowAtStart };
      }
    } catch {}

    const progressRoot = (resumeDoc && typeof resumeDoc === "object" ? resumeDoc : {});
    progressRoot.enrichment_progress =
      progressRoot.enrichment_progress && typeof progressRoot.enrichment_progress === "object" && !Array.isArray(progressRoot.enrichment_progress)
        ? progressRoot.enrichment_progress
        : {};

    const budgetRemainingMs = () => Math.max(0, deadlineMs - (Date.now() - startedAtMs));

    const plannedByCompany = Array.isArray(resumeDoc?.missing_by_company)
      ? resumeDoc.missing_by_company
      : (Array.isArray(resumeDoc?.saved_company_ids) ? resumeDoc.saved_company_ids : []).map((company_id) => ({
          company_id,
          missing_fields: [...ENRICH_FIELDS],
        }));

    const plannedIds = plannedByCompany
      .map((e) => String(e?.company_id || "").trim())
      .filter(Boolean)
      .slice(0, 50);

    const plannedDocs = plannedIds.length > 0 ? await fetchCompaniesByIds(container, plannedIds).catch(() => []) : [];
    const docsById = new Map(plannedDocs.map((d) => [String(d?.id || "").trim(), d]));

    const attemptedFieldsThisRun = [];
    const savedFieldsThisRun = [];

    let lastFieldAttemptedThisRun = null;
    let lastFieldResultThisRun = null;

    const updateLastXaiAttempt = async (nowIsoStr, meta = {}) => {
      try {
        await bestEffortPatchSessionDoc({
          container,
          sessionId,
          patch: {
            last_xai_attempt_at: nowIsoStr,
            resume_worker_last_xai_attempt_at: nowIsoStr,
            ...(meta && typeof meta === "object" ? meta : {}),
            updated_at: nowIsoStr,
          },
        }).catch(() => null);
      } catch {}

      try {
        resumeDoc.last_xai_attempt_at = nowIsoStr;
      } catch {}
    };

    for (const entry of plannedByCompany) {
      if (await isSessionStopped(container, sessionId)) return gracefulExit("stopped");

      const companyId = String(entry?.company_id || "").trim();
      if (!companyId) continue;

      let doc = docsById.get(companyId) || null;
      if (!doc) continue;

      const companyName = String(doc.company_name || doc.name || "").trim();
      const normalizedDomain = String(doc.normalized_domain || "").trim();

      const perDocBudgetMs = Math.max(4000, Math.trunc(deadlineMs / Math.max(1, plannedIds.length || 1)));

      // Use shared XAI config resolution for consistent endpoint/key handling
      const xaiEndpointRaw = getXAIEndpoint();
      const xaiKey = getXAIKey();
      const xaiUrl = resolveXaiEndpointForModel(xaiEndpointRaw, "grok-4-latest");

      const grokArgs = {
        companyName,
        normalizedDomain,
        budgetMs: perDocBudgetMs,
        xaiUrl,
        xaiKey,
      };

      progressRoot.enrichment_progress[companyId] =
        progressRoot.enrichment_progress[companyId] && typeof progressRoot.enrichment_progress[companyId] === "object"
          ? progressRoot.enrichment_progress[companyId]
          : {};

      for (const [fieldIndex, field] of ENRICH_FIELDS.entries()) {
        if (await isSessionStopped(container, sessionId)) return gracefulExit("stopped");

        const fieldProgress =
          progressRoot.enrichment_progress[companyId][field] && typeof progressRoot.enrichment_progress[companyId][field] === "object"
            ? progressRoot.enrichment_progress[companyId][field]
            : { attempts: 0, last_attempt_at: null, last_error: null, status: null, last_cycle_attempted: null };

        // Per-cycle idempotency: attempt xAI at most once per field per cycle.
        if (fieldProgress.last_cycle_attempted === cycleCount) {
          progressRoot.enrichment_progress[companyId][field] = fieldProgress;
          continue;
        }

        // Skip if already populated.
        const alreadyHas = (() => {
          if (field === "reviews") return isRealValue("reviews", doc.curated_reviews, doc);
          return isRealValue(field, doc?.[field], doc);
        })();

        if (alreadyHas) {
          fieldProgress.status = "ok";
          fieldProgress.last_error = null;
          progressRoot.enrichment_progress[companyId][field] = fieldProgress;
          continue;
        }

        // Skip if terminal.
        if (isTerminalMissingField(doc, field)) {
          fieldProgress.status = "terminal";
          fieldProgress.last_error = String(deriveMissingReason(doc, field) || "terminal");
          progressRoot.enrichment_progress[companyId][field] = fieldProgress;
          continue;
        }

        const minMs = Number(MIN_REQUIRED_MS_BY_FIELD[field]) || 0;
        if (!isFreshSeed && minMs && budgetRemainingMs() < minMs) {
          fieldProgress.attempts = (Number(fieldProgress.attempts) || 0) + 1;
          fieldProgress.status = "retryable";
          fieldProgress.last_error = "budget_exhausted";
          fieldProgress.last_attempt_at = nowIso();
          fieldProgress.last_cycle_attempted = cycleCount;
          fieldProgress.xai_diag = null;

          attemptedFieldsThisRun.push(field);
          lastFieldAttemptedThisRun = field;
          lastFieldResultThisRun = "budget_exhausted";
          progressRoot.enrichment_progress[companyId][field] = fieldProgress;
          continue;
        }

        if (!isFreshSeed && xaiFieldsAttemptedThisRun >= MAX_XAI_FIELDS_PER_RUN) {
          // Leave remaining missing fields for the next queue-driven cycle.
          continue;
        }

        const freshSeedBudgetMs = (() => {
          if (!isFreshSeed) return null;
          const remainingFields = Math.max(1, ENRICH_FIELDS.length - Number(fieldIndex || 0));
          const slice = Math.trunc(budgetRemainingMs() / remainingFields);
          return Math.max(1500, Math.min(perDocBudgetMs, slice));
        })();

        const grokArgsForField = freshSeedBudgetMs ? { ...grokArgs, budgetMs: freshSeedBudgetMs } : grokArgs;

        // xAI attempt (explicit)
        xaiFieldsAttemptedThisRun += 1;
        const attemptAt = nowIso();
        fieldProgress.attempts = (Number(fieldProgress.attempts) || 0) + 1;
        fieldProgress.last_attempt_at = attemptAt;
        fieldProgress.last_error = null;
        fieldProgress.last_cycle_attempted = cycleCount;
        attemptedFieldsThisRun.push(field);

        let r = null;
        let status = "";
        let upstream_http_status = null;

        try {
          if (field === "tagline") r = await fetchTagline(grokArgsForField);
          if (field === "headquarters_location") r = await fetchHeadquartersLocation(grokArgsForField);
          if (field === "manufacturing_locations") r = await fetchManufacturingLocations(grokArgsForField);
          if (field === "industries") r = await fetchIndustries(grokArgsForField);
          if (field === "product_keywords") r = await fetchProductKeywords(grokArgsForField);
          if (field === "reviews") r = await fetchCuratedReviews(grokArgsForField);
        } catch (e) {
          const failure = isTimeoutLikeMessage(e?.message) ? "upstream_timeout" : "upstream_unreachable";
          r = { diagnostics: { message: safeErrorMessage(e), upstream_http_status: null }, _failure: failure };
        }

        // Normalize per-field status key.
        if (field === "tagline") status = normalizeKey(r?.tagline_status || r?._failure || "");
        else if (field === "headquarters_location") status = normalizeKey(r?.hq_status || r?._failure || "");
        else if (field === "manufacturing_locations") status = normalizeKey(r?.mfg_status || r?._failure || "");
        else if (field === "industries") status = normalizeKey(r?.industries_status || r?._failure || "");
        else if (field === "product_keywords") status = normalizeKey(r?.keywords_status || r?._failure || "");
        else if (field === "reviews") status = normalizeKey(r?.reviews_stage_status || r?._failure || "");

        upstream_http_status = r?.diagnostics?.upstream_http_status ?? r?.diagnostics?.upstream_status ?? null;

        fieldProgress.xai_diag = {
          xai_request_id:
            r?.diagnostics?.xai_request_id ||
            r?.diagnostics?.xai_requestId ||
            r?.diagnostics?.request_id ||
            r?.diagnostics?.requestId ||
            null,
          xai_model:
            String(process.env.XAI_SEARCH_MODEL || process.env.XAI_CHAT_MODEL || process.env.XAI_MODEL || "").trim() || null,
          xai_http_status: upstream_http_status,
          xai_error_code:
            r?.diagnostics?.error_code ||
            r?.diagnostics?.code ||
            (status && status !== "ok" ? status : null),
          xai_attempted: false,
        };

        const xaiAttempted = status !== "deferred";
        fieldProgress.xai_diag.xai_attempted = xaiAttempted;

        lastFieldAttemptedThisRun = field;
        lastFieldResultThisRun = status || null;
        if (xaiAttempted) {
          await updateLastXaiAttempt(attemptAt);
        }

        // Never persist "deferred" after an attempt: treat it as budget exhaustion.
        if (status === "deferred") {
          fieldProgress.status = "retryable";
          fieldProgress.last_error = "budget_exhausted";

          try {
            doc.import_missing_reason ||= {};
            if (!doc.import_missing_reason[field] || doc.import_missing_reason[field] === "deferred") {
              doc.import_missing_reason[field] = "budget_exhausted";
            }
            doc.import_missing_fields = computeMissingFields(doc);
            doc.updated_at = nowIso();
            await upsertDoc(container, doc).catch(() => null);
          } catch {}

          progressRoot.enrichment_progress[companyId][field] = fieldProgress;
          continue;
        }

        try {
          console.log(`[${HANDLER_ID}] xai_attempt`, {
            session_id: sessionId,
            company_id: companyId,
            field,
            cycle_count: cycleCount,
            status,
            upstream_http_status,
            at: attemptAt,
          });
        } catch {}

        // Apply result (partial saves are required).
        try {
          doc.import_missing_reason ||= {};

          if (field === "tagline") {
            bumpFieldAttempt(doc, "tagline", requestId);
            if (status === "ok" && typeof r?.tagline === "string" && r.tagline.trim()) {
              doc.tagline = r.tagline.trim();
              doc.tagline_unknown = false;
              doc.import_missing_reason.tagline = "ok";
              markFieldSuccess(doc, "tagline");
              fieldProgress.status = "ok";
              savedFieldsThisRun.push("tagline");
            } else {
              const terminal = attemptsFor(doc, "tagline") >= MAX_ATTEMPTS_TAGLINE;
              doc.tagline = "";
              doc.tagline_unknown = true;
              doc.import_missing_reason.tagline = terminal ? "not_found_terminal" : status || "not_found";
              fieldProgress.status = terminal ? "terminal" : "retryable";
              fieldProgress.last_error = status || "not_found";
              if (terminal) terminalizeNonGrokField(doc, "tagline", "not_found_terminal");
            }
          }

          if (field === "headquarters_location") {
            bumpFieldAttempt(doc, "headquarters_location", requestId);
            const value = typeof r?.headquarters_location === "string" ? r.headquarters_location.trim() : "";
            if (status === "ok" && value) {
              doc.headquarters_location = value;
              doc.hq_unknown = false;
              doc.import_missing_reason.headquarters_location = "ok";
              markFieldSuccess(doc, "headquarters_location");
              fieldProgress.status = "ok";
              savedFieldsThisRun.push("headquarters_location");
            } else {
              const terminal = attemptsFor(doc, "headquarters_location") >= MAX_ATTEMPTS_LOCATION;
              doc.hq_unknown = true;
              doc.headquarters_location = status === "not_disclosed" ? "Not disclosed" : "";
              doc.import_missing_reason.headquarters_location = terminal
                ? (status === "not_disclosed" ? "not_disclosed" : "exhausted")
                : status || "not_found";
              fieldProgress.status = terminal ? "terminal" : "retryable";
              fieldProgress.last_error = status || "not_found";
              if (terminal) {
                terminalizeGrokField(doc, "headquarters_location", status === "not_disclosed" ? "not_disclosed" : "exhausted");
              }
            }
          }

          if (field === "manufacturing_locations") {
            bumpFieldAttempt(doc, "manufacturing_locations", requestId);
            const locs = Array.isArray(r?.manufacturing_locations)
              ? r.manufacturing_locations.map((x) => String(x || "").trim()).filter(Boolean)
              : [];
            if (status === "ok" && locs.length > 0) {
              doc.manufacturing_locations = locs;
              doc.mfg_unknown = false;
              doc.import_missing_reason.manufacturing_locations = "ok";
              markFieldSuccess(doc, "manufacturing_locations");
              fieldProgress.status = "ok";
              savedFieldsThisRun.push("manufacturing_locations");
            } else {
              const terminal = attemptsFor(doc, "manufacturing_locations") >= MAX_ATTEMPTS_LOCATION;
              doc.mfg_unknown = true;
              doc.manufacturing_locations = status === "not_disclosed" ? ["Not disclosed"] : [];
              doc.import_missing_reason.manufacturing_locations = terminal
                ? (status === "not_disclosed" ? "not_disclosed" : "exhausted")
                : status || "not_found";
              fieldProgress.status = terminal ? "terminal" : "retryable";
              fieldProgress.last_error = status || "not_found";
              if (terminal) {
                terminalizeGrokField(doc, "manufacturing_locations", status === "not_disclosed" ? "not_disclosed" : "exhausted");
              }
            }
          }

          if (field === "industries") {
            bumpFieldAttempt(doc, "industries", requestId);
            const list = Array.isArray(r?.industries) ? r.industries : [];
            const sanitized = (() => {
              try {
                const { sanitizeIndustries } = require("../../_requiredFields");
                return sanitizeIndustries(list);
              } catch {
                return list.map((x) => String(x || "").trim()).filter(Boolean);
              }
            })();

            if (status === "ok" && sanitized.length > 0) {
              doc.industries = sanitized;
              doc.industries_source = "grok";
              doc.industries_unknown = false;
              doc.import_missing_reason.industries = "ok";
              markFieldSuccess(doc, "industries");
              fieldProgress.status = "ok";
              savedFieldsThisRun.push("industries");
            } else {
              const terminal = attemptsFor(doc, "industries") >= MAX_ATTEMPTS_INDUSTRIES;
              doc.industries = [];
              doc.industries_unknown = true;
              doc.import_missing_reason.industries = terminal ? "not_found_terminal" : status || "not_found";
              fieldProgress.status = terminal ? "terminal" : "retryable";
              fieldProgress.last_error = status || "not_found";
              if (terminal) terminalizeNonGrokField(doc, "industries", "not_found_terminal");
            }
          }

          if (field === "product_keywords") {
            bumpFieldAttempt(doc, "product_keywords", requestId);
            const list = Array.isArray(r?.product_keywords)
              ? r.product_keywords
              : Array.isArray(r?.keywords)
                ? r.keywords
                : [];

            const sanitized = (() => {
              try {
                const { sanitizeKeywords } = require("../../_requiredFields");
                const stats = sanitizeKeywords({ product_keywords: list, keywords: list });
                return Array.isArray(stats?.sanitized) ? stats.sanitized : [];
              } catch {
                return list.map((x) => String(x || "").trim()).filter(Boolean);
              }
            })();

            if (status === "ok" && sanitized.length > 0) {
              doc.keywords = sanitized.slice(0, 25);
              doc.product_keywords = sanitized.join(", ");
              doc.keywords_source = "grok";
              doc.product_keywords_source = "grok";
              doc.product_keywords_unknown = false;
              doc.import_missing_reason.product_keywords = "ok";
              markFieldSuccess(doc, "product_keywords");
              fieldProgress.status = "ok";
              savedFieldsThisRun.push("product_keywords");
            } else {
              const terminal = attemptsFor(doc, "product_keywords") >= MAX_ATTEMPTS_KEYWORDS;
              doc.product_keywords = "";
              doc.product_keywords_unknown = true;
              if (!Array.isArray(doc.keywords)) doc.keywords = [];
              doc.import_missing_reason.product_keywords = terminal ? "not_found_terminal" : status || "not_found";
              fieldProgress.status = terminal ? "terminal" : "retryable";
              fieldProgress.last_error = status || "not_found";
              if (terminal) terminalizeNonGrokField(doc, "product_keywords", "not_found_terminal");
            }
          }

          if (field === "reviews") {
            bumpFieldAttempt(doc, "reviews", requestId);
            const curated = Array.isArray(r?.curated_reviews) ? r.curated_reviews : [];

            doc.review_cursor = doc.review_cursor && typeof doc.review_cursor === "object" ? { ...doc.review_cursor } : {};
            if (!Array.isArray(doc.curated_reviews)) doc.curated_reviews = [];
            if (!Number.isFinite(Number(doc.review_count))) doc.review_count = doc.curated_reviews.length;

            if (status === "ok" && curated.length === 4) {
              doc.curated_reviews = curated.slice(0, 10);
              doc.review_count = curated.length;
              doc.reviews_stage_status = "ok";
              doc.review_cursor.reviews_stage_status = "ok";
              doc.import_missing_reason.reviews = "ok";
              doc.review_cursor.last_success_at = nowIso();
              doc.review_cursor.last_error = null;
              doc.review_cursor.incomplete_reason = null;
              doc.review_cursor.attempted_urls = Array.isArray(r?.attempted_urls) ? r.attempted_urls : undefined;
              markFieldSuccess(doc, "reviews");
              fieldProgress.status = "ok";
              savedFieldsThisRun.push("reviews");
            } else {
              const terminal = attemptsFor(doc, "reviews") >= MAX_ATTEMPTS_REVIEWS;
              if (curated.length > 0) {
                doc.curated_reviews = curated.slice(0, 10);
                doc.review_count = curated.length;
              }

              const upstreamFailure = status === "upstream_unreachable" || status === "upstream_timeout";
              const incompleteReason =
                (typeof r?.incomplete_reason === "string" ? r.incomplete_reason.trim() : "") ||
                (upstreamFailure ? status : "") ||
                (curated.length > 0 ? "insufficient_verified_reviews" : "no_valid_reviews_found");

              doc.reviews_stage_status = "incomplete";
              doc.review_cursor.reviews_stage_status = "incomplete";
              doc.import_missing_reason.reviews = terminal ? "exhausted" : upstreamFailure ? status : "incomplete";
              doc.review_cursor.incomplete_reason = incompleteReason;
              doc.review_cursor.attempted_urls = Array.isArray(r?.attempted_urls) ? r.attempted_urls : undefined;
              doc.review_cursor.last_error = upstreamFailure
                ? {
                    code: status,
                    message: String(r?.diagnostics?.message || status || "reviews_incomplete"),
                    at: attemptAt,
                    request_id: requestId || null,
                    upstream_http_status,
                  }
                : null;

              fieldProgress.status = terminal ? "terminal" : "retryable";
              fieldProgress.last_error = upstreamFailure ? status : "incomplete";
              if (terminal) terminalizeGrokField(doc, "reviews", "exhausted");
            }
          }

          doc.import_missing_fields = computeMissingFields(doc);
          doc.updated_at = nowIso();

          await upsertDoc(container, doc).catch(() => null);
          if (await isSessionStopped(container, sessionId)) return gracefulExit("stopped");
        } catch (e) {
          fieldProgress.status = "retryable";
          fieldProgress.last_error = safeErrorMessage(e) || "apply_failed";
          lastFieldResultThisRun = fieldProgress.last_error;
        }

        progressRoot.enrichment_progress[companyId][field] = fieldProgress;
      }

      docsById.set(companyId, doc);
    }

    const updatedAt = nowIso();

    // Compute remaining required fields using the authoritative contract.
    const nextMissingByCompany = plannedIds
      .map((company_id) => {
        const d = docsById.get(String(company_id || "").trim());
        if (!d) return { company_id, missing_fields: [...ENRICH_FIELDS] };

        const missing = ENRICH_FIELDS.filter((f) => {
          if (f === "reviews") {
            if (isRealValue("reviews", d.curated_reviews, d)) return false;
          } else {
            if (isRealValue(f, d?.[f], d)) return false;
          }
          return !isTerminalMissingField(d, f);
        });

        return { company_id, missing_fields: missing };
      })
      .filter((e) => String(e?.company_id || "").trim());

    const attempted_fields = Array.from(new Set(attemptedFieldsThisRun)).slice(0, 50);
    const last_written_fields = Array.from(new Set(savedFieldsThisRun)).slice(0, 50);

    const resumeNeeded = nextMissingByCompany.some((e) => Array.isArray(e?.missing_fields) && e.missing_fields.length > 0);
    const nextCycleCount = cycleCount + 1;

    const deriveBackoff = () => {
      const attemptedProgress = [];
      try {
        for (const company_id of plannedIds) {
          const companyId = String(company_id || "").trim();
          if (!companyId) continue;
          const byField = progressRoot?.enrichment_progress?.[companyId];
          if (!byField || typeof byField !== "object") continue;

          for (const f of ENRICH_FIELDS) {
            const p = byField?.[f];
            if (!p || typeof p !== "object") continue;
            if (Number(p.last_cycle_attempted) !== cycleCount) continue;
            attemptedProgress.push(p);
          }
        }
      } catch {}

      const has429 = attemptedProgress.some((p) => Number(p?.xai_diag?.xai_http_status || 0) === 429);
      if (has429) {
        const schedule = [60_000, 120_000, 300_000, 600_000];
        const idx = Math.min(schedule.length - 1, Math.max(0, nextCycleCount - 1));
        return { reason: "rate_limit", backoff_ms: schedule[idx] };
      }

      const hasTimeout = attemptedProgress.some((p) => String(p?.last_error || "") === "upstream_timeout");
      if (hasTimeout) {
        const schedule = [30_000, 60_000, 120_000];
        const idx = Math.min(schedule.length - 1, Math.max(0, nextCycleCount - 1));
        return { reason: "timeout", backoff_ms: schedule[idx] };
      }

      const hasNetwork = attemptedProgress.some((p) => String(p?.last_error || "") === "upstream_unreachable");
      if (hasNetwork) {
        const schedule = [30_000, 60_000, 120_000];
        const idx = Math.min(schedule.length - 1, Math.max(0, nextCycleCount - 1));
        return { reason: "network", backoff_ms: schedule[idx] };
      }

      const hasNotFound = attemptedProgress.some((p) => String(p?.last_error || "") === "not_found");
      if (hasNotFound) {
        return { reason: "not_found", backoff_ms: 60_000 };
      }

      const hasBudget = attemptedProgress.some((p) => String(p?.last_error || "") === "budget_exhausted");
      if (hasBudget) {
        return { reason: "budget_exhausted", backoff_ms: 30_000 };
      }

      return { reason: "default", backoff_ms: 30_000 };
    };

    let finalStatus = null;
    let finalResumeNeeded = resumeNeeded;
    let nextAllowedRunAt = null;
    let lastBackoffReason = null;
    let lastBackoffMs = null;
    let enqueueRes = null;
    let resume_error = null;

    const capReached = resumeNeeded && nextCycleCount >= MAX_RESUME_CYCLES;

    if (!resumeNeeded) {
      finalStatus = "complete";
      finalResumeNeeded = false;
    } else if (capReached) {
      finalStatus = "terminal";
      finalResumeNeeded = false;

      // Terminalize remaining fields so required-field contract will treat this session as done.
      for (const entry of nextMissingByCompany) {
        const companyId = String(entry?.company_id || "").trim();
        if (!companyId) continue;
        const d = docsById.get(companyId);
        if (!d) continue;

        const missingFields = Array.isArray(entry?.missing_fields) ? entry.missing_fields : [];
        let changed = false;

        d.import_missing_reason ||= {};

        for (const field of missingFields) {
          if (!field) continue;
          if (isTerminalMissingField(d, field)) continue;

          d.import_missing_reason[field] = "cycle_cap_exhausted";
          if (field === "headquarters_location" || field === "manufacturing_locations" || field === "reviews") {
            terminalizeGrokField(d, field, "cycle_cap_exhausted");
          } else {
            terminalizeNonGrokField(d, field, "cycle_cap_exhausted");
          }
          changed = true;
        }

        if (changed) {
          d.import_missing_fields = computeMissingFields(d);
          d.updated_at = nowIso();
          await upsertDoc(container, d).catch(() => null);
        }
      }
    } else {
      const backoff = deriveBackoff();
      lastBackoffReason = backoff.reason;
      lastBackoffMs = backoff.backoff_ms;
      nextAllowedRunAt = new Date(Date.now() + backoff.backoff_ms).toISOString();

      // Check stop doc again before self-scheduling.
      const stopped = await isSessionStopped(container, sessionId);
      if (!stopped) {
        enqueueRes = await enqueueResumeRun({
          session_id: sessionId,
          reason: "auto_retry",
          requested_by: "resume_worker",
          enqueue_at: updatedAt,
          cycle_count: nextCycleCount,
          run_after_ms: backoff.backoff_ms,
        }).catch((e) => ({ ok: false, error: e?.message || String(e || "enqueue_failed") }));
      }

      if (enqueueRes?.ok) {
        finalStatus = "queued";
      } else {
        finalStatus = "stalled";
        resume_error = {
          code: "ENQUEUE_FAILED",
          message: String(enqueueRes?.error || "enqueue_failed"),
          at: updatedAt,
        };
      }
    }

    const nextResumeDoc = {
      ...(resumeDoc && typeof resumeDoc === "object" ? resumeDoc : {}),
      id: resumeDocId,
      session_id: sessionId,
      normalized_domain: "import",
      partition_key: "import",
      type: "import_control",
      status: finalStatus,
      cycle_count: nextCycleCount,
      missing_by_company: nextMissingByCompany,
      enrichment_progress: progressRoot.enrichment_progress,
      attempted_fields,
      last_written_fields,
      last_xai_attempt_at: resumeDoc?.last_xai_attempt_at || null,
      last_field_attempted: lastFieldAttemptedThisRun,
      last_field_result: lastFieldResultThisRun,
      next_allowed_run_at: nextAllowedRunAt,
      last_backoff_reason: lastBackoffReason,
      last_backoff_ms: lastBackoffMs,
      ...(resume_error ? { resume_error } : {}),
      last_finished_at: updatedAt,
      ...(finalStatus === "complete" ? { completed_at: updatedAt } : {}),
      lock_expires_at: null,
      updated_at: updatedAt,
    };

    await upsertDoc(container, nextResumeDoc).catch(() => null);

    const sessionPatch = {
      resume_needed: finalResumeNeeded,
      resume_updated_at: updatedAt,
      resume_worker_last_finished_at: updatedAt,
      resume_worker_last_result: finalStatus,
      resume_worker_attempted_fields: attempted_fields,
      resume_worker_last_written_fields: last_written_fields,
      resume_worker_last_field_attempted: lastFieldAttemptedThisRun,
      resume_worker_last_field_result: lastFieldResultThisRun,
      resume_next_allowed_run_at: nextAllowedRunAt,
      resume_last_backoff_reason: lastBackoffReason,
      resume_last_backoff_ms: lastBackoffMs,
      ...(enqueueRes?.ok
        ? {
            resume_worker_last_enqueued_at: updatedAt,
            resume_worker_last_enqueue_reason: "auto_retry",
            resume_worker_last_enqueue_ok: true,
            resume_worker_last_enqueue_error: null,
          }
        : enqueueRes
          ? {
              resume_worker_last_enqueued_at: updatedAt,
              resume_worker_last_enqueue_reason: "auto_retry",
              resume_worker_last_enqueue_ok: false,
              resume_worker_last_enqueue_error: String(enqueueRes?.error || "enqueue_failed"),
            }
          : {}),
      updated_at: updatedAt,
    };

    await bestEffortPatchSessionDoc({
      container,
      sessionId,
      patch: sessionPatch,
    }).catch(() => null);

    return json(
      {
        ok: true,
        result: finalStatus,
        session_id: sessionId,
        handler_entered_at,
        did_work: true,
        did_work_reason: isFreshSeed ? "fresh_seed_enrichment" : "resume_enrichment",
        resume_needed: finalResumeNeeded,
        cycle_count: nextCycleCount,
        next_allowed_run_at: nextAllowedRunAt,
        last_backoff_reason: lastBackoffReason,
        last_backoff_ms: lastBackoffMs,
        enqueued: Boolean(enqueueRes?.ok),
        queue: enqueueRes?.queue || null,
        message_id: enqueueRes?.message_id || null,
        missing_by_company: nextMissingByCompany,
        attempted_fields,
        last_written_fields,
        last_xai_attempt_at: resumeDoc?.last_xai_attempt_at || null,
        last_field_attempted: lastFieldAttemptedThisRun,
        last_field_result: lastFieldResultThisRun,
      },
      200,
      req
    );
  }

  const startedEnrichmentAt = Date.now();
  const perDocBudgetMs = Math.max(4000, Math.trunc(deadlineMs / Math.max(1, seedDocs.length)));

  const workerErrors = [];

  // Planner telemetry: we want to distinguish "no attempts" because nothing was scheduled (budget/planner)
  // from a true no-op bug where fields were planned but no attempts were recorded.
  const plannedFieldsThisRun = new Set();
  const plannedFieldsSkipped = [];

  const safeJsonPreview = (value, limit = 1200) => {
    if (!value) return null;
    try {
      const s = typeof value === "string" ? value : JSON.stringify(value);
      return s.length > limit ? s.slice(0, limit) : s;
    } catch {
      return null;
    }
  };

  const recordWorkerError = (field, stage, err, details) => {
    const entry = {
      field: String(field || "").trim() || null,
      stage: String(stage || "").trim() || null,
      at: nowIso(),
      code:
        typeof err?.code === "string"
          ? err.code
          : typeof err?.error_code === "string"
            ? err.error_code
            : typeof err?.error === "string"
              ? err.error
              : null,
      message: safeErrorMessage(err) || "error",
    };

    // Persist useful upstream diagnostics when present.
    if (err && typeof err === "object" && !Array.isArray(err)) {
      for (const k of [
        "elapsed_ms",
        "timeout_ms",
        "aborted_by_us",
        "abort_timer_fired",
        "upstream_http_status",
        "upstream_request_id",
      ]) {
        if (err[k] !== undefined && err[k] !== null) entry[k] = err[k];
      }
    }

    if (details && typeof details === "object") Object.assign(entry, details);

    workerErrors.push(entry);
    return entry;
  };

  for (const doc of seedDocs) {
    if (!doc || typeof doc !== "object") continue;

    const missingNow = computeRetryableMissingFields(doc);

    const companyName = String(doc.company_name || doc.name || "").trim();
    const normalizedDomain = String(doc.normalized_domain || "").trim();

    // Use shared XAI config resolution for consistent endpoint/key handling
    const xaiEndpointRaw2 = getXAIEndpoint();
    const xaiKey2 = getXAIKey();
    const xaiUrl2 = resolveXaiEndpointForModel(xaiEndpointRaw2, "grok-4-latest");

    const grokArgs = {
      companyName,
      normalizedDomain,
      budgetMs: perDocBudgetMs,
      xaiUrl: xaiUrl2,
      xaiKey: xaiKey2,
    };

    let changed = false;

    if (reconcileGrokTerminalState(doc)) changed = true;

    const remainingRunMs = () => Math.max(0, deadlineMs - (Date.now() - startedEnrichmentAt));

    // Field-level planning:
    // Minimum time budgets per field - reduced to allow enrichment to proceed.
    // xAI API calls typically complete within 10-30 seconds.
    // Minimum required budget per field - set high enough to allow xAI web searches to complete.
    // xAI searches can take 1-3 minutes, so we need generous minimums.
    const MIN_REQUIRED_MS_BY_FIELD = {
      reviews: 480_000,          // 8 minutes min (4x - complex web search with URL verification)
      headquarters_location: 90_000,    // 1.5 minutes min
      manufacturing_locations: 90_000,  // 1.5 minutes min
      tagline: 60_000,           // 1 minute min
      industries: 60_000,        // 1 minute min
      product_keywords: 180_000, // 3 minutes min (2x - must accumulate all products)
    };

    const taglineRetryable = !isRealValue("tagline", doc.tagline, doc) && !isTerminalMissingField(doc, "tagline");

    const fieldsPlanned = (() => {
      const HEAVY_FIELDS = ["headquarters_location", "manufacturing_locations", "reviews", "industries", "product_keywords"];
      const heavyMissing = HEAVY_FIELDS.some((f) => missingNow.includes(f));

      // Single-company mode must eventually attempt heavy fields across cycles.
      // If any heavy field is missing+retryable, schedule exactly 1 heavy field per cycle,
      // chosen by lowest attempt count (ties prefer HQ).
      if (singleCompanyMode && heavyMissing) {
        const heavy = HEAVY_FIELDS.filter((f) => missingNow.includes(f));
        const lastAttemptMs = (field) => {
          const ts = String(doc?.import_attempts_detail?.[field]?.last_attempt_at || "");
          const ms = Date.parse(ts) || 0;
          return ms;
        };

        heavy.sort((a, b) => {
          const da = attemptsFor(doc, a);
          const db = attemptsFor(doc, b);
          if (da !== db) return da - db;

          // Prefer the field we haven't tried recently.
          const la = lastAttemptMs(a);
          const lb = lastAttemptMs(b);
          if (la !== lb) return la - lb;

          return a === "headquarters_location" ? -1 : b === "headquarters_location" ? 1 : 0;
        });
        return new Set([heavy[0]]);
      }

      const priority = [
        "headquarters_location",
        "manufacturing_locations",
        "reviews",
        "tagline",
        "industries",
        "product_keywords",
        "logo",
      ];

      const out = [];

      for (const field of priority) {
        if (field === "tagline") {
          if (!taglineRetryable) continue;
        } else {
          if (!missingNow.includes(field)) continue;
        }

        const minRequired = Number(MIN_REQUIRED_MS_BY_FIELD[field]) || 0;
        if (minRequired > 0) {
          if (perDocBudgetMs < minRequired) continue;
          if (remainingRunMs() < minRequired) continue;
        }

        out.push(field);

        // Single-company mode should do less per cycle rather than slash timeouts.
        // In particular, do at most one heavy upstream stage per cycle to reduce timeouts.
        if (singleCompanyMode) {
          const heavy =
            field === "headquarters_location" ||
            field === "manufacturing_locations" ||
            field === "reviews" ||
            field === "industries" ||
            field === "product_keywords";
          if (heavy || out.length >= 2) break;
        }
      }

      // Fallback: when min-ms thresholds prevent scheduling *any* work but we still have retryable missing
      // fields, schedule a single best-effort attempt. This prevents no-op resume-worker cycles that can
      // cause sessions to get stuck/blocked with retryable missing fields.
      if (out.length === 0 && (missingNow.length > 0 || taglineRetryable)) {
        const taglineAttempts = attemptsFor(doc, "tagline");

        // If any heavy field is missing, never plan "tagline only" (and never retry tagline endlessly).
        const fallbackPriority = heavyMissing
          ? ["headquarters_location", "manufacturing_locations", "reviews", "industries", "product_keywords", "logo"]
          : [
              "tagline",
              "industries",
              "product_keywords",
              "logo",
              "headquarters_location",
              "manufacturing_locations",
              "reviews",
            ];

        for (const f of fallbackPriority) {
          if (f === "tagline") {
            if (taglineRetryable && (!heavyMissing || taglineAttempts < 2)) {
              out.push(f);
              break;
            }
            continue;
          }

          if (missingNow.includes(f)) {
            out.push(f);
            break;
          }
        }
      }

      return new Set(out);
    })();

    const shouldRunField = (field) => fieldsPlanned.has(field);

    if (fieldsPlanned.size > 0) {
      for (const f of fieldsPlanned.values()) plannedFieldsThisRun.add(f);
    } else if (missingNow.length > 0 || taglineRetryable) {
      const candidates = Array.from(new Set([...missingNow, ...(taglineRetryable ? ["tagline"] : [])]));
      const minList = candidates
        .map((f) => ({ field: f, min_ms: Number(MIN_REQUIRED_MS_BY_FIELD[f]) || 0 }))
        .filter((x) => x.min_ms > 0);

      const minRequiredAny = minList.length > 0 ? Math.min(...minList.map((x) => x.min_ms)) : 0;
      const remainingMs = remainingRunMs();

      const reason =
        minRequiredAny && perDocBudgetMs < minRequiredAny
          ? "planner_skipped_due_to_budget"
          : minRequiredAny && remainingMs < minRequiredAny
            ? "planner_skipped_due_to_deadline"
            : "planner_no_actionable_fields";

      plannedFieldsSkipped.push({
        company_id: String(doc?.id || "").trim() || null,
        company_name: companyName || null,
        missing_fields: candidates,
        reason,
        per_doc_budget_ms: perDocBudgetMs,
        remaining_run_ms: remainingMs,
      });
    }

    // Tagline (Grok authoritative)
    if (taglineRetryable && shouldRunField("tagline")) {
      const bumped = bumpFieldAttempt(doc, "tagline", requestId);
      if (bumped) changed = true;

      let r;
      try {
        noteUpstreamCall();
        r = await fetchTagline(grokArgs);
      } catch (e) {
        const entry = recordWorkerError("tagline", "grok_tagline", e);
        const failure = isTimeoutLikeMessage(entry.message) ? "upstream_timeout" : "upstream_unreachable";
        r = { tagline: "", tagline_status: failure, diagnostics: entry };
      }

      const status = normalizeKey(r?.tagline_status || "");
      if (status === "ok" && typeof r?.tagline === "string" && r.tagline.trim()) {
        doc.tagline = r.tagline.trim();
        doc.tagline_unknown = false;
        doc.import_missing_reason ||= {};
        doc.import_missing_reason.tagline = "ok";
        markFieldSuccess(doc, "tagline");
        changed = true;
      } else {
        const terminal = attemptsFor(doc, "tagline") >= MAX_ATTEMPTS_TAGLINE;
        const reason = status || "not_found";

        doc.import_missing_reason ||= {};
        doc.import_missing_reason.tagline = terminal ? "not_found_terminal" : reason;
        doc.tagline_unknown = true;

        if (status === "upstream_unreachable" || status === "upstream_timeout") {
          const entry = recordWorkerError("tagline", "grok_tagline", r?.diagnostics || r);
          markFieldError(doc, "tagline", entry);
          addImportWarning(doc, {
            field: "tagline",
            missing_reason: status,
            stage: "grok_tagline",
            retryable: !terminal,
            message: status === "upstream_timeout" ? "Grok tagline request timed out" : "Grok tagline fetch failed",
            error_code: status,
            elapsed_ms: entry.elapsed_ms ?? null,
            timeout_ms: entry.timeout_ms ?? null,
            aborted_by_us: entry.aborted_by_us ?? null,
            upstream_request_id: entry.upstream_request_id ?? null,
            at: nowIso(),
          });
          markEnrichmentIncomplete(doc, {
            reason: status === "upstream_timeout" ? "upstream timeout" : "upstream unreachable",
            field: "tagline",
          });
        }

        if (terminal) {
          terminalizeNonGrokField(doc, "tagline", "not_found_terminal");
        }

        changed = true;
      }
    }

    // Industries (Grok authoritative)
    if (missingNow.includes("industries") && shouldRunField("industries")) {
      const bumped = bumpFieldAttempt(doc, "industries", requestId);
      if (bumped) changed = true;

      let r;
      try {
        noteUpstreamCall();
        r = await fetchIndustries(grokArgs);
      } catch (e) {
        const entry = recordWorkerError("industries", "grok_industries", e);
        const failure = isTimeoutLikeMessage(entry.message) ? "upstream_timeout" : "upstream_unreachable";
        r = { industries: [], industries_status: failure, diagnostics: entry };
      }

      const status = normalizeKey(r?.industries_status || "");
      const list = Array.isArray(r?.industries) ? r.industries : [];
      const sanitized = (() => {
        try {
          const { sanitizeIndustries } = require("../../_requiredFields");
          return sanitizeIndustries(list);
        } catch {
          return list.map((x) => String(x || "").trim()).filter(Boolean);
        }
      })();

      if (status === "ok" && sanitized.length > 0) {
        doc.industries = sanitized;
        doc.industries_source = "grok";
        doc.industries_unknown = false;
        doc.import_missing_reason ||= {};
        doc.import_missing_reason.industries = "ok";
        markFieldSuccess(doc, "industries");
        changed = true;
      } else {
        const hadAny = Array.isArray(list) && list.length > 0;
        const terminal = attemptsFor(doc, "industries") >= MAX_ATTEMPTS_INDUSTRIES;

        const retryReason = status === "ok" && hadAny ? "low_quality" : status || "not_found";
        const terminalReason = retryReason === "low_quality" ? "low_quality_terminal" : "not_found_terminal";

        doc.import_missing_reason ||= {};
        doc.import_missing_reason.industries = terminal ? terminalReason : retryReason;

        if (status === "upstream_unreachable" || status === "upstream_timeout") {
          const entry = recordWorkerError("industries", "grok_industries", r?.diagnostics || r);
          markFieldError(doc, "industries", entry);
          addImportWarning(doc, {
            field: "industries",
            missing_reason: status,
            stage: "grok_industries",
            retryable: !terminal,
            message: status === "upstream_timeout" ? "Grok industries request timed out" : "Grok industries fetch failed",
            error_code: status,
            elapsed_ms: entry.elapsed_ms ?? null,
            timeout_ms: entry.timeout_ms ?? null,
            aborted_by_us: entry.aborted_by_us ?? null,
            upstream_request_id: entry.upstream_request_id ?? null,
            at: nowIso(),
          });
          markEnrichmentIncomplete(doc, {
            reason: status === "upstream_timeout" ? "upstream timeout" : "upstream unreachable",
            field: "industries",
          });
        }

        if (terminal) {
          terminalizeNonGrokField(doc, "industries", terminalReason);
        }

        changed = true;
      }
    }

    // Product keywords (Grok authoritative)
    if (missingNow.includes("product_keywords") && shouldRunField("product_keywords")) {
      const bumped = bumpFieldAttempt(doc, "product_keywords", requestId);
      if (bumped) changed = true;

      let r;
      try {
        noteUpstreamCall();
        r = await fetchProductKeywords(grokArgs);
      } catch (e) {
        const entry = recordWorkerError("product_keywords", "grok_keywords", e);
        const failure = isTimeoutLikeMessage(entry.message) ? "upstream_timeout" : "upstream_unreachable";
        r = { keywords: [], keywords_status: failure, diagnostics: entry };
      }

      const status = normalizeKey(r?.keywords_status || "");
      const list = Array.isArray(r?.product_keywords) ? r.product_keywords : Array.isArray(r?.keywords) ? r.keywords : [];

      const sanitized = (() => {
        try {
          const { sanitizeKeywords } = require("../../_requiredFields");
          const stats = sanitizeKeywords({ product_keywords: list.join(", "), keywords: [] });
          return Array.isArray(stats?.sanitized) ? stats.sanitized : [];
        } catch {
          return list.map((x) => String(x || "").trim()).filter(Boolean);
        }
      })();

      if (status === "ok" && sanitized.length >= 20) {
        doc.keywords = sanitized.slice(0, 25);
        doc.product_keywords = sanitized.join(", ");
        doc.keywords_source = "grok";
        doc.product_keywords_source = "grok";

        doc.product_keywords_unknown = false;
        doc.import_missing_reason ||= {};
        doc.import_missing_reason.product_keywords = "ok";
        markFieldSuccess(doc, "product_keywords");
        changed = true;
      } else {
        const hadAny = Array.isArray(list) && list.length > 0;
        const terminal = attemptsFor(doc, "product_keywords") >= MAX_ATTEMPTS_KEYWORDS;
        const retryReason = status === "ok" && hadAny ? "low_quality" : status || "not_found";
        const terminalReason = retryReason === "low_quality" ? "low_quality_terminal" : "not_found_terminal";

        doc.import_missing_reason ||= {};
        doc.import_missing_reason.product_keywords = terminal ? terminalReason : retryReason;
        doc.product_keywords_unknown = true;

        if (status === "upstream_unreachable" || status === "upstream_timeout") {
          const entry = recordWorkerError("product_keywords", "grok_keywords", r?.diagnostics || r);
          markFieldError(doc, "product_keywords", entry);
          addImportWarning(doc, {
            field: "product_keywords",
            missing_reason: status,
            stage: "grok_keywords",
            retryable: !terminal,
            message:
              status === "upstream_timeout"
                ? "Grok product keywords request timed out"
                : "Grok product keywords fetch failed",
            error_code: status,
            elapsed_ms: entry.elapsed_ms ?? null,
            timeout_ms: entry.timeout_ms ?? null,
            aborted_by_us: entry.aborted_by_us ?? null,
            upstream_request_id: entry.upstream_request_id ?? null,
            at: nowIso(),
          });
          markEnrichmentIncomplete(doc, {
            reason: status === "upstream_timeout" ? "upstream timeout" : "upstream unreachable",
            field: "product_keywords",
          });
        }

        if (terminal) {
          terminalizeNonGrokField(doc, "product_keywords", terminalReason);
        }

        changed = true;
      }
    }

    // HQ
    if (missingNow.includes("headquarters_location") && shouldRunField("headquarters_location")) {
      const bumped = bumpFieldAttempt(doc, "headquarters_location", requestId);
      if (bumped) changed = true;

      let r;
      try {
        noteUpstreamCall();
        r = await fetchHeadquartersLocation(grokArgs);
      } catch (e) {
        const entry = recordWorkerError("headquarters_location", "grok_hq", e);
        const failure = isTimeoutLikeMessage(entry.message) ? "upstream_timeout" : "upstream_unreachable";
        r = { headquarters_location: "", hq_status: failure, diagnostics: entry };
      }

      const status = normalizeKey(r?.hq_status || "");
      const value = typeof r?.headquarters_location === "string" ? r.headquarters_location.trim() : "";

      if (status === "ok" && value) {
        doc.headquarters_location = value;
        doc.hq_unknown = false;
        doc.hq_unknown_reason = null;
        doc.import_missing_reason ||= {};
        doc.import_missing_reason.headquarters_location = "ok";

        const hqSourceUrls = Array.isArray(r?.location_source_urls?.hq_source_urls)
          ? r.location_source_urls.hq_source_urls
          : Array.isArray(r?.source_urls)
            ? r.source_urls
            : [];

        doc.enrichment_debug = doc.enrichment_debug && typeof doc.enrichment_debug === "object" ? doc.enrichment_debug : {};
        doc.enrichment_debug.location_sources =
          doc.enrichment_debug.location_sources && typeof doc.enrichment_debug.location_sources === "object"
            ? doc.enrichment_debug.location_sources
            : {};
        doc.enrichment_debug.location_sources.hq_source_urls = hqSourceUrls;

        for (const url of hqSourceUrls) {
          const sourceUrl = String(url || "").trim();
          if (!sourceUrl) continue;
          mergeLocationSource(doc, {
            location_type: "headquarters",
            location: value,
            source_url: sourceUrl,
            extracted_field: "headquarters_location",
            normalized_domain: normalizedDomain,
          });
        }

        markFieldSuccess(doc, "headquarters_location");
        changed = true;
      } else {
        const terminal = attemptsFor(doc, "headquarters_location") >= MAX_ATTEMPTS_LOCATION;

        const normalized = status === "not_disclosed" ? "not_disclosed_pending" : status || "not_found";

        doc.hq_unknown = true;
        doc.hq_unknown_reason = "pending_grok";
        doc.import_missing_reason ||= {};
        doc.import_missing_reason.headquarters_location = terminal
          ? (status === "upstream_unreachable" || status === "upstream_timeout" || status === "deferred"
              ? "exhausted"
              : "not_disclosed")
          : normalized;

        if (status === "upstream_unreachable" || status === "upstream_timeout") {
          const entry = recordWorkerError("headquarters_location", "grok_hq", r?.diagnostics || r, {
            upstream_preview: safeJsonPreview(r?.diagnostics || r),
          });
          markFieldError(doc, "headquarters_location", entry);
          addImportWarning(doc, {
            field: "headquarters_location",
            missing_reason: status,
            stage: "grok_hq",
            retryable: !terminal,
            message: status === "upstream_timeout" ? "Grok HQ request timed out" : "Grok HQ fetch failed",
            error_code: status,
            elapsed_ms: entry.elapsed_ms ?? null,
            timeout_ms: entry.timeout_ms ?? null,
            aborted_by_us: entry.aborted_by_us ?? null,
            upstream_request_id: entry.upstream_request_id ?? null,
            at: nowIso(),
          });
          markEnrichmentIncomplete(doc, {
            reason: status === "upstream_timeout" ? "upstream timeout" : "upstream unreachable",
            field: "headquarters_location",
          });
        }

        if (terminal) {
          terminalizeGrokField(
            doc,
            "headquarters_location",
            status === "upstream_unreachable" || status === "upstream_timeout" || status === "deferred"
              ? "exhausted"
              : "not_disclosed"
          );
        }

        changed = true;
      }
    }

    // MFG
    if (missingNow.includes("manufacturing_locations") && shouldRunField("manufacturing_locations")) {
      const bumped = bumpFieldAttempt(doc, "manufacturing_locations", requestId);
      if (bumped) changed = true;

      let r;
      try {
        noteUpstreamCall();
        r = await fetchManufacturingLocations(grokArgs);
      } catch (e) {
        const entry = recordWorkerError("manufacturing_locations", "grok_mfg", e);
        const failure = isTimeoutLikeMessage(entry.message) ? "upstream_timeout" : "upstream_unreachable";
        r = { manufacturing_locations: [], mfg_status: failure, diagnostics: entry };
      }

      const status = normalizeKey(r?.mfg_status || "");
      const locs = Array.isArray(r?.manufacturing_locations) ? r.manufacturing_locations : [];

      if (status === "ok" && locs.length > 0) {
        doc.manufacturing_locations = locs;
        doc.mfg_unknown = false;
        doc.mfg_unknown_reason = null;
        doc.import_missing_reason ||= {};
        doc.import_missing_reason.manufacturing_locations = "ok";

        const mfgSourceUrls = Array.isArray(r?.location_source_urls?.mfg_source_urls)
          ? r.location_source_urls.mfg_source_urls
          : Array.isArray(r?.source_urls)
            ? r.source_urls
            : [];

        doc.enrichment_debug = doc.enrichment_debug && typeof doc.enrichment_debug === "object" ? doc.enrichment_debug : {};
        doc.enrichment_debug.location_sources =
          doc.enrichment_debug.location_sources && typeof doc.enrichment_debug.location_sources === "object"
            ? doc.enrichment_debug.location_sources
            : {};
        doc.enrichment_debug.location_sources.mfg_source_urls = mfgSourceUrls;

        for (const loc of locs) {
          const locStr = String(loc || "").trim();
          if (!locStr) continue;

          for (const url of mfgSourceUrls) {
            const sourceUrl = String(url || "").trim();
            if (!sourceUrl) continue;

            mergeLocationSource(doc, {
              location_type: "manufacturing",
              location: locStr,
              source_url: sourceUrl,
              extracted_field: "manufacturing_locations",
              normalized_domain: normalizedDomain,
            });
          }
        }

        markFieldSuccess(doc, "manufacturing_locations");
        changed = true;
      } else {
        const terminal = attemptsFor(doc, "manufacturing_locations") >= MAX_ATTEMPTS_LOCATION;

        const normalized = status === "not_disclosed" ? "not_disclosed_pending" : status || "not_found";

        doc.mfg_unknown = true;
        doc.mfg_unknown_reason = "pending_grok";
        doc.import_missing_reason ||= {};
        doc.import_missing_reason.manufacturing_locations = terminal
          ? (status === "upstream_unreachable" || status === "upstream_timeout" || status === "deferred"
              ? "exhausted"
              : "not_disclosed")
          : normalized;

        if (status === "upstream_unreachable" || status === "upstream_timeout") {
          const entry = recordWorkerError("manufacturing_locations", "grok_mfg", r?.diagnostics || r, {
            upstream_preview: safeJsonPreview(r?.diagnostics || r),
          });
          markFieldError(doc, "manufacturing_locations", entry);
          addImportWarning(doc, {
            field: "manufacturing_locations",
            missing_reason: status,
            stage: "grok_mfg",
            retryable: !terminal,
            message:
              status === "upstream_timeout"
                ? "Grok manufacturing request timed out"
                : "Grok manufacturing fetch failed",
            error_code: status,
            elapsed_ms: entry.elapsed_ms ?? null,
            timeout_ms: entry.timeout_ms ?? null,
            aborted_by_us: entry.aborted_by_us ?? null,
            upstream_request_id: entry.upstream_request_id ?? null,
            at: nowIso(),
          });
          markEnrichmentIncomplete(doc, {
            reason: status === "upstream_timeout" ? "upstream timeout" : "upstream unreachable",
            field: "manufacturing_locations",
          });
        }

        if (terminal) {
          terminalizeGrokField(
            doc,
            "manufacturing_locations",
            status === "upstream_unreachable" || status === "upstream_timeout" || status === "deferred"
              ? "exhausted"
              : "not_disclosed"
          );
        }

        changed = true;
      }
    }

    // Reviews
    if (missingNow.includes("reviews") && shouldRunField("reviews")) {
      const bumped = bumpFieldAttempt(doc, "reviews", requestId);
      if (bumped) changed = true;

      let r;
      try {
        noteUpstreamCall();
        r = await fetchCuratedReviews(grokArgs);
      } catch (e) {
        const entry = recordWorkerError("reviews", "grok_reviews", e);
        const failure = isTimeoutLikeMessage(entry.message) ? "upstream_timeout" : "upstream_unreachable";
        r = { curated_reviews: [], reviews_stage_status: failure, diagnostics: entry };
      }

      const status = normalizeKey(r?.reviews_stage_status || "");
      const curated = Array.isArray(r?.curated_reviews) ? r.curated_reviews : [];

      doc.review_cursor = doc.review_cursor && typeof doc.review_cursor === "object" ? { ...doc.review_cursor } : {};

      if (status === "ok" && curated.length === 4) {
        doc.curated_reviews = curated.slice(0, 10);

        const counts = curated
          .map((x) => (x && typeof x === "object" ? Number(x.review_count) : NaN))
          .filter((n) => Number.isFinite(n) && n > 0);

        const derivedCount = counts.length > 0 ? Math.max(...counts) : curated.length;
        doc.review_count = Number.isFinite(Number(doc.review_count)) && Number(doc.review_count) > 0
          ? Number(doc.review_count)
          : derivedCount;

        doc.reviews_stage_status = "ok";
        doc.review_cursor.reviews_stage_status = "ok";
        doc.import_missing_reason ||= {};
        doc.import_missing_reason.reviews = "ok";

        doc.review_cursor.last_success_at = nowIso();
        doc.review_cursor.last_error = null;
        doc.review_cursor.incomplete_reason = null;
        doc.review_cursor.attempted_urls = Array.isArray(r?.attempted_urls) ? r.attempted_urls : undefined;

        markFieldSuccess(doc, "reviews");
        changed = true;
      } else {
        const terminal = attemptsFor(doc, "reviews") >= MAX_ATTEMPTS_REVIEWS;

        // Persist partial results if we got any (e.g., status=incomplete).
        if (curated.length > 0) {
          doc.curated_reviews = curated.slice(0, 10);
          doc.review_count = curated.length;
        }

        const upstreamFailure = status === "upstream_unreachable" || status === "upstream_timeout";

        const incompleteReason =
          (typeof r?.incomplete_reason === "string" ? r.incomplete_reason.trim() : "") ||
          (upstreamFailure ? status : "") ||
          (curated.length > 0 ? "insufficient_verified_reviews" : "no_valid_reviews_found");

        // Required invariant: once we attempt reviews, the status must not stay "pending".
        doc.reviews_stage_status = "incomplete";
        doc.review_cursor.reviews_stage_status = "incomplete";
        doc.import_missing_reason ||= {};
        doc.import_missing_reason.reviews = terminal ? "exhausted" : upstreamFailure ? status : "incomplete";

        doc.review_cursor.incomplete_reason = incompleteReason;
        doc.review_cursor.attempted_urls = Array.isArray(r?.attempted_urls) ? r.attempted_urls : undefined;

        if (inferredStatus === "upstream_unreachable" || inferredStatus === "upstream_timeout") {
          const entry = recordWorkerError("reviews", "grok_reviews", r?.diagnostics || r, {
            upstream_preview: safeJsonPreview(r?.diagnostics || r),
          });

          markFieldError(doc, "reviews", entry);

          doc.review_cursor.last_error = {
            code: inferredStatus,
            message: entry.message,
            at: entry.at,
            request_id: requestId || null,
            elapsed_ms: entry.elapsed_ms ?? null,
            timeout_ms: entry.timeout_ms ?? null,
            aborted_by_us: entry.aborted_by_us ?? null,
            upstream_request_id: entry.upstream_request_id ?? null,
          };

          addImportWarning(doc, {
            field: "reviews",
            missing_reason: inferredStatus,
            stage: "grok_reviews",
            retryable: !terminal,
            message:
              inferredStatus === "upstream_timeout" ? "Grok reviews request timed out" : "Grok reviews fetch failed",
            error_code: inferredStatus,
            elapsed_ms: entry.elapsed_ms ?? null,
            timeout_ms: entry.timeout_ms ?? null,
            aborted_by_us: entry.aborted_by_us ?? null,
            upstream_request_id: entry.upstream_request_id ?? null,
            at: nowIso(),
          });
          markEnrichmentIncomplete(doc, {
            reason: inferredStatus === "upstream_timeout" ? "upstream timeout" : "upstream unreachable",
            field: "reviews",
          });
        } else {
          // No fabricated metadata: treat non-upstream failures as informational.
          doc.review_cursor.last_error = null;
        }

        if (terminal) {
          terminalizeGrokField(doc, "reviews", "exhausted");
        }

        changed = true;
      }
    }

    const logoRetryable = !isRealValue("logo", doc.logo_url, doc) && !isTerminalMissingField(doc, "logo");

    // Logo is handled by import-start, but we still track attempts here so it can terminalize.
    if (logoRetryable && shouldRunField("logo")) {
      const bumped = bumpFieldAttempt(doc, "logo", requestId);
      if (bumped) changed = true;

      if (attemptsFor(doc, "logo") >= MAX_ATTEMPTS_LOGO) {
        terminalizeNonGrokField(doc, "logo", "not_found_terminal");
        changed = true;
      }
    }

    if (changed) {
      // Recompute missing fields to keep doc consistent with required-fields logic
      doc.import_missing_fields = computeMissingFields(doc);
      doc.updated_at = nowIso();
      await upsertDoc(container, doc).catch(() => null);
    }

    // Hard clamp to avoid spending whole deadline here
    if (Date.now() - startedEnrichmentAt > Math.max(0, deadlineMs - 1500)) break;
  }

  const buildSeedCompanyPayload = (d) => {
    const company_name = String(d?.company_name || d?.name || "").trim();
    const website_url = String(d?.website_url || d?.url || "").trim();
    const normalized_domain = String(d?.normalized_domain || "").trim();
    if (!company_name && !website_url) return null;

    return {
      id: d.id,
      company_name,
      website_url,
      url: String(d?.url || website_url).trim(),
      normalized_domain,
      industries: Array.isArray(d?.industries) ? d.industries : [],
      product_keywords: typeof d?.product_keywords === "string" ? d.product_keywords : "",
      keywords: Array.isArray(d?.keywords) ? d.keywords : [],
      headquarters_location: typeof d?.headquarters_location === "string" ? d.headquarters_location : d?.headquarters_location || "",
      manufacturing_locations: Array.isArray(d?.manufacturing_locations) ? d.manufacturing_locations : [],
      curated_reviews: Array.isArray(d?.curated_reviews) ? d.curated_reviews : [],
      review_count: typeof d?.review_count === "number" ? d.review_count : 0,
      review_cursor: d?.review_cursor && typeof d.review_cursor === "object" ? d.review_cursor : undefined,
      red_flag: Boolean(d?.red_flag),
      red_flag_reason: String(d?.red_flag_reason || "").trim(),
      hq_unknown: Boolean(d?.hq_unknown),
      hq_unknown_reason: String(d?.hq_unknown_reason || "").trim(),
      mfg_unknown: Boolean(d?.mfg_unknown),
      mfg_unknown_reason: String(d?.mfg_unknown_reason || "").trim(),
      source: String(d?.source || "").trim(),
      source_stage: String(d?.source_stage || "").trim(),
      seed_ready: Boolean(d?.seed_ready),
      primary_candidate: Boolean(d?.primary_candidate),
      seed: Boolean(d?.seed),
    };
  };

  const request = sessionDoc?.request && typeof sessionDoc.request === "object" ? sessionDoc.request : {};

  const initialMissing = seedDocs.length === 1 && seedDocs[0] ? computeRetryableMissingFields(seedDocs[0]) : [];
  const forceStages =
    seedDocs.length === 1 &&
    initialMissing.some(
      (f) => f === "industries" || f === "headquarters_location" || f === "manufacturing_locations" || f === "reviews"
    );

  // Fast path: for single-company company_url imports, avoid repeatedly calling import-start/XAI
  // once we've already tried enough times to conclude industries are not recoverable.
  // IMPORTANT: do NOT terminalize HQ/MFG/Reviews here — those are still handled via Grok-only live search.
  if (forceStages && seedDocs.length === 1 && seedDocs[0]) {
    const doc = seedDocs[0];
    const retryableMissing = computeRetryableMissingFields(doc);

    if (retryableMissing.includes("industries")) {
      const attemptsObj =
        doc.import_low_quality_attempts && typeof doc.import_low_quality_attempts === "object" && !Array.isArray(doc.import_low_quality_attempts)
          ? { ...doc.import_low_quality_attempts }
          : {};

      const reasonsObj =
        doc.import_missing_reason && typeof doc.import_missing_reason === "object" && !Array.isArray(doc.import_missing_reason)
          ? { ...doc.import_missing_reason }
          : {};

      const prevReason = normalizeKey(reasonsObj.industries || "");
      const baseReason = prevReason || "not_found";
      const currentAttempts = Number(attemptsObj.industries) || 0;

      // If the next attempt would hit the cap, terminalize industries in-place and continue.
      if (currentAttempts >= 2) {
        const updatedAt = nowIso();
        attemptsObj.industries = currentAttempts + 1;
        reasonsObj.industries = baseReason === "low_quality" ? "low_quality_terminal" : "not_found_terminal";

        const terminalParts = [];
        terminalParts.push("industries (" + (baseReason === "low_quality" ? "low quality" : "missing") + ")");

        const computedTerminalReason = terminalParts.length
          ? "Enrichment complete (terminal): " + terminalParts.join(", ")
          : "Enrichment complete (terminal)";

        const existingReason = String(doc.red_flag_reason || "").trim();
        const replaceReason = !existingReason || /enrichment pending/i.test(existingReason);

        const nextDoc = {
          ...doc,
          import_missing_reason: reasonsObj,
          import_low_quality_attempts: attemptsObj,
          import_missing_fields: Array.isArray(doc.import_missing_fields) ? doc.import_missing_fields : computeMissingFields(doc),
          red_flag: true,
          red_flag_reason: replaceReason ? computedTerminalReason : existingReason,
          updated_at: updatedAt,
        };

        await upsertDoc(container, nextDoc).catch(() => null);

        const refreshedFinal = await fetchCompaniesByIds(container, [String(doc.id).trim()]).catch(() => []);
        if (Array.isArray(refreshedFinal) && refreshedFinal.length > 0) seedDocs = refreshedFinal;
      }
    }
  }

  // Resume behavior: call /api/import/start once, skipping only what is already satisfied.
  const missingUnion = new Set();
  for (const doc of seedDocs) {
    for (const field of computeRetryableMissingFields(doc)) missingUnion.add(field);
  }

  const needsKeywords = missingUnion.has("industries") || missingUnion.has("product_keywords");

  const skipStages = new Set(["primary", "expand"]);
  if (!needsKeywords) skipStages.add("keywords");

  // IMPORTANT: HQ/MFG/Reviews are Grok-only. Never let import-start handle these stages.
  skipStages.add("reviews");
  skipStages.add("location");

  const base = new URL(req.url);
  const startUrlBase = new URL("/api/import/start", base.origin);
  startUrlBase.searchParams.set("resume_worker", "1");
  startUrlBase.searchParams.set("deadline_ms", String(deadlineMs));
  if (skipStages.size > 0) {
    startUrlBase.searchParams.set("skip_stages", Array.from(skipStages).join(","));
  }

  // IMPORTANT: We invoke import-start directly in-process to avoid an internal HTTP round-trip.
  const startRequest = buildInternalFetchRequest({ job_kind: "import_resume" });

  const invokeImportStartDirect = async (startBody, urlOverride) => {
    const { handler: importStartHandler } = require("../../import-start/index.js");

    const hdrs = new Headers();
    for (const [k, v] of Object.entries(startRequest.headers || {})) {
      if (v === undefined || v === null) continue;
      hdrs.set(k, String(v));
    }

    const internalReq = {
      method: "POST",
      url: String(urlOverride || startUrlBase).toString(),
      headers: hdrs,
      json: async () => startBody,
      text: async () => JSON.stringify(startBody),
    };

    return await importStartHandler(internalReq, context);
  };

  const startTime = Date.now();
  const maxIterations = 1;

  let iteration = 0;
  let lastStartRes = null;
  let lastStartText = "";
  let lastStartJson = null;
  let lastStartHttpStatus = 0;
  let lastStartOk = false;

  let lastImportStartRequestPayload = null;
  let lastImportStartRequestUrl = null;
  let lastImportStartResponse = null;
  let last_error_details = null;

  let missing_by_company = [];

  while (iteration < maxIterations) {
    const companies = seedDocs.map(buildSeedCompanyPayload).filter(Boolean);

    if (companies.length === 0) {
      await upsertDoc(container, {
        ...resumeDoc,
        status: "error",
        last_error: { code: "missing_seed_companies", message: "No saved company docs found for session" },
        lock_expires_at: null,
        updated_at: nowIso(),
      }).catch(() => null);

      did_work = false;
      did_work_reason = "missing_seed_companies";

      return json(
        {
          ok: false,
          session_id: sessionId,
          handler_entered_at,
          did_work,
          did_work_reason,
          root_cause: "missing_seed_companies",
          retryable: true,
        },
        200,
        req
      );
    }

    const startBody = {
      session_id: sessionId,
      query: String(request?.query || "resume").trim() || "resume",
      queryTypes: Array.isArray(request?.queryTypes) ? request.queryTypes : [String(request?.queryType || "product_keyword")],
      location: typeof request?.location === "string" && request.location.trim() ? request.location.trim() : undefined,
      limit: Number.isFinite(Number(request?.limit)) ? Number(request.limit) : Math.min(batchLimit, companies.length),
      expand_if_few: true,
      dry_run: false,
      companies,
    };

    const urlForThisPass = startUrlBase;

    lastImportStartRequestPayload = startBody;
    lastImportStartRequestUrl = String(urlForThisPass);

    try {
      lastStartRes = await invokeImportStartDirect(startBody, urlForThisPass);
      if (lastStartRes?.body && typeof lastStartRes.body === "string") lastStartText = lastStartRes.body;
      else if (lastStartRes?.body && typeof lastStartRes.body === "object") lastStartText = JSON.stringify(lastStartRes.body);
      else lastStartText = "";

      try {
        lastStartJson = lastStartText ? JSON.parse(lastStartText) : null;
      } catch {
        lastStartJson = null;
      }
    } catch (e) {
      lastStartRes = { ok: false, status: 0, _error: e };
      lastStartText = "";
      lastStartJson = null;
    }

    lastStartHttpStatus = Number(lastStartJson?.http_status || lastStartRes?.status || 0) || 0;
    lastStartOk = Boolean(lastStartJson) ? lastStartJson.ok !== false : false;

    lastImportStartResponse = lastStartJson || (lastStartText ? { text: lastStartText.slice(0, 8000) } : null);

    if (!lastStartOk || lastStartHttpStatus >= 400) {
      const errObj = lastStartJson?.error && typeof lastStartJson.error === "object" ? lastStartJson.error : null;

      const code =
        (typeof errObj?.code === "string" && errObj.code.trim() ? errObj.code.trim() : null) ||
        (typeof lastStartJson?.error_code === "string" && lastStartJson.error_code.trim() ? lastStartJson.error_code.trim() : null) ||
        (typeof lastStartJson?.root_cause === "string" && lastStartJson.root_cause.trim() ? lastStartJson.root_cause.trim() : null) ||
        (typeof lastStartJson?.stage === "string" && lastStartJson.stage.trim() ? `stage_${lastStartJson.stage.trim()}` : null) ||
        (lastStartHttpStatus ? `import_start_http_${lastStartHttpStatus}` : "import_start_failed");

      const message =
        (typeof errObj?.message === "string" && errObj.message.trim() ? errObj.message.trim() : null) ||
        (typeof lastStartJson?.message === "string" && lastStartJson.message.trim() ? lastStartJson.message.trim() : null) ||
        (typeof lastStartJson?.error_message === "string" && lastStartJson.error_message.trim() ? lastStartJson.error_message.trim() : null) ||
        null;

      last_error_details = String(message ? `${code}: ${message}` : code).slice(0, 240);
    }

    // Re-load docs and re-check contract.
    const ids = companies.map((c) => String(c?.id || "").trim()).filter(Boolean).slice(0, 25);
    const refreshed = ids.length > 0 ? await fetchCompaniesByIds(container, ids).catch(() => []) : [];

    const refreshedById = new Map(
      (Array.isArray(refreshed) ? refreshed : []).map((d) => [String(d?.id || "").trim(), d])
    );

    seedDocs = ids.map((id) => refreshedById.get(id)).filter(Boolean);

    missing_by_company = seedDocs
      .map((d) => {
        const missing = computeRetryableMissingFields(d);
        if (missing.length === 0) return null;
        return {
          company_id: String(d?.id || "").trim(),
          company_name: String(d?.company_name || d?.name || "").trim(),
          website_url: String(d?.website_url || d?.url || "").trim(),
          missing_fields: missing,
        };
      })
      .filter(Boolean);

    if (missing_by_company.length === 0) break;

    iteration += 1;
    const elapsed = Date.now() - startTime;
    if (elapsed > Math.max(0, deadlineMs - 1500)) break;
  }

  const updatedAt = nowIso();

  const importStartRequestSummary = lastImportStartRequestPayload && typeof lastImportStartRequestPayload === "object"
    ? {
        session_id: lastImportStartRequestPayload.session_id,
        query: lastImportStartRequestPayload.query,
        queryTypes: Array.isArray(lastImportStartRequestPayload.queryTypes)
          ? lastImportStartRequestPayload.queryTypes
          : null,
        limit: lastImportStartRequestPayload.limit,
        expand_if_few: Boolean(lastImportStartRequestPayload.expand_if_few),
        dry_run: Boolean(lastImportStartRequestPayload.dry_run),
        companies_count: Array.isArray(lastImportStartRequestPayload.companies)
          ? lastImportStartRequestPayload.companies.length
          : 0,
        company_ids: Array.isArray(lastImportStartRequestPayload.companies)
          ? lastImportStartRequestPayload.companies
              .map((c) => String(c?.id || c?.company_id || "").trim())
              .filter(Boolean)
              .slice(0, 25)
          : [],
      }
    : null;

  const importStartDebug = {
    url: lastImportStartRequestUrl,
    request: importStartRequestSummary,
    response: lastImportStartResponse,
    last_error_details,
  };

  let exhausted = false;

  // Terminal behavior: after a full forced pass for a single-company import,
  // if we're still missing core fields, write explicit terminal markers so the session completes cleanly.
  if (forceStages && seedDocs.length === 1 && missing_by_company.length > 0) {
    const shouldExhaust = iteration >= maxIterations || Date.now() - startTime > Math.max(0, deadlineMs - 1500);

    if (shouldExhaust) {
      exhausted = true;
      const doc = seedDocs[0];

      if (doc && typeof doc === "object" && String(doc.id || "").trim()) {
        const missing = computeMissingFields(doc);

        const import_missing_reason =
          doc.import_missing_reason && typeof doc.import_missing_reason === "object"
            ? { ...doc.import_missing_reason }
            : {};

        const patch = {};

        const LOW_QUALITY_MAX_ATTEMPTS = 3;

        if (missing.includes("industries")) {
          const attemptsObj =
            doc.import_low_quality_attempts && typeof doc.import_low_quality_attempts === "object" && !Array.isArray(doc.import_low_quality_attempts)
              ? { ...doc.import_low_quality_attempts }
              : {};

          const prevReason = normalizeKey(import_missing_reason.industries || "");
          const baseReason = prevReason || "not_found";

          const nextAttempts = (Number(attemptsObj.industries) || 0) + 1;
          attemptsObj.industries = nextAttempts;

          doc.import_low_quality_attempts = attemptsObj;

          if (nextAttempts >= LOW_QUALITY_MAX_ATTEMPTS) {
            import_missing_reason.industries = baseReason === "low_quality" ? "low_quality_terminal" : "not_found_terminal";
          } else {
            import_missing_reason.industries = baseReason;
          }
        }

        if (missing.includes("product_keywords")) {
          const attemptsObj =
            doc.import_low_quality_attempts && typeof doc.import_low_quality_attempts === "object" && !Array.isArray(doc.import_low_quality_attempts)
              ? { ...doc.import_low_quality_attempts }
              : {};

          const prevReason = normalizeKey(import_missing_reason.product_keywords || "");
          const baseReason = prevReason || "not_found";

          const nextAttempts = (Number(attemptsObj.product_keywords) || 0) + 1;
          attemptsObj.product_keywords = nextAttempts;

          doc.import_low_quality_attempts = attemptsObj;

          if (nextAttempts >= LOW_QUALITY_MAX_ATTEMPTS) {
            import_missing_reason.product_keywords = baseReason === "low_quality" ? "low_quality_terminal" : "not_found_terminal";
          } else {
            import_missing_reason.product_keywords = baseReason;
          }
        }

        const existingReason = String(doc.red_flag_reason || "").trim();
        const replaceReason = !existingReason || /enrichment pending/i.test(existingReason);

        const terminalParts = [];
        if (missing.includes("industries")) {
          const reason = normalizeKey(import_missing_reason.industries || "");
          terminalParts.push(reason === "low_quality" || reason === "low_quality_terminal" ? "industries (low quality)" : "industries missing");
        }
        if (missing.includes("product_keywords")) {
          const reason = normalizeKey(import_missing_reason.product_keywords || "");
          terminalParts.push(reason === "low_quality" || reason === "low_quality_terminal" ? "keywords (low quality)" : "keywords missing");
        }
        if (missing.includes("logo")) terminalParts.push("logo not found");

        const computedTerminalReason = terminalParts.length
          ? `Enrichment complete (terminal): ${terminalParts.join(", ")}`
          : "Enrichment complete (terminal)";

        const next = {
          ...doc,
          ...patch,
          import_missing_reason,
          import_missing_fields: missing,
          red_flag: Boolean(doc.red_flag) || missing.some((f) => f === "industries" || f === "product_keywords"),
          red_flag_reason: replaceReason ? computedTerminalReason : existingReason,
          resume_exhausted: true,
          updated_at: updatedAt,
        };

        await upsertDoc(container, next).catch(() => null);

        const refreshedFinal = await fetchCompaniesByIds(container, [String(doc.id).trim()]).catch(() => []);
        if (Array.isArray(refreshedFinal) && refreshedFinal.length > 0) {
          seedDocs = refreshedFinal;
          missing_by_company = seedDocs
            .map((d) => {
              const missing = computeRetryableMissingFields(d);
              if (missing.length === 0) return null;
              return {
                company_id: String(d?.id || "").trim(),
                company_name: String(d?.company_name || d?.name || "").trim(),
                website_url: String(d?.website_url || d?.url || "").trim(),
                missing_fields: missing,
              };
            })
            .filter(Boolean);
        }
      }
    }
  }

  const docsById = new Map(
    (Array.isArray(seedDocs) ? seedDocs : [])
      .map((d) => [String(d?.id || "").trim(), d])
      .filter((pair) => Boolean(pair[0]))
  );

  let totalMissing = 0;
  let totalRetryableMissing = 0;
  let totalTerminalMissing = 0;

  for (const entry of missing_by_company) {
    const doc = docsById.get(String(entry?.company_id || "").trim());
    if (!doc) continue;

    const missing = Array.isArray(doc?.import_missing_fields)
      ? doc.import_missing_fields
      : Array.isArray(entry?.missing_fields)
        ? entry.missing_fields
        : [];

    const reasons = doc?.import_missing_reason && typeof doc.import_missing_reason === "object" && !Array.isArray(doc.import_missing_reason)
      ? doc.import_missing_reason
      : {};

    const retryableMissing = missing.filter((f) => {
      const reason = deriveMissingReason(doc, f) || normalizeKey(reasons[f] || "");
      return !isTerminalMissingReason(reason);
    });

    const retryableMissingCount = retryableMissing.length;
    const terminalMissingCount = missing.length - retryableMissingCount;

    totalMissing += missing.length;
    totalRetryableMissing += retryableMissingCount;
    totalTerminalMissing += terminalMissingCount;
  }

  const retryableMissingCount = totalRetryableMissing;
  const terminalMissingCount = totalTerminalMissing;

  const terminalOnly = retryableMissingCount === 0;

  const completion_beacon = terminalOnly ? "complete" : exhausted ? "enrichment_exhausted" : "enrichment_complete";

  // Resume-needed is ONLY retryable based.
  const resumeNeeded = retryableMissingCount > 0;

  const planned_fields = Array.from(plannedFieldsThisRun.values());
  const planned_fields_reason =
    planned_fields.length > 0
      ? "planned"
      : plannedFieldsSkipped.length > 0
        ? String(plannedFieldsSkipped[0]?.reason || "planner_no_actionable_fields")
        : null;

  // Invariant: if we still have retryable missing fields, this invocation must have made at least one
  // real attempt (bumped import_attempts.*). Otherwise, we mark the resume as blocked to prevent no-op loops.
  const attemptedFieldsThisRun = (() => {
    const attempted = new Set();
    const docs = Array.isArray(seedDocs) ? seedDocs : [];
    const metaFields = [
      "industries",
      "product_keywords",
      "tagline",
      "headquarters_location",
      "manufacturing_locations",
      "reviews",
      "logo",
    ];

    for (const doc of docs) {
      const meta = doc?.import_attempts_meta && typeof doc.import_attempts_meta === "object" ? doc.import_attempts_meta : null;
      if (!meta) continue;
      for (const field of metaFields) {
        if (meta[field] === requestId) attempted.add(field);
      }
    }

    return Array.from(attempted.values());
  })();

  const noAttemptsThisRun = attemptedFieldsThisRun.length === 0;
  const plannerHadActionableFields = planned_fields.length > 0;

  // Block ONLY when we expected to attempt fields (planner scheduled work) but we recorded zero attempts.
  // If the planner scheduled zero actionable fields (budget/deadline/terminalization), that still counts as progress
  // and must not be surfaced as a misleading blocked state.
  if (resumeNeeded && noAttemptsThisRun && plannerHadActionableFields) {
    const blockedAt = updatedAt;
    const errorCode = "resume_no_progress_no_attempts";

    await upsertDoc(container, {
      ...resumeDoc,
      status: "blocked",
      resume_error: errorCode,
      resume_error_details: {
        blocked_at: blockedAt,
        request_id: requestId,
        missing_by_company,
        planned_fields,
        planned_fields_reason,
        planned_fields_detail: plannedFieldsSkipped.slice(0, 10),
        note: "No import_attempts were bumped during this invocation",
      },
      last_error: {
        code: errorCode,
        message: "Resume blocked: no progress/no attempts",
        blocked_at: blockedAt,
      },
      last_finished_at: blockedAt,
      last_ok: true,
      last_result: "resume_blocked_no_attempts",
      lock_expires_at: null,
      updated_at: blockedAt,
    }).catch(() => null);

    await bestEffortPatchSessionDoc({
      container,
      sessionId,
      patch: {
        resume_needed: true,
        resume_error: errorCode,
        resume_error_details: {
          blocked_at: blockedAt,
          request_id: requestId,
          missing_by_company,
          planned_fields,
          planned_fields_reason,
          planned_fields_detail: plannedFieldsSkipped.slice(0, 10),
          note: "No import_attempts were bumped during this invocation",
        },
        stage_beacon: "enrichment_resume_blocked",
        updated_at: blockedAt,
      },
    }).catch(() => null);

    return json(
      {
        ok: true,
        session_id: sessionId,
        handler_entered_at,
        did_work: true,
        did_work_reason: "resume_blocked_no_attempts",
        resume_needed: true,
        missing_by_company,
        attempted_fields: attemptedFieldsThisRun,
        planned_fields,
        planned_fields_reason,
        stage_beacon: "enrichment_resume_blocked",
      },
      200,
      req
    );
  }

  const grokErrors = Array.isArray(workerErrors) ? workerErrors : [];
  const grokErrorSummary = grokErrors.length
    ? {
        code: "grok_enrichment_error",
        message: String(grokErrors[0]?.message || "grok enrichment error").slice(0, 240),
        fields: Array.from(new Set(grokErrors.map((e) => e?.field).filter(Boolean))).slice(0, 20),
        last_error: grokErrors[0],
        errors: grokErrors.slice(0, 5),
      }
    : null;

  const plannerNoActionableFields = Boolean(resumeNeeded && noAttemptsThisRun && !plannerHadActionableFields);

  const derivedResult = (() => {
    if (plannerNoActionableFields) return "resume_planner_no_actionable_fields";
    if (grokErrorSummary) return resumeNeeded ? "grok_error_incomplete" : "grok_error_complete";
    if (lastStartOk) return resumeNeeded ? "ok_incomplete" : "ok_complete";
    const toToken = (value) => {
      const raw = normalizeKey(value);
      const token = raw.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      return token || "";
    };

    const errObj = lastStartJson?.error && typeof lastStartJson.error === "object" ? lastStartJson.error : null;

    const rootRaw =
      (typeof lastStartJson?.root_cause === "string" && lastStartJson.root_cause.trim() ? lastStartJson.root_cause.trim() : "") ||
      (typeof errObj?.code === "string" && errObj.code.trim() ? errObj.code.trim() : "") ||
      (typeof lastStartJson?.error_code === "string" && lastStartJson.error_code.trim() ? lastStartJson.error_code.trim() : "") ||
      (typeof lastStartJson?.stage === "string" && lastStartJson.stage.trim() ? `stage_${lastStartJson.stage.trim()}` : "") ||
      "import_start_failed";

    const root = toToken(rootRaw) || "import_start_failed";
    const status = lastStartHttpStatus || (Number(lastStartRes?.status || 0) || 0);
    return status ? `${root}_http_${status}` : root;
  })();

  await upsertDoc(container, {
    ...resumeDoc,
    handler_entered_at,
    planned_fields,
    planned_fields_reason,
    planned_fields_detail: plannedFieldsSkipped.slice(0, 10),
    attempted_fields: attemptedFieldsThisRun,
    attempted_fields_request_id: requestId,
    last_field_attempted: attemptedFieldsThisRun.length > 0 ? attemptedFieldsThisRun[0] : null,
    last_field_result: derivedResult,
    upstream_calls_made: upstreamCallsMade,
    upstream_calls_made_this_run: upstreamCallsMadeThisRun,
    status: resumeNeeded ? (lastStartOk ? "queued" : "error") : "complete",
    last_finished_at: updatedAt,
    last_ok: Boolean(lastStartOk) && !grokErrorSummary,
    last_result: derivedResult,
    last_error: grokErrorSummary || null,
    missing_by_company,
    last_trigger_result: {
      ok: Boolean(lastStartOk),
      status: lastStartHttpStatus || (Number(lastStartRes?.status || 0) || 0),
      stage_beacon: resumeNeeded
        ? plannerNoActionableFields
          ? "resume_planner_no_actionable_fields"
          : lastStartJson?.stage_beacon || null
        : completion_beacon,
      resume_needed: resumeNeeded,
      planned_fields,
      planned_fields_reason,
      planned_fields_detail: plannedFieldsSkipped.slice(0, 10),
      iterations: iteration + 1,
      resume_control_doc_upsert_ok: resume_control_doc_upsert_ok,
      ...(lastStartHttpStatus === 400 || !lastStartOk ? { import_start_debug: importStartDebug } : {}),
    },
    lock_expires_at: null,
    updated_at: updatedAt,
  }).catch(() => null);

  await bestEffortPatchSessionDoc({
    container,
    sessionId,
    patch: {
      resume_needed: resumeNeeded,
      resume: {
        status: resumeNeeded ? (lastStartOk ? "queued" : "error") : "complete",
        updated_at: updatedAt,
        planned_fields,
        planned_fields_reason,
        attempted_fields: attemptedFieldsThisRun,
        last_field_attempted: attemptedFieldsThisRun.length > 0 ? attemptedFieldsThisRun[0] : null,
        last_field_result: derivedResult,
      },
      resume_updated_at: updatedAt,
      ...(resumeNeeded
        ? {}
        : {
            status: "complete",
            stage_beacon: completion_beacon,
            ...(exhausted ? { resume_exhausted: true } : {}),
            completed_at: updatedAt,
          }),
      updated_at: updatedAt,
    },
  }).catch(() => null);

  // Lightweight telemetry on the session control doc.
  if (sessionDoc && typeof sessionDoc === "object") {
    const invokedAt = String(resumeDoc?.last_invoked_at || "").trim() || updatedAt;

    const companyIdFromResponse = Array.isArray(lastStartJson?.saved_company_ids_verified) && lastStartJson.saved_company_ids_verified[0]
      ? String(lastStartJson.saved_company_ids_verified[0]).trim()
      : Array.isArray(lastStartJson?.saved_company_ids) && lastStartJson.saved_company_ids[0]
        ? String(lastStartJson.saved_company_ids[0]).trim()
        : seedDocs && seedDocs[0] && seedDocs[0].id
          ? String(seedDocs[0].id).trim()
          : null;

    // grokErrorSummary + derivedResult computed above (used for both resume + session heartbeat).

    await upsertDoc(container, {
      ...sessionDoc,
      resume_worker_upstream_calls_made: upstreamCallsMade,
      resume_worker_upstream_calls_made_this_run: upstreamCallsMadeThisRun,
      resume_worker_last_invoked_at: invokedAt,
      resume_worker_last_finished_at: updatedAt,
      resume_worker_last_result: derivedResult,
      resume_worker_last_ok: Boolean(lastStartOk) && !grokErrorSummary,
      resume_worker_last_http_status: lastStartHttpStatus || (Number(lastStartRes?.status || 0) || 0),
      resume_worker_last_error: grokErrorSummary
        ? grokErrorSummary.code
        : lastStartOk
          ? null
          : lastStartRes?._error?.message || `import_start_http_${lastStartHttpStatus || (Number(lastStartRes?.status || 0) || 0)}`,
      resume_worker_last_error_details: grokErrorSummary ? grokErrorSummary : last_error_details || null,
      resume_worker_last_stage_beacon: plannerNoActionableFields
        ? "resume_planner_no_actionable_fields"
        : lastStartJson?.stage_beacon || null,
      resume_worker_planned_fields: planned_fields,
      resume_worker_planned_fields_reason: planned_fields_reason,
      resume_worker_planned_fields_detail: plannedFieldsSkipped.slice(0, 10),
      resume_worker_attempted_fields: attemptedFieldsThisRun,
      resume_worker_attempted_fields_request_id: requestId,
      resume_worker_last_field_attempted: attemptedFieldsThisRun.length > 0 ? attemptedFieldsThisRun[0] : null,
      resume_worker_last_field_result: derivedResult,
      resume_worker_last_resume_needed: resumeNeeded,
      resume_worker_last_company_id: companyIdFromResponse,
      resume_worker_last_resume_doc_upsert_ok: resume_control_doc_upsert_ok,
      ...(lastStartHttpStatus === 400
        ? {
            resume_worker_last_import_start_url: lastImportStartRequestUrl,
            resume_worker_last_import_start_request: importStartRequestSummary,
            resume_worker_last_import_start_response: lastImportStartResponse,
          }
        : {}),
      updated_at: updatedAt,
    }).catch(() => null);
  }

  return json(
    {
      ok: true,
      session_id: sessionId,
      handler_entered_at,
      did_work,
      did_work_reason,
      triggered: true,
      import_start_status: lastStartHttpStatus || (Number(lastStartRes?.status || 0) || 0),
      import_start_ok: Boolean(lastStartOk),
      resume_needed: resumeNeeded,
      iterations: iteration + 1,
      missing_by_company,
      import_attempts_snapshot: seedDocs.slice(0, 5).map((d) => ({
        company_id: d?.id || null,
        normalized_domain: d?.normalized_domain || null,
        import_attempts: d?.import_attempts || {},
        import_missing_reason: d?.import_missing_reason || {},
        import_missing_fields: Array.isArray(d?.import_missing_fields) ? d.import_missing_fields : null,
      })),
      import_start_body: lastStartJson || (lastStartText ? { text: lastStartText.slice(0, 2000) } : null),
    },
    200,
    req
  );
}

async function invokeResumeWorkerInProcess({
  session_id,
  sessionId,
  context,
  workerRequest,
  no_cosmos,
  batch_limit,
  deadline_ms,
  force_terminalize_single,
  forceTerminalizeSingle,
} = {}) {
  const sid = String(session_id || sessionId || "").trim();
  if (!sid) {
    return {
      ok: false,
      status: 0,
      bodyText: "",
      error: new Error("missing_session_id"),
      gateway_key_attached: false,
      request_id: null,
    };
  }

  const reqMeta = workerRequest && typeof workerRequest === "object"
    ? workerRequest
    : buildInternalFetchRequest({ job_kind: "import_resume" });

  const hdrs = new Headers();
  for (const [k, v] of Object.entries(reqMeta.headers || {})) {
    if (v === undefined || v === null) continue;
    hdrs.set(k, String(v));
  }

  const inProcessUrl = new URL("https://in-process.local/api/import/resume-worker");
  inProcessUrl.searchParams.set("session_id", sid);
  if (no_cosmos) inProcessUrl.searchParams.set("no_cosmos", "1");
  if (batch_limit != null) inProcessUrl.searchParams.set("batch_limit", String(batch_limit));
  if (deadline_ms != null) inProcessUrl.searchParams.set("deadline_ms", String(deadline_ms));
  if (force_terminalize_single || forceTerminalizeSingle) inProcessUrl.searchParams.set("force_terminalize_single", "1");

  const body = {
    session_id: sid,
    ...(reqMeta?.body && typeof reqMeta.body === "object" && !Array.isArray(reqMeta.body) ? reqMeta.body : {}),
    ...(batch_limit != null ? { batch_limit } : {}),
    ...(deadline_ms != null ? { deadline_ms } : {}),
    ...(force_terminalize_single || forceTerminalizeSingle ? { force_terminalize_single: "1" } : {}),
  };

  const internalReq = {
    method: "POST",
    url: inProcessUrl.toString(),
    headers: hdrs,
    __in_process: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };

  let res;
  try {
    res = await resumeWorkerHandler(internalReq, context);
  } catch (e) {
    return {
      ok: false,
      status: 0,
      bodyText: "",
      error: e,
      gateway_key_attached: Boolean(reqMeta.gateway_key_attached),
      request_id: reqMeta.request_id || null,
    };
  }

  const status = Number(res?.status || 0) || 0;
  const ok = status >= 200 && status < 300;
  const bodyText =
    typeof res?.body === "string" ? res.body : res?.body != null ? JSON.stringify(res.body) : "";

  return {
    ok,
    status,
    bodyText,
    error: res?._error || null,
    gateway_key_attached: Boolean(reqMeta.gateway_key_attached),
    request_id: reqMeta.request_id || null,
  };
}

module.exports = {
  resumeWorkerHandler,
  invokeResumeWorkerInProcess,
  _test: {
    resumeWorkerHandler,
    invokeResumeWorkerInProcess,
  },
};
