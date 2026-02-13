let app;
try {
  ({ app } = require("../_app"));
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
let randomUUID;
let createHash;
try {
  ({ randomUUID, createHash } = require("crypto"));
} catch {
  randomUUID = null;
  createHash = null;
}
const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
  getValueAtPath,
} = require("../_cosmosPartitionKey");
const { getXAIEndpoint, getXAIKey, getResolvedUpstreamMeta } = require("../_shared");
const { startBudget } = require("../_budget");
const { patchCompanyWithSearchText } = require("../_computeSearchText");
const { geocodeLocationArray, pickPrimaryLatLng } = require("../_geocode");
const {
  validateCuratedReviewCandidate,
  checkUrlHealthAndFetchText,
} = require("../_reviewQuality");
const { fillCompanyBaselineFromWebsite } = require("../_websiteBaseline");
const {
  fetchCuratedReviews: fetchCuratedReviewsGrok,
  fetchHeadquartersLocation: fetchHeadquartersLocationGrok,
  fetchManufacturingLocations: fetchManufacturingLocationsGrok,
  fetchTagline: fetchTaglineGrok,
  fetchIndustries: fetchIndustriesGrok,
  fetchProductKeywords: fetchProductKeywordsGrok,
  enrichCompanyFields: enrichCompanyFieldsUnified,
} = require("../_grokEnrichment");
const { computeProfileCompleteness } = require("../_profileCompleteness");
const { mergeCompanyDocsForSession: mergeCompanyDocsForSessionExternal } = require("../_companyDocMerge");
const { applyEnrichment } = require("../_applyEnrichment");
const {
  asMeaningfulString,
  normalizeStringArray,
  isRealValue,
  sanitizeIndustries,
  sanitizeKeywords,
} = require("../_requiredFields");
const { resolveReviewsStarState } = require("../_reviewsStarState");
const { getBuildInfo } = require("../_buildInfo");
const { getImportStartHandlerVersion } = require("../_handlerVersions");
const { upsertSession: upsertImportSession } = require("../_importSessionStore");
const {
  buildInternalFetchHeaders,
  buildInternalFetchRequest,
  getInternalJobSecretInfo,
  getAcceptableInternalSecretsInfo,
} = require("../_internalJobAuth");

const { enqueueResumeRun, resolveQueueConfig } = require("../_enrichmentQueue");

// IMPORTANT: pure handler module only (no app.http registrations). Loaded at cold start.
const { invokeResumeWorkerInProcess } = require("../import/resume-worker/handler");

// Direct enrichment orchestrator (no queue dependency)
const { runDirectEnrichment, applyEnrichmentToCompany, getMissingFields } = require("../_directEnrichment");

// Consolidated xAI response format handling
const {
  isResponsesEndpoint: isXaiResponsesEndpoint,
  extractTextFromXaiResponse: extractXaiResponseTextShared,
  buildXaiPayload,
  parseJsonFromResponse,
} = require("../_xaiResponseFormat");

const {
  buildPrimaryJobId: buildImportPrimaryJobId,
  getJob: getImportPrimaryJob,
  upsertJob: upsertImportPrimaryJob,
} = require("../_importPrimaryJobStore");

// â”€â”€ Extracted module: pure company/review utilities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const {
  normalizeIndustries,
  toBrandTokenFromWebsiteUrl,
  normalizeKeywordList,
  normalizeProductKeywords,
  keywordListToString,
  safeNum,
  safeCenter,
  toFiniteNumber,
  toNormalizedDomain,
  enrichCompany,
  normalizeLocationEntries,
  buildImportLocations,
  normalizeUrlForCompare,
  computeReviewDedupeKey,
  dedupeCuratedReviews,
  buildReviewCursor,
  isMeaningfulString: _isMeaningfulString,
  hasMeaningfulSeedEnrichment: _hasMeaningfulSeedEnrichment,
  isValidSeedCompany: _isValidSeedCompany,
  computeEnrichmentMissingFields,
  applyLowQualityPolicy: applyLowQualityPolicyCore,
  pushMissingFieldEntry,
} = require("./_importStartCompanyUtils");

// ── Extracted module: request/body parsing, URL utilities, xAI helpers ────────
const {
  XAI_SYSTEM_PROMPT,
  isResponsesEndpoint,
  convertToResponsesPayload,
  extractXaiResponseText,
  AcceptedResponseError,
  logImportStartMeta,
  safeJsonParse,
  InvalidJsonBodyError,
  isBinaryBody,
  binaryBodyToString,
  parseJsonBodyStrict,
  sanitizeTextPreview,
  toTextPreview,
  buildFirstBytesPreview,
  buildHexPreview,
  readQueryParam,
  getBodyType,
  getBodyLen,
  getBodyKeysPreview,
  isProbablyStreamBody,
  parseJsonFromStringOrBinary,
  toBufferChunk,
  readStreamLikeToBuffer,
  parseJsonFromStreamLike,
  isJsonContentType,
  readJsonBody,
  toErrorString,
  getHeader,
  isDebugDiagnosticsEnabled,
  buildBodyDiagnostics,
  buildRequestDetails,
  generateRequestId,
  makeErrorId,
  toStackFirstLine,
  logImportStartErrorLine,
  extractXaiRequestId,
  tryParseUrl,
  looksLikeCompanyUrlQuery,
  isAzureWebsitesUrl,
  joinUrlPath,
  toHostPathOnlyForLog,
  redactUrlQueryAndHash,
  getHostPathFromUrl,
  buildUpstreamResolutionSnapshot,
  buildXaiExecutionPlan,
  resolveXaiEndpointForModel,
  safeParseJsonObject,
  buildXaiPayloadMetaSnapshotFromOutboundBody,
  ensureValidOutboundXaiBodyOrThrow,
  postJsonWithTimeout,
  isProxyExplicitlyDisabled,
  isProxyExplicitlyEnabled,
  buildSaveReport,
} = require("./_importStartRequestUtils");

// ── Extracted module: Cosmos DB operations ────────────────────────────────────
const {
  getCompaniesCosmosContainer,
  getCompaniesPartitionKeyPath,
  redactHostForDiagnostics,
  getCompaniesCosmosTargetDiagnostics,
  verifySavedCompaniesReadAfterWrite,
  applyReadAfterWriteVerification,
  readItemWithPkCandidates,
  upsertItemWithPkCandidates,
  buildImportControlDocBase,
  upsertResumeDoc,
  logInfo,
  upsertCosmosImportSessionDoc,
  checkIfSessionStopped,
} = require("./_importStartCosmos");
const { getCosmosConfig } = require("../_cosmosConfig");

// ── Extracted module: inline enrichment (keywords, industries, tagline) ────
const {
  mapWithConcurrency: _mapWithConcurrency,
  ensureCompanyKeywords: _ensureCompanyKeywordsBase,
} = require("./_importStartInlineEnrichment");

// ── Extracted module: XAI request pipeline ───────────────────────────────────
const {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  STAGE_MAX_MS,
  MIN_STAGE_REMAINING_MS,
  DEADLINE_SAFETY_BUFFER_MS,
  UPSTREAM_TIMEOUT_MARGIN_MS,
  postXaiJsonWithBudget: _postXaiJsonWithBudget,
  postXaiJsonWithBudgetRetry: _postXaiJsonWithBudgetRetry,
  ensureStageBudgetOrThrow: _ensureStageBudgetOrThrow,
  sleep,
  shouldRetryUpstreamStatus,
} = require("./_importStartXaiRequest");

// ── Extracted module: save-companies, geocoding, logo fetch ──────────────────
const {
  saveCompaniesToCosmos,
  geocodeCompanyLocations,
  geocodeHQLocation,
  findExistingCompany,
  fetchLogo,
} = require("./_importStartSaveCompanies");

// ── Extracted module: enrichment orchestration + editorial reviews ─────────────
const {
  MANDATORY_ENRICH_FIELDS,
  buildReviewsUpstreamPayloadForImportStart,
  fetchEditorialReviews,
  maybeQueueAndInvokeMandatoryEnrichment,
} = require("./_importStartEnrichment");

const __importStartModuleBuildInfo = (() => {
  try {
    return getBuildInfo();
  } catch {
    return { build_id: "unknown" };
  }
})();

const __importStartModuleHandlerVersion = (() => {
  try {
    return getImportStartHandlerVersion(__importStartModuleBuildInfo);
  } catch {
    return "unknown";
  }
})();

try {
  console.log("[import-start] module_loaded", {
    handler_version: __importStartModuleHandlerVersion,
    build_id: String(__importStartModuleBuildInfo?.build_id || "unknown"),
  });
} catch {}

// SWA-safe timeout for external (browserâ†’SWAâ†’Function) calls.
// The Azure SWA reverse-proxy kills connections after ~30-50 seconds with a
// "Backend call failure" 500 and empty headers, BEFORE the Function returns.
// We set the budget to 8 seconds so import-start returns `accepted` quickly
// and enqueues the heavy XAI work via primary-worker.  Polling handles the rest.
// Internal calls (resume-worker, primary-worker) bypass SWA and set their own
// budgets via the `deadline_ms` query parameter, which overrides this default.
const DEFAULT_HARD_TIMEOUT_MS = 8_000;

// Constants imported from _importStartXaiRequest.js:
// DEFAULT_UPSTREAM_TIMEOUT_MS, STAGE_MAX_MS, MIN_STAGE_REMAINING_MS,
// DEADLINE_SAFETY_BUFFER_MS, UPSTREAM_TIMEOUT_MARGIN_MS

const GROK_ONLY_FIELDS = new Set([
  "headquarters_location",
  "manufacturing_locations",
  "reviews",
]);

// MANDATORY_ENRICH_FIELDS moved to ./_importStartEnrichment.js

function assertNoWebsiteFallback(field) {
  if (GROK_ONLY_FIELDS.has(field)) return true;
  return false;
}

if (!globalThis.__importStartProcessHandlersInstalled) {
  globalThis.__importStartProcessHandlersInstalled = true;

  process.on("unhandledRejection", (reason) => {
    try {
      const msg = reason?.stack || reason?.message || String(reason);
      console.error("[import-start] unhandledRejection:", msg);
    } catch {
      console.error("[import-start] unhandledRejection");
    }
  });

  process.on("uncaughtException", (err) => {
    try {
      const msg = err?.stack || err?.message || String(err);
      console.error("[import-start] uncaughtException:", msg);
    } catch {
      console.error("[import-start] uncaughtException");
    }
  });
}

const HANDLER_ID = "import-start";

function json(obj, status = 200, extraHeaders) {
  const payload = obj && typeof obj === "object" && !Array.isArray(obj)
    ? { ...obj, build_id: obj.build_id || String(__importStartModuleBuildInfo?.build_id || "") }
    : obj;

  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id,x-tabarnam-internal,x-internal-secret,x-internal-job-secret,x-job-kind",
      "Access-Control-Expose-Headers": "x-request-id,x-correlation-id,x-session-id,X-Api-Handler,X-Api-Build-Id",
      "X-Api-Handler": HANDLER_ID,
      "X-Api-Build-Id": String(__importStartModuleBuildInfo?.build_id || ""),
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
    },
    body: JSON.stringify(payload),
  };
}

function buildCounts({ enriched, debugOutput }) {
  const candidates_found = Array.isArray(enriched) ? enriched.length : 0;

  const keywords_generated = Array.isArray(debugOutput?.keywords_debug)
    ? debugOutput.keywords_debug.reduce((sum, k) => sum + (Number(k?.generated_count) || 0), 0)
    : 0;

  let reviews_valid = 0;
  let reviews_rejected = 0;

  if (Array.isArray(debugOutput?.reviews_debug)) {
    for (const entry of debugOutput.reviews_debug) {
      const candidates = Array.isArray(entry?.candidates) ? entry.candidates : [];
      for (const c of candidates) {
        if (c?.is_valid === true) reviews_valid += 1;
        else reviews_rejected += 1;
      }
    }
  }

  return {
    candidates_found,
    reviews_valid,
    reviews_rejected,
    keywords_generated,
  };
}


// buildReviewsUpstreamPayloadForImportStart, fetchEditorialReviews, maybeQueueAndInvokeMandatoryEnrichment
// moved to ./_importStartEnrichment.js

// ── REMOVED: fetchEditorialReviews (was here) ──
// Placeholder marker kept so line-level git blame stays readable.
// Original signature:
// async function fetchEditorialReviews(company, xaiUrl, xaiKey, timeout, debugCollector, stageCtx, warn) {


// Max time to spend processing (5 minutes)
const MAX_PROCESSING_TIME_MS = 5 * 60 * 1000;

const importStartHandlerInner = async (req, context) => {
    const requestId = generateRequestId(req);
    const responseHeaders = { "x-request-id": requestId };

    const buildInfo = getBuildInfo();
    const handlerVersion = getImportStartHandlerVersion(buildInfo);

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

    // internal_auth_configured should be true if ANY accepted secret exists
    // (e.g. X_INTERNAL_JOB_SECRET OR FUNCTION_KEY), not only when the secret source is X_INTERNAL_JOB_SECRET.
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

    const jsonWithRequestId = (obj, status = 200) => {
      const payload =
        obj && typeof obj === "object" && !Array.isArray(obj)
          ? { handler_version: handlerVersion, ...obj }
          : { handler_version: handlerVersion, value: obj };

      if (typeof sessionId === "string" && sessionId.trim()) {
        if (!Object.prototype.hasOwnProperty.call(payload, "session_id")) {
          payload.session_id = sessionId;
        }
        responseHeaders["x-session-id"] = sessionId;
      }

      if (sessionIdOverride && typeof sessionIdOriginal === "string") {
        payload.session_id_override = true;
        payload.session_id_original = sessionIdOriginal;
        payload.session_id_canonical = sessionId;
      }

      return json(payload, status, responseHeaders);
    };

    const diagnosticsEnabled = isDebugDiagnosticsEnabled(req);
    const stageTrace = [{ stage: "init", ts: new Date().toISOString() }];
    const contextInfo = {
      company_name: "",
      website_url: "",
      normalized_domain: "",
      xai_request_id: null,
    };

    let sessionId = "";
    let sessionIdOriginal = "";
    let sessionIdOverride = false;

    let stage = "init";
    let debugEnabled = false;
    let debugOutput = null;
    let enrichedForCounts = [];
    let primaryXaiOutboundBody = "";

    let sessionCreatedAtIso = null;

    // If we successfully write at least one company but a later stage fails,
    // we return 200 with warnings instead of a hard 500.
    let saveReport = null;

    const warningKeys = new Set();
    const warnings_detail = {};
    const warnings_v2 = [];

    const addWarning = (key, detail) => {
      const warningKey = String(key || "").trim();
      if (!warningKey) return;
      warningKeys.add(warningKey);

      const d = detail && typeof detail === "object" ? detail : { message: String(detail || "") };

      if (!warnings_detail[warningKey]) {
        warnings_detail[warningKey] = {
          stage: String(d.stage || warningKey),
          root_cause: String(d.root_cause || "unknown"),
          retryable: typeof d.retryable === "boolean" ? d.retryable : true,
          upstream_status: d.upstream_status ?? null,
          message: String(d.message || "").trim(),
          company_name: d.company_name ? String(d.company_name) : undefined,
          website_url: d.website_url ? String(d.website_url) : undefined,
        };
      }

      warnings_v2.push({
        stage: String(d.stage || ""),
        root_cause: String(d.root_cause || "unknown"),
        retryable: typeof d.retryable === "boolean" ? d.retryable : true,
        upstream_status: d.upstream_status ?? null,
        message: String(d.message || "").trim(),
        company_name: d.company_name ? String(d.company_name) : undefined,
        website_url: d.website_url ? String(d.website_url) : undefined,
      });
    };

    const warnReviews = (detail) => addWarning("reviews_failed", detail);

    let stage_beacon = "init";
    let stage_reached = null;

    const mark = (s) => {
      stage_beacon = String(s || "unknown") || "unknown";

      if (/_done$/.test(stage_beacon)) {
        stage_reached = `after_${stage_beacon.replace(/_done$/, "")}`;
      }

      try {
        upsertImportSession({
          session_id: sessionId,
          request_id: requestId,
          status: "running",
          stage_beacon,
          companies_count: Array.isArray(enrichedForCounts) ? enrichedForCounts.length : 0,
        });
      } catch {}

      try {
        console.log("[import-start] stage", { stage: stage_beacon, request_id: requestId, session_id: sessionId });
      } catch {
        console.log("[import-start] stage", { stage: stage_beacon });
      }
    };

    console.log(`[import-start] request_id=${requestId} Function handler invoked`);

    try {
      const method = String(req.method || "").toUpperCase();
      if (method === "OPTIONS") {
        return {
          status: 200,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers":
              "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id",
            "Access-Control-Expose-Headers": "x-request-id,x-correlation-id,x-session-id",
            ...responseHeaders,
          },
        };
      }

      const pingRaw = readQueryParam(req, "ping");
      if (String(pingRaw || "").trim() === "1") {
        const route = (() => {
          try {
            const rawUrl = typeof req.url === "string" ? req.url : "";
            const pathname = rawUrl ? new URL(rawUrl, "http://localhost").pathname : "";
            const normalized = pathname.replace(/^\/+/, "");
            if (normalized.endsWith("import-start")) return "import-start";
            return "import/start";
          } catch {
            return "import/start";
          }
        })();

        return json(
          {
            ok: true,
            route,
            handler_version: handlerVersion,
            build_id: String(buildInfo?.build_id || "unknown"),
          },
          200,
          responseHeaders
        );
      }

      if (method === "GET") {
        return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405, responseHeaders);
      }

      let payload;
      let body_source = "unknown";
      let body_source_detail = "";
      let raw_text_preview = null;
      let raw_text_starts_with_brace = false;
      let requestDetails = null;

      try {
        const parsed = await readJsonBody(req);
        payload = parsed.body;
        body_source = parsed.body_source || "unknown";
        body_source_detail = parsed.body_source_detail || "";
        raw_text_preview = typeof parsed?.raw_text_preview === "string" ? parsed.raw_text_preview : null;
        raw_text_starts_with_brace = Boolean(parsed?.raw_text_starts_with_brace);
        requestDetails = buildRequestDetails(req, {
          body_source,
          body_source_detail,
          raw_text_preview,
          raw_text_starts_with_brace,
        });
      } catch (err) {
        if (err?.code === "INVALID_JSON_BODY") {
          const rawPreview = String(err?.raw_text_preview || err?.raw_body_preview || "");
          const extractedSessionId = (() => {
            if (!rawPreview) return "";
            const match = rawPreview.match(/"session_id"\s*:\s*"([^"]+)"/);
            return match && match[1] ? String(match[1]) : "";
          })();

          sessionIdOriginal = extractedSessionId;
          const canonicalCandidate = String(extractedSessionId || "").trim();
          if (sessionIdOriginal && canonicalCandidate !== sessionIdOriginal) sessionIdOverride = true;
          sessionId = canonicalCandidate || `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          if (sessionIdOriginal && !canonicalCandidate) sessionIdOverride = true;

          responseHeaders["x-session-id"] = sessionId;

          const buildInfo = getBuildInfo();

          body_source = err?.body_source || "unknown";
          body_source_detail = err?.body_source_detail || "";

          try {
            console.error(
              "[import-start] INVALID_JSON_BODY",
              JSON.stringify({
                request_id: requestId,
                content_type: err?.content_type || getHeader(req, "content-type") || null,
                body_type: err?.body_type || typeof req?.body,
                is_body_object:
                  typeof err?.is_body_object === "boolean"
                    ? err.is_body_object
                    : Boolean(req?.body && typeof req.body === "object" && !Array.isArray(req.body)),
                body_keys_preview: err?.body_keys_preview || getBodyKeysPreview(req?.body),
                body_source,
                body_source_detail,
                raw_text_preview: err?.raw_text_preview || err?.raw_body_preview || null,
                raw_text_hex_preview: err?.raw_text_hex_preview || null,
              })
            );
          } catch {
            console.error("[import-start] INVALID_JSON_BODY");
          }

          const error_id = makeErrorId();
          logImportStartErrorLine({
            error_id,
            stage_beacon: "validate_request",
            root_cause: "invalid_request",
            err,
          });

          return jsonWithRequestId(
            {
              ok: false,
              stage: "validate_request",
              stage_beacon: "validate_request",
              root_cause: "invalid_request",
              retryable: false,
              http_status: 400,
              error_id,
              session_id: sessionId,
              request_id: requestId,
              error: {
                code: "INVALID_JSON_BODY",
                message: "Invalid JSON body",
                request_id: requestId,
                step: "validate_request",
              },
              legacy_error: "Invalid JSON body",
              ...buildInfo,
              company_name: "",
              website_url: "",
              normalized_domain: "",
              xai_request_id: null,
              details: {
                ...buildRequestDetails(req, {
                  body_source,
                  body_source_detail,
                  raw_text_preview: err?.raw_text_preview || err?.raw_body_preview || null,
                  raw_text_starts_with_brace: /^\s*\{/.test(String(err?.raw_text_preview || err?.raw_body_preview || "")),
                }),
                code: "INVALID_JSON_BODY",
                message: "Invalid JSON body",
                body_type: err?.body_type || typeof req?.body,
                is_body_object:
                  typeof err?.is_body_object === "boolean"
                    ? err.is_body_object
                    : Boolean(req?.body && typeof req.body === "object" && !Array.isArray(req.body)),
                raw_text_hex_preview: err?.raw_text_hex_preview || null,

                // Back-compat.
                raw_body_preview: err?.raw_text_preview || err?.raw_body_preview || null,
              },
              ...(diagnosticsEnabled
                ? {
                    diagnostics: {
                      handler_reached: true,
                      stage_trace: stageTrace,
                      ...buildBodyDiagnostics(req, {
                        body_source,
                        ...(body_source_detail ? { body_source_detail } : {}),
                        parse_error: err?.parse_error || null,
                        first_bytes_preview: err?.first_bytes_preview || null,
                        raw_text_preview: err?.raw_text_preview || err?.raw_body_preview || null,
                        raw_text_hex_preview: err?.raw_text_hex_preview || null,
                        raw_body_preview: err?.raw_text_preview || err?.raw_body_preview || null,
                      }),
                    },
                  }
                : {}),
            },
            200
          );
        }
        throw err;
      }

      const proxyQuery = readQueryParam(req, "proxy");
      if (!Object.prototype.hasOwnProperty.call(payload || {}, "proxy") && proxyQuery !== undefined) {
        payload.proxy = proxyQuery;
      }

      const bodyObj = payload && typeof payload === "object" ? payload : {};

      const hasBodySessionId = Boolean(bodyObj && typeof bodyObj === "object" && Object.prototype.hasOwnProperty.call(bodyObj, "session_id"));
      const bodySessionIdValue = hasBodySessionId ? bodyObj.session_id : undefined;

      const parsedSessionIdFromText = (() => {
        if (typeof payload !== "string" || !payload) return "";
        const match = payload.match(/"session_id"\s*:\s*"([^"]+)"/);
        return match && match[1] ? String(match[1]) : "";
      })();

      const headerSessionIdRaw = String(getHeader(req, "x-session-id") || "");

      if (hasBodySessionId) {
        sessionIdOriginal = String(bodySessionIdValue ?? "");
      } else if (parsedSessionIdFromText) {
        sessionIdOriginal = parsedSessionIdFromText;
      } else if (headerSessionIdRaw) {
        sessionIdOriginal = headerSessionIdRaw;
      } else {
        sessionIdOriginal = "";
      }

      const canonicalCandidate = String(sessionIdOriginal || "").trim();
      if (sessionIdOriginal && canonicalCandidate !== sessionIdOriginal) sessionIdOverride = true;
      if (hasBodySessionId && !canonicalCandidate) sessionIdOverride = true;

      sessionId = canonicalCandidate || `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      responseHeaders["x-session-id"] = sessionId;
      bodyObj.session_id = sessionId;

      try {
        upsertImportSession({
          session_id: sessionId,
          request_id: requestId,
          status: "running",
          stage_beacon,
          companies_count: 0,
        });
      } catch {}

      const hasQueryTypeField =
        Object.prototype.hasOwnProperty.call(bodyObj, "queryType") || Object.prototype.hasOwnProperty.call(bodyObj, "query_type");
      const hasQueryTypesField =
        Object.prototype.hasOwnProperty.call(bodyObj, "queryTypes") || Object.prototype.hasOwnProperty.call(bodyObj, "query_types");
      const ambiguousQueryTypeFields = hasQueryTypeField && hasQueryTypesField;

      const rawQueryTypes =
        bodyObj.queryTypes !== undefined ? bodyObj.queryTypes : bodyObj.query_types !== undefined ? bodyObj.query_types : undefined;
      const rawQueryType =
        bodyObj.queryType !== undefined ? bodyObj.queryType : bodyObj.query_type !== undefined ? bodyObj.query_type : undefined;

      const startTime = Date.now();

      const normalizedQuery = String(bodyObj.query || "").trim();
      const normalizedLocation = String(bodyObj.location || "").trim();
      const normalizedLimit = Math.max(1, Math.min(25, Math.trunc(Number(bodyObj.limit) || 1)));

      const queryTypesProvided = rawQueryTypes !== undefined && rawQueryTypes !== null;
      const queryTypesRaw = Array.isArray(rawQueryTypes) ? rawQueryTypes : [];

      const queryTypes = queryTypesRaw
        .map((t) => String(t || "").trim())
        .filter(Boolean)
        .slice(0, 10);

      const queryLooksLikeUrl = looksLikeCompanyUrlQuery(normalizedQuery);

      let normalizedQueryType = String(rawQueryType || queryTypes[0] || "product_keyword").trim() || "product_keyword";
      if (queryLooksLikeUrl && queryTypes.includes("company_url")) {
        normalizedQueryType = "company_url";
      }

      bodyObj.query = normalizedQuery;
      bodyObj.location = normalizedLocation || "";
      bodyObj.limit = normalizedLimit;
      bodyObj.queryType = normalizedQueryType;
      bodyObj.queryTypes = queryTypes.length > 0 ? queryTypes : [normalizedQueryType];

      const existingRequestId = String(bodyObj.request_id || bodyObj.requestId || "").trim();
      bodyObj.request_id = existingRequestId || requestId;
      bodyObj.requestId = bodyObj.request_id;

      if (queryLooksLikeUrl && bodyObj.queryTypes.includes("company_url")) {
        bodyObj.queryType = "company_url";
      }

      console.log(
        `[import-start] request_id=${requestId} session=${sessionId} normalized_request=` +
          JSON.stringify({
            session_id: sessionId,
            query_len: normalizedQuery.length,
            queryType: bodyObj.queryType,
            queryTypes: bodyObj.queryTypes,
            location_len: normalizedLocation.length,
            limit: normalizedLimit,
            proxy: Object.prototype.hasOwnProperty.call(bodyObj, "proxy") ? bodyObj.proxy : undefined,
          })
      );

      debugEnabled = bodyObj.debug === true || bodyObj.debug === "true";
      debugOutput = debugEnabled
        ? {
            xai: {
              payload: null,
              prompt_len: 0,
              raw_response: null,
              parse_error: null,
              parsed_companies: 0,
            },
            keywords_debug: [],
            reviews_debug: [],
            stages: [],
          }
        : null;

      contextInfo.company_name = String(payload?.company_name ?? "").trim();
      contextInfo.website_url = String(payload?.website_url ?? "").trim();
      contextInfo.normalized_domain = String(payload?.normalized_domain ?? "").trim();
      contextInfo.xai_request_id = null;
      enrichedForCounts = [];

      const setStage = (nextStage, extra = {}) => {
        stage = String(nextStage || "unknown");

        if (extra && typeof extra === "object") {
          if (typeof extra.company_name === "string") contextInfo.company_name = extra.company_name;
          if (typeof extra.website_url === "string") contextInfo.website_url = extra.website_url;
          if (typeof extra.normalized_domain === "string") contextInfo.normalized_domain = extra.normalized_domain;
          if (typeof extra.xai_request_id === "string") contextInfo.xai_request_id = extra.xai_request_id;
        }

        if (diagnosticsEnabled) {
          stageTrace.push({ stage, ts: new Date().toISOString(), ...extra });
        }

        if (debugOutput) {
          debugOutput.stages.push({ stage, ts: new Date().toISOString(), ...extra });
        }

        try {
          const extraKeys = extra && typeof extra === "object" ? Object.keys(extra) : [];
          if (extraKeys.length > 0) {
            console.log(
              `[import-start] request_id=${requestId} session=${sessionId} stage=${stage} extra=` +
                JSON.stringify(extra)
            );
          } else {
            console.log(`[import-start] request_id=${requestId} session=${sessionId} stage=${stage}`);
          }
        } catch {
          console.log(`[import-start] request_id=${requestId} session=${sessionId} stage=${stage}`);
        }
      };

      const noUpstreamMode = String(readQueryParam(req, "no_upstream") || "").trim() === "1";
      const noCosmosMode = String(readQueryParam(req, "no_cosmos") || "").trim() === "1";
      const cosmosEnabled = !noCosmosMode;

      let cosmosTargetDiagnostics = null;
      if (cosmosEnabled) {
        cosmosTargetDiagnostics = await getCompaniesCosmosTargetDiagnostics().catch(() => null);

        if (debugOutput && cosmosTargetDiagnostics) {
          debugOutput.cosmos_target = cosmosTargetDiagnostics;
        }

        if (cosmosTargetDiagnostics) {
          try {
            console.log("[import-start] cosmos_target", {
              request_id: requestId,
              session_id: sessionId,
              ...cosmosTargetDiagnostics,
            });
          } catch {}
        }
      }

      const inline_budget_ms = Number(STAGE_MAX_MS?.primary) || DEFAULT_UPSTREAM_TIMEOUT_MS;

      const requestedDeadlineRaw = readQueryParam(req, "deadline_ms");
      const requested_deadline_ms_number =
        Number.isFinite(Number(requestedDeadlineRaw)) && Number(requestedDeadlineRaw) > 0
          ? Number(requestedDeadlineRaw)
          : null;

      const requested_deadline_ms = requested_deadline_ms_number
        ? Math.max(5_000, Math.min(requested_deadline_ms_number, DEFAULT_HARD_TIMEOUT_MS))
        : DEFAULT_HARD_TIMEOUT_MS;

      const budget = startBudget({
        hardCapMs: DEFAULT_HARD_TIMEOUT_MS,
        clientDeadlineMs: requested_deadline_ms,
        startedAtMs: Date.now(),
      });

      const deadlineMs = budget.deadlineMs;

      const stageMsPrimaryRaw = readQueryParam(req, "stage_ms_primary");
      const requested_stage_ms_primary =
        Number.isFinite(Number(stageMsPrimaryRaw)) && Number(stageMsPrimaryRaw) > 0 ? Number(stageMsPrimaryRaw) : null;

      const requested_stage_ms_primary_effective = requested_stage_ms_primary
        ? Math.max(5_000, Math.min(requested_stage_ms_primary, requested_deadline_ms))
        : requested_deadline_ms;

      const allowedStages = ["primary", "keywords", "reviews", "location", "expand"];
      const stageOrder = new Map(allowedStages.map((s, i) => [s, i]));

      const parseStageParam = (raw) => {
        const v = String(raw || "").trim().toLowerCase();
        if (!v) return null;
        return allowedStages.includes(v) ? v : "__invalid__";
      };

      const maxStageRaw = readQueryParam(req, "max_stage");
      const skipStagesRaw = readQueryParam(req, "skip_stages");

      const dryRunRaw =
        Object.prototype.hasOwnProperty.call(bodyObj, "dry_run")
          ? bodyObj.dry_run
          : Object.prototype.hasOwnProperty.call(bodyObj, "dryRun")
            ? bodyObj.dryRun
            : readQueryParam(req, "dry_run");

      const dryRunRequested =
        dryRunRaw === true ||
        dryRunRaw === 1 ||
        dryRunRaw === "1" ||
        String(dryRunRaw || "")
          .trim()
          .toLowerCase() === "true";

      bodyObj.dry_run = dryRunRequested;
      bodyObj.dryRun = dryRunRequested;

      try {
        console.log("[import-start] received_query_params", {
          deadline_ms: requested_deadline_ms_number,
          stage_ms_primary: requested_stage_ms_primary,
          max_stage: typeof maxStageRaw === "string" ? maxStageRaw : null,
          skip_stages: typeof skipStagesRaw === "string" ? skipStagesRaw : null,
          dry_run: dryRunRequested,
        });
      } catch {}

      const maxStageParsed = parseStageParam(maxStageRaw);
      const skipStagesList = String(skipStagesRaw || "")
        .split(",")
        .map((s) => String(s || "").trim().toLowerCase())
        .filter(Boolean);

      if (maxStageParsed === "__invalid__") {
        const error_id = makeErrorId();
        logImportStartErrorLine({
          error_id,
          stage_beacon,
          root_cause: "invalid_request",
          err: new Error("Invalid max_stage"),
        });

        return jsonWithRequestId(
          {
            ok: false,
            stage: "import_start",
            root_cause: "invalid_request",
            retryable: false,
            http_status: 400,
            error_id,
            session_id: sessionId,
            request_id: requestId,
            stage_beacon,
            error_message: "Invalid max_stage. Expected one of: primary,keywords,reviews,location,expand",
          },
          200
        );
      }

      const skipStages = new Set();
      for (const s of skipStagesList) {
        const parsed = parseStageParam(s);
        if (parsed === "__invalid__") {
          const error_id = makeErrorId();
          logImportStartErrorLine({
            error_id,
            stage_beacon,
            root_cause: "invalid_request",
            err: new Error("Invalid skip_stages"),
          });

          return jsonWithRequestId(
            {
              ok: false,
              stage: "import_start",
              root_cause: "invalid_request",
              retryable: false,
              http_status: 400,
              error_id,
              session_id: sessionId,
              request_id: requestId,
              stage_beacon,
              error_message: "Invalid skip_stages. Expected comma-separated list from: primary,keywords,reviews,location,expand",
            },
            200
          );
        }
        if (parsed) skipStages.add(parsed);
      }

      // HARD RULE: import-start must never run (or fallback to website parsing for) HQ/MFG/Reviews.
      // These are Grok-only and handled exclusively in resume-worker.
      skipStages.add("reviews");
      skipStages.add("location");

      const maxStage = maxStageParsed;

      try {
        console.log("[import-start] normalized_effective_request", {
          request_id: requestId,
          session_id: sessionId,
          query: normalizedQuery,
          queryTypes: Array.isArray(bodyObj.queryTypes) ? bodyObj.queryTypes : [],
          location: bodyObj.location,
          limit: bodyObj.limit,
          max_stage: maxStage,
          skip_stages: Array.from(skipStages),
          dry_run: dryRunRequested,
          companies_seeded: Array.isArray(bodyObj.companies) ? bodyObj.companies.length : 0,
        });
      } catch {}

      const providedCompaniesRaw = Array.isArray(bodyObj.companies) ? bodyObj.companies : [];
      const providedCompanies = providedCompaniesRaw.filter((c) => c && typeof c === "object");

      // ── Seed validation (delegated to _importStartCompanyUtils.js) ──
      const isMeaningfulString = _isMeaningfulString;
      const hasMeaningfulSeedEnrichment = _hasMeaningfulSeedEnrichment;
      const isValidSeedCompany = _isValidSeedCompany;

      const validSeedCompanies = providedCompanies.filter(isValidSeedCompany);

      // If we're skipping primary, we must have at least one VALID seed company.
      const skipsPrimaryWithoutAnyCompanies = skipStages.has("primary") && providedCompanies.length === 0;
      const skipsPrimaryWithoutValidSeed = skipStages.has("primary") && providedCompanies.length > 0 && validSeedCompanies.length === 0;

      if (skipsPrimaryWithoutAnyCompanies) {
        const error_id = makeErrorId();
        logImportStartErrorLine({
          error_id,
          stage_beacon,
          root_cause: "missing_seed_companies",
          err: new Error("skip_stages includes primary but no companies were provided"),
        });

        // Guardrail: never proceed past primary unless we have a seeded companies list.
        return jsonWithRequestId(
          {
            ok: false,
            stage: "import_start",
            stage_beacon,
            root_cause: "missing_seed_companies",
            retryable: true,
            http_status: 409,
            error_id,
            message: "skip_stages includes primary but no companies were provided",
            session_id: sessionId,
            request_id: requestId,
          },
          200
        );
      }

      if (skipsPrimaryWithoutValidSeed) {
        const error_id = makeErrorId();
        logImportStartErrorLine({
          error_id,
          stage_beacon,
          root_cause: "invalid_seed_companies",
          err: new Error("resume requested but seed companies are not valid"),
        });

        return jsonWithRequestId(
          {
            ok: false,
            stage: "import_start",
            stage_beacon,
            root_cause: "invalid_seed_companies",
            retryable: true,
            http_status: 409,
            error_id,
            message: "resume requested but seed companies are not valid; wait for primary candidates",
            session_id: sessionId,
            request_id: requestId,
            seed_counts: {
              provided: providedCompanies.length,
              valid: validSeedCompanies.length,
            },
          },
          200
        );
      }

      // If we have seeded companies, prefer a cleaned list when resuming.
      if (skipStages.has("primary") && validSeedCompanies.length > 0) {
        bodyObj.companies = validSeedCompanies;
      }

      const stopsBeforeSave = Boolean(maxStage && maxStage !== "expand" && maxStage !== "primary");

      if (!dryRunRequested && stopsBeforeSave) {
        return jsonWithRequestId(
          {
            ok: false,
            session_id: sessionId,
            request_id: requestId,
            stage_beacon,
            error_message:
              "This config cannot persist. Set dry_run=true or remove stage overrides (max_stage/skip_stages) that prevent saving.",
            details: {
              dry_run: dryRunRequested,
              max_stage: maxStage,
              skip_stages: Array.from(skipStages),
              companies_seeded: providedCompanies.length,
            },
          },
          400
        );
      }

      const shouldRunStage = (stageKey) => {
        if (!stageKey) return true;
        if (skipStages.has(stageKey)) return false;
        if (!maxStage) return true;
        return stageOrder.get(stageKey) <= stageOrder.get(maxStage);
      };

      const shouldStopAfterStage = (stageKey) => {
        if (!maxStage) return false;
        if (maxStage === stageKey) return true;
        return false;
      };

      const safeCheckIfSessionStopped = async (sid) => {
        if (!cosmosEnabled) return false;
        return await checkIfSessionStopped(sid);
      };

      const respondError = async (err, { status = 500, details = {} } = {}) => {
        const baseDetails =
          requestDetails ||
          buildRequestDetails(req, {
            body_source,
            body_source_detail,
            raw_text_preview,
            raw_text_starts_with_brace,
          });

        const detailsObj = {
          ...(baseDetails && typeof baseDetails === "object" ? baseDetails : {}),
          ...(details && typeof details === "object" ? details : {}),
          body_source,
          ...(body_source_detail ? { body_source_detail } : {}),
        };

        if (!detailsObj.content_type) {
          detailsObj.content_type = getHeader(req, "content-type") || null;
        }
        if (!detailsObj.content_length_header) {
          detailsObj.content_length_header = getHeader(req, "content-length") || null;
        }

        const errorStage = stage_beacon || stage;

        const shouldReturnWarnings =
          status >= 500 &&
          saveReport &&
          typeof saveReport === "object" &&
          Number.isFinite(Number(saveReport.saved)) &&
          Number(saveReport.saved) > 0;

        if (shouldReturnWarnings) {
          const upstreamStatus =
            Number.isFinite(Number(detailsObj?.upstream_status))
              ? Number(detailsObj.upstream_status)
              : Number.isFinite(Number(detailsObj?.xai_status))
                ? Number(detailsObj.xai_status)
                : null;

          const upstreamUrlRaw =
            (typeof detailsObj?.upstream_url === "string" && detailsObj.upstream_url.trim())
              ? detailsObj.upstream_url.trim()
              : (typeof detailsObj?.xai_url === "string" && detailsObj.xai_url.trim())
                ? detailsObj.xai_url.trim()
                : "";

          const upstreamUrlRedacted = upstreamUrlRaw ? redactUrlQueryAndHash(upstreamUrlRaw) : null;

          const root_cause = (() => {
            if (status === 504) return "timeout";
            const code = String(detailsObj?.code || "").toLowerCase();
            if (code.includes("timeout")) return "timeout";
            if (Number.isFinite(Number(upstreamStatus))) {
              if (upstreamStatus >= 400 && upstreamStatus < 500) return "upstream_4xx";
              if (upstreamStatus >= 500) return "upstream_5xx";
            }
            if (String(errorStage || "").toLowerCase().includes("cosmos")) return "cosmos_write_error";
            return "parse_error";
          })();

          const warningKey = (() => {
            const s = String(errorStage || "").toLowerCase();
            if (s.includes("reviews")) return "reviews_failed";
            if (s.includes("expand")) return "expand_failed";
            if (s.includes("keywords")) return "keywords_failed";
            if (s.includes("location")) return "location_failed";
            return "saved_with_warnings";
          })();

          const rawPartialMessage =
            (typeof detailsObj?.message === "string" && detailsObj.message.trim())
              ? detailsObj.message.trim()
              : (typeof detailsObj?.error_message === "string" && detailsObj.error_message.trim())
                ? detailsObj.error_message.trim()
                : toErrorString(err) || "";

          const partialMessage = (() => {
            const m = asString(rawPartialMessage).trim();
            const lower = m.toLowerCase();
            const statusLabel = Number.isFinite(Number(upstreamStatus)) ? `HTTP ${Number(upstreamStatus)}` : "";
            const specifics = [warningKey, root_cause, statusLabel].filter(Boolean).join(", ");

            if (!m) return specifics ? `Saved with warnings (${specifics})` : "Saved with warnings";
            if (lower === "backend call failure" || lower === "saved with warnings") {
              return specifics ? `Saved with warnings (${specifics})` : m;
            }
            return m;
          })();

          const warningDetail = {
            stage: warningKey,
            root_cause,
            upstream_status: upstreamStatus,
            upstream_url: upstreamUrlRedacted,
            message: partialMessage,
            build_id: buildInfo?.build_id || null,
          };

          try {
            upsertImportSession({
              session_id: sessionId,
              request_id: requestId,
              status: "complete",
              stage_beacon: errorStage,
              companies_count: Array.isArray(enrichedForCounts) ? enrichedForCounts.length : 0,
            });
          } catch {}

          if (!noUpstreamMode && cosmosEnabled) {
            try {
              await upsertCosmosImportSessionDoc({
                sessionId,
                requestId,
                patch: {
                  status: "complete",
                  stage_beacon: errorStage,
                  saved: Number(saveReport.saved) || 0,
                  skipped: Number(saveReport.skipped) || 0,
                  failed: Number(saveReport.failed) || 0,
                  warnings: [warningKey],
                  warnings_detail: { [warningKey]: warningDetail },
                  completed_at: new Date().toISOString(),
                },
              });
            } catch {}
          }

          return jsonWithRequestId(
            {
              ok: true,
              session_id: sessionId,
              request_id: requestId,
              stage_beacon: errorStage,
              company_name: contextInfo.company_name,
              website_url: contextInfo.website_url,
              companies: Array.isArray(enrichedForCounts) ? enrichedForCounts : [],
              saved: Number(saveReport.saved) || 0,
              skipped: Number(saveReport.skipped) || 0,
              failed: Number(saveReport.failed) || 0,
              save_report: saveReport,
              warnings: [warningKey],
              warnings_detail: { [warningKey]: warningDetail },
              build_id: buildInfo?.build_id || null,
            },
            200
          );
        }

        try {
          upsertImportSession({
            session_id: sessionId,
            request_id: requestId,
            status: "failed",
            stage_beacon: errorStage,
            companies_count: Array.isArray(enrichedForCounts) ? enrichedForCounts.length : 0,
          });
        } catch {}

        const env_present = {
          has_xai_key: Boolean(getXAIKey()),
          has_xai_base_url: Boolean(getXAIEndpoint()),
          has_import_start_proxy_base: false,
        };

        const upstream = (() => {
          const d = detailsObj && typeof detailsObj === "object" ? detailsObj : {};
          const rawUrl = d.upstream_url || d.xai_url || d.upstream || "";
          const host_path = rawUrl ? toHostPathOnlyForLog(rawUrl) : "";
          const statusVal = d.upstream_status ?? d.xai_status ?? null;
          const body_preview =
            d.upstream_text_preview || d.upstream_body_preview
              ? toTextPreview(d.upstream_text_preview || d.upstream_body_preview)
              : "";
          const timeout_ms =
            d.upstream_timeout_ms ?? d.timeout_ms ?? (status === 504 ? d.hard_timeout_ms || null : null);
          const error_class =
            typeof d.upstream_error_class === "string" && d.upstream_error_class.trim()
              ? d.upstream_error_class.trim()
              : typeof d.error_class === "string" && d.error_class.trim()
                ? d.error_class.trim()
                : null;

          const out = {};
          if (host_path) out.host_path = host_path;
          if (Number.isFinite(Number(statusVal))) out.status = Number(statusVal);
          if (body_preview) out.body_preview = body_preview;
          if (Number.isFinite(Number(timeout_ms))) out.timeout_ms = Number(timeout_ms);
          if (error_class) out.error_class = error_class;
          return Object.keys(out).length ? out : null;
        })();

        if (status >= 500) {
          try {
            console.error(
              "[import-start] sanitized_diagnostics:",
              JSON.stringify({ request_id: requestId, session_id: sessionId, stage: errorStage, status, upstream, env_present })
            );
          } catch {}
        }

        const errorMessage = toErrorString(err);
        const code =
          (detailsObj && typeof detailsObj.code === "string" && detailsObj.code.trim() ? detailsObj.code.trim() : null) ||
          (status === 400 ? "INVALID_REQUEST" : stage === "config" ? "IMPORT_START_NOT_CONFIGURED" : "IMPORT_START_FAILED");

        const message =
          (detailsObj && typeof detailsObj.message === "string" && detailsObj.message.trim()
            ? detailsObj.message.trim()
            : errorMessage) || "Import start failed";

        console.error(
          `[import-start] request_id=${requestId} session=${sessionId} stage=${errorStage} code=${code} message=${message}`
        );
        if (err?.stack) console.error(err.stack);

        const errorObj = {
          code,
          message,
          request_id: requestId,
          step: errorStage,
        };

        const passthroughKeys = [
          "upstream_status",
          "upstream_url",
          "upstream_path",
          "upstream_text_preview",
          "upstream_error_code",
          "upstream_error_message",
          "upstream_request_id",
        ];

        if (detailsObj && typeof detailsObj === "object") {
          for (const k of passthroughKeys) {
            if (detailsObj[k] === undefined || detailsObj[k] === null) continue;
            const v = detailsObj[k];
            if (typeof v === "string" && !v.trim()) continue;
            errorObj[k] = v;
          }
        }

        if (!noUpstreamMode && cosmosEnabled) {
          try {
            const container = getCompaniesCosmosContainer();
            if (container) {
              const errorDoc = {
                id: `_import_error_${sessionId}`,
                ...buildImportControlDocBase(sessionId),
                request_id: requestId,
                stage: errorStage,
                error: errorObj,
                details: detailsObj && typeof detailsObj === "object" ? detailsObj : {},
              };
              await upsertItemWithPkCandidates(container, errorDoc);
            }
          } catch (e) {
            console.warn(
              `[import-start] request_id=${requestId} session=${sessionId} failed to write error doc: ${e?.message || String(e)}`
            );
          }
        }

        const normalizeArray = (v) => (Array.isArray(v) ? v : []);
        const metaFromDetails =
          detailsObj && typeof detailsObj.meta === "object" && detailsObj.meta ? detailsObj.meta : null;

        const currentQueryTypes = normalizeArray(bodyObj?.queryTypes)
          .map((t) => String(t || "").trim())
          .filter(Boolean);

        const metaStage = (() => {
          const explicit = String(metaFromDetails?.stage || "").trim();
          if (explicit) return explicit;
          if (stage === "validate_request") return "validate_request";
          if (stage === "build_prompt" || stage === "build_messages") return "build_prompt";
          if (stage === "searchCompanies" || stage === "worker_call") return "xai_call";
          return "unknown";
        })();

        const meta = {
          ...(metaFromDetails && typeof metaFromDetails === "object" ? metaFromDetails : {}),
          handler_version: metaFromDetails?.handler_version || handlerVersion,
          stage: metaStage,
          query_len: Number.isFinite(Number(metaFromDetails?.query_len)) ? Number(metaFromDetails.query_len) : normalizedQuery.length,
          queryTypes: normalizeArray(metaFromDetails?.queryTypes).length ? normalizeArray(metaFromDetails.queryTypes) : currentQueryTypes,
          prompt_len: Number.isFinite(Number(metaFromDetails?.prompt_len)) ? Number(metaFromDetails.prompt_len) : 0,
          messages_len: Number.isFinite(Number(metaFromDetails?.messages_len)) ? Number(metaFromDetails.messages_len) : 0,
          has_system_message:
            typeof metaFromDetails?.has_system_message === "boolean"
              ? metaFromDetails.has_system_message
              : typeof metaFromDetails?.has_system_content === "boolean"
                ? metaFromDetails.has_system_content
                : false,
          has_user_message:
            typeof metaFromDetails?.has_user_message === "boolean"
              ? metaFromDetails.has_user_message
              : typeof metaFromDetails?.has_user_content === "boolean"
                ? metaFromDetails.has_user_content
                : false,
          user_message_len: Number.isFinite(Number(metaFromDetails?.user_message_len))
            ? Number(metaFromDetails.user_message_len)
            : Number.isFinite(Number(metaFromDetails?.prompt_len))
              ? Number(metaFromDetails.prompt_len)
              : 0,
          elapsedMs: Date.now() - startTime,
          upstream_status:
            metaFromDetails?.upstream_status ??
            metaFromDetails?.xai_status ??
            detailsObj?.upstream_status ??
            detailsObj?.xai_status ??
            null,
          upstream_error_class:
            metaFromDetails?.upstream_error_class ??
            metaFromDetails?.error_class ??
            detailsObj?.upstream_error_class ??
            detailsObj?.error_class ??
            null,
        };

        const error_id = makeErrorId();
        const root_cause = status >= 500 ? "server_exception" : "invalid_request";

        logImportStartErrorLine({ error_id, stage_beacon: errorStage, root_cause, err });

        const errorPayload = {
          ok: false,
          stage: errorStage,
          stage_beacon: errorStage,
          session_id: sessionId,
          request_id: requestId,
          retryable: true,
          root_cause,
          http_status: Number.isFinite(Number(status)) ? Number(status) : null,
          error_id,
          env_present,
          upstream: upstream || {},
          meta,
          error: errorObj,
          legacy_error: message,
          ...buildInfo,
          company_name: contextInfo.company_name,
          website_url: contextInfo.website_url,
          normalized_domain: contextInfo.normalized_domain,
          xai_request_id: contextInfo.xai_request_id,
          ...(diagnosticsEnabled
            ? {
                diagnostics: {
                  handler_reached: true,
                  stage_trace: stageTrace,
                  ...buildBodyDiagnostics(req),
                },
              }
            : {}),
          ...(debugEnabled
            ? {
                stack: String(err?.stack || ""),
                counts: buildCounts({ enriched: enrichedForCounts, debugOutput }),
                debug: debugOutput,
              }
            : {}),
          ...(detailsObj && typeof detailsObj === "object" && Object.keys(detailsObj).length ? { details: detailsObj } : {}),
        };

        // Normalize error responses to HTTP 200 so Static Web Apps never masks the body.
        // The real status is carried in errorPayload.http_status.
        return jsonWithRequestId(errorPayload, 200);
      };

      if (queryTypesProvided && !Array.isArray(rawQueryTypes)) {
        setStage("build_prompt", { error: "QUERYTYPES_NOT_ARRAY" });

        const normalizedQueryTypes = Array.isArray(bodyObj.queryTypes) ? bodyObj.queryTypes : [];
        const meta = {
          queryTypes: normalizedQueryTypes,
          query_len: normalizedQuery.length,
          prompt_len: 0,
          messages_len: 0,
          has_system_content: false,
          has_user_content: false,
        };

        return respondError(new Error("queryTypes must be an array"), {
          status: 400,
          details: {
            code: "QUERYTYPES_NOT_ARRAY",
            message: "queryTypes must be an array of strings",
            queryTypes: normalizedQueryTypes,
            prompt_len: meta.prompt_len,
            meta,
          },
        });
      }

      if (ambiguousQueryTypeFields) {
        setStage("validate_request", { error: "AMBIGUOUS_QUERY_TYPE_FIELDS" });
        return respondError(new Error("Ambiguous query type fields"), {
          status: 400,
          details: {
            code: "AMBIGUOUS_QUERY_TYPE_FIELDS",
            message: "Provide only one of queryTypes (array) or queryType (string), not both.",
          },
        });
      }

      if (queryLooksLikeUrl && !bodyObj.queryTypes.includes("company_url")) {
        setStage("validate_request", { error: "INVALID_QUERY_TYPE" });
        return respondError(new Error("Query looks like a URL"), {
          status: 400,
          details: {
            code: "INVALID_QUERY_TYPE",
            message: "Query looks like a URL. Include company_url in queryTypes.",
            query: normalizedQuery,
            queryTypes: bodyObj.queryTypes,
          },
        });
      }

      const queryTypesForLog = Array.isArray(bodyObj.queryTypes)
        ? bodyObj.queryTypes
            .map((t) => String(t || "").trim())
            .filter(Boolean)
            .slice(0, 10)
        : [];

      setStage("validate_request", {
        queryTypes: queryTypesForLog,
        query_len: normalizedQuery.length,
        limit: Number(bodyObj.limit),
      });

      logImportStartMeta({
        request_id: requestId,
        session_id: sessionId,
        handler_version: handlerVersion,
        stage: "validate_request",
        queryTypes: queryTypesForLog,
        query_len: normalizedQuery.length,
        prompt_len: 0,
        messages_len: 0,
        has_system_message: false,
        has_user_message: false,
        user_message_len: 0,
        elapsedMs: Date.now() - startTime,
        upstream_status: null,
      });

      mark("validate_request_done");

      const dryRun = bodyObj.dry_run === true || bodyObj.dry_run === "true";
      if (dryRun) {
        setStage("dry_run");
        return jsonWithRequestId(
          {
            ok: true,
            stage,
            session_id: sessionId,
            request_id: requestId,
            details:
              requestDetails ||
              buildRequestDetails(req, {
                body_source,
                body_source_detail,
                raw_text_preview,
                raw_text_starts_with_brace,
              }),
            company_name: contextInfo.company_name,
            website_url: contextInfo.website_url,
            normalized_domain: contextInfo.normalized_domain,
            received: {
              query: String(bodyObj.query || ""),
              queryType: String(bodyObj.queryType || ""),
              queryTypes: Array.isArray(bodyObj.queryTypes) ? bodyObj.queryTypes : [],
              location: String(bodyObj.location || ""),
              limit: Number(bodyObj.limit) || 0,
            },
            ...buildInfo,
          },
          200
        );
      }

      if (!String(bodyObj.query || "").trim()) {
        setStage("build_prompt", { error: "MISSING_QUERY" });

        const normalizedQueryTypes = Array.isArray(bodyObj.queryTypes) ? bodyObj.queryTypes : [];
        const meta = {
          queryTypes: normalizedQueryTypes,
          query_len: 0,
          prompt_len: 0,
          messages_len: 0,
          has_system_content: false,
          has_user_content: false,
        };

        return respondError(new Error("query is required"), {
          status: 400,
          details: {
            code: "IMPORT_START_VALIDATION_FAILED",
            message: "Query is required",
            queryTypes: normalizedQueryTypes,
            prompt_len: meta.prompt_len,
            meta,
          },
        });
      }

      setStage("create_session");
      sessionCreatedAtIso ||= new Date().toISOString();
      if (!noUpstreamMode && cosmosEnabled) {
        try {
          const container = getCompaniesCosmosContainer();
          if (container) {
            // Check for a stuck previous session with the same ID (SWA 500 retry scenario).
            // If the previous session is stuck at create_session for >30s, reset it so we can
            // start fresh. This handles the case where the SWA gateway killed both the original
            // function invocation AND the HTTP connection, leaving a zombie session in Cosmos.
            try {
              const existingSessionDoc = await readItemWithPkCandidates(container, `_import_session_${sessionId}`, {
                session_id: sessionId,
                normalized_domain: `_import_session`,
              });
              if (existingSessionDoc && typeof existingSessionDoc === "object") {
                const existingBeacon = String(existingSessionDoc.stage_beacon || "").trim();
                const existingStatus = String(existingSessionDoc.status || "").trim();
                const existingCreatedAt = existingSessionDoc.created_at ? new Date(existingSessionDoc.created_at).getTime() : 0;
                const ageMs = existingCreatedAt > 0 ? Date.now() - existingCreatedAt : Infinity;
                const isStuck =
                  existingStatus === "running" &&
                  existingBeacon === "create_session" &&
                  ageMs > 30_000 &&
                  (Number(existingSessionDoc.companies_count || 0) === 0);

                if (isStuck) {
                  console.log(
                    `[import-start] request_id=${requestId} session=${sessionId} detected stuck session (age=${Math.round(ageMs / 1000)}s, beacon=${existingBeacon}), resetting for retry`
                  );
                }
              }
            } catch (stuckCheckErr) {
              // Non-fatal: if we can't check, just proceed with upsert (which will overwrite)
            }

            const sessionDoc = {
              id: `_import_session_${sessionId}`,
              ...buildImportControlDocBase(sessionId),
              created_at: sessionCreatedAtIso,
              request_id: requestId,
              status: "running",
              stage_beacon: "create_session",
              request: {
                query: String(bodyObj.query || ""),
                queryType: String(bodyObj.queryType || ""),
                queryTypes: Array.isArray(bodyObj.queryTypes) ? bodyObj.queryTypes : [],
                location: String(bodyObj.location || ""),
                limit: Number(bodyObj.limit) || 0,
                max_stage: String(maxStage || ""),
                skip_stages: Array.from(skipStages),
                dry_run: dryRunRequested,
              },
            };
            const result = await upsertItemWithPkCandidates(container, sessionDoc);
            if (!result.ok) {
              console.warn(
                `[import-start] request_id=${requestId} session=${sessionId} failed to write session marker: ${result.error}`
              );
            }
          }
        } catch (e) {
          console.warn(
            `[import-start] request_id=${requestId} session=${sessionId} error writing session marker: ${e?.message || String(e)}`
          );
        }
      }

      // Proxying disabled: /api/import/start is the single authority for message building + validation.
      // The legacy `proxy` flag is still parsed for backward compatibility, but is ignored.
      const proxyRaw =
        Object.prototype.hasOwnProperty.call(bodyObj || {}, "proxy")
          ? bodyObj.proxy
          : readQueryParam(req, "proxy");

      const proxyRequested =
        !isProxyExplicitlyDisabled(proxyRaw) && isProxyExplicitlyEnabled(proxyRaw);

      if (proxyRequested && debugOutput) {
        debugOutput.proxy_warning = {
          message: "Proxying is disabled for /api/import/start; request handled locally.",
        };
      }

      // Budget is the single source of truth (SWA gateway kills are not catchable).
      const isOutOfTime = () => budget.isExpired();

      const shouldAbort = () => {
        if (isOutOfTime()) {
          try {
            console.warn("[import-start] TIMEOUT: request budget exhausted", {
              request_id: requestId,
              session_id: sessionId,
              elapsed_ms: budget.getElapsedMs(),
              total_ms: budget.totalMs,
            });
          } catch {}
          return true;
        }
        return false;
      };

      const respondAcceptedBeforeGatewayTimeout = (nextStageBeacon, reason, extra) => {
        const beacon = String(nextStageBeacon || stage_beacon || stage || "unknown") || "unknown";
        mark(beacon);

        const normalizedReason = String(reason || "deadline_budget_guard") || "deadline_budget_guard";

        try {
          upsertImportSession({
            session_id: sessionId,
            request_id: requestId,
            status: "running",
            stage_beacon: beacon,
            companies_count: Array.isArray(enrichedForCounts) ? enrichedForCounts.length : 0,
            accepted: true,
            accepted_at: new Date().toISOString(),
            accepted_reason: normalizedReason,
          });
        } catch {}

        // Fire-and-forget: persist an acceptance marker so status can explain what happened even if the
        // start handler had to return early.
        if (!noUpstreamMode && cosmosEnabled) {
          (async () => {
            const container = getCompaniesCosmosContainer();
            if (!container) return;

            const acceptDoc = {
              id: `_import_accept_${sessionId}`,
              ...buildImportControlDocBase(sessionId),
              created_at: new Date().toISOString(),
              accepted_at: new Date().toISOString(),
              request_id: requestId,
              stage_beacon: beacon,
              reason: normalizedReason,
              remaining_ms:
                extra && typeof extra === "object" && Number.isFinite(Number(extra.remainingMs)) ? Number(extra.remainingMs) : null,
            };

            await upsertItemWithPkCandidates(container, acceptDoc).catch(() => null);

            // For company_url imports, the inline pipeline (seed fallback at line 8054) continues
            // after the AcceptedResponseError and handles session doc updates with full save data.
            // Skip the session doc update here to avoid racing with the inline pipeline.
            const isCompanyUrlFlow =
              Array.isArray(bodyObj?.queryTypes) && bodyObj.queryTypes.includes("company_url");

            if (!isCompanyUrlFlow) {
              await upsertCosmosImportSessionDoc({
                sessionId,
                requestId,
                patch: {
                  status: "running",
                  stage_beacon: beacon,
                  requested_deadline_ms,
                  requested_stage_ms_primary: requested_stage_ms_primary_effective,
                },
              }).catch(() => null);
            }

            // For company_url imports, the inline pipeline handles everything via seed fallback.
            // No need to enqueue a primary job (it would be redundant and create race conditions).
            const shouldEnqueuePrimary =
              !isCompanyUrlFlow && (
                beacon === "xai_primary_fetch_start" ||
                beacon === "xai_primary_fetch_done" ||
                beacon.startsWith("xai_primary_fetch_") ||
                beacon.startsWith("primary_")
              );

            // If we had to return early while we're still in primary, enqueue a durable primary job so
            // /api/import/status can drive it to completion.
            if (shouldEnqueuePrimary) {
              const jobDoc = {
                id: buildImportPrimaryJobId(sessionId),
                session_id: sessionId,
                job_state: "queued",
                stage: "primary",
                stage_beacon: "primary_search_started",
                request_payload: {
                  query: String(bodyObj.query || ""),
                  queryTypes: Array.isArray(bodyObj.queryTypes)
                    ? bodyObj.queryTypes
                    : [String(bodyObj.queryType || "product_keyword").trim() || "product_keyword"],
                  limit: Number(bodyObj.limit) || 0,
                  expand_if_few: bodyObj.expand_if_few ?? true,
                },
                inline_budget_ms,
                requested_deadline_ms,
                requested_stage_ms_primary: requested_stage_ms_primary_effective,
                xai_outbound_body:
                  typeof primaryXaiOutboundBody === "string" && primaryXaiOutboundBody.trim()
                    ? primaryXaiOutboundBody
                    : null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              };

              await upsertImportPrimaryJob({ jobDoc, cosmosEnabled }).catch(() => null);

              try {
                const base = new URL(req.url);
                const triggerUrl = new URL("/api/import/primary-worker", base.origin);
                triggerUrl.searchParams.set("session_id", sessionId);
                if (!cosmosEnabled) triggerUrl.searchParams.set("no_cosmos", "1");

                setTimeout(() => {
                  fetch(triggerUrl.toString(), {
                    method: "POST",
                    headers: buildInternalFetchHeaders(),
                    body: JSON.stringify({ session_id: sessionId }),
                  }).catch(() => {});
                }, 0);
              } catch {}
            }
          })().catch(() => null);
        }

        return jsonWithRequestId(
          {
            ok: true,
            accepted: true,
            session_id: sessionId,
            request_id: requestId,
            stage_beacon: beacon,
            reason: normalizedReason,
            inline_budget_ms,
            requested_deadline_ms,
            requested_stage_ms_primary: requested_stage_ms_primary_effective,
            note: "start endpoint is inline capped; long primary runs async",
            ...(extra && typeof extra === "object" ? extra : {}),
          },
          200
        );
      };

      const checkDeadlineOrReturn = (nextStageBeacon, stageKey) => {
        const remainingMs = budget.getRemainingMs();

        // If we're too close to the SWA gateway wall-clock, stop starting new stages.
        if (remainingMs < MIN_STAGE_REMAINING_MS) {
          // Only primary is allowed to continue async.
          if (stageKey === "primary") {
            return respondAcceptedBeforeGatewayTimeout(nextStageBeacon, "remaining_budget_low", {
              remainingMs,
            });
          }
          return null;
        }

        return null;
      };

      try {
        const center = safeCenter(bodyObj.center);
        const query = String(bodyObj.query || "").trim();
        const queryTypesRaw = Array.isArray(bodyObj.queryTypes) ? bodyObj.queryTypes : [];
        const queryTypes = queryTypesRaw
          .map((t) => String(t || "").trim())
          .filter(Boolean)
          .slice(0, 10);

        const queryType = String(bodyObj.queryType || queryTypes[0] || "product_keyword").trim() || "product_keyword";
        const location = String(bodyObj.location || "").trim();
        const companyUrlHint = String(bodyObj.company_url_hint || "").trim();

        const xaiPayload = {
          queryType: queryTypes.length > 0 ? queryTypes.join(", ") : queryType,
          queryTypes: queryTypes.length > 0 ? queryTypes : [queryType],
          query,
          company_url_hint: companyUrlHint || undefined,
          location,
          limit: Math.max(1, Math.min(Number(bodyObj.limit) || 10, 25)),
          expand_if_few: bodyObj.expand_if_few ?? true,
          session_id: sessionId,
          ...(center ? { center } : {}),
        };

        if (debugOutput) {
          debugOutput.xai.payload = xaiPayload;
        }

        const deferredStages = new Set();
        let downstreamDeferredByBudget = false;

        // Client-controlled timeouts must never exceed the SWA-safe stage caps.
        const requestedTimeout = Number(bodyObj.timeout_ms) || DEFAULT_UPSTREAM_TIMEOUT_MS;
        const timeout = Math.min(requestedTimeout, DEFAULT_UPSTREAM_TIMEOUT_MS);
        console.log(`[import-start] Request timeout: ${timeout}ms (requested: ${requestedTimeout}ms)`);

        // Get XAI configuration (consolidated to use XAI_EXTERNAL_BASE primarily)
        const xaiEndpointRaw = getXAIEndpoint();
        const xaiKey = getXAIKey();
        const xaiModel = "grok-4-latest";
        const xaiUrl = resolveXaiEndpointForModel(xaiEndpointRaw, xaiModel);
        const xaiUrlForLog = toHostPathOnlyForLog(xaiUrl);

        const externalBaseSet = Boolean(
          String(
            process.env.XAI_EXTERNAL_BASE || process.env.XAI_INTERNAL_BASE || process.env.XAI_UPSTREAM_BASE || process.env.XAI_BASE || ""
          ).trim()
        );
        const legacyBaseSet = Boolean(String(process.env.XAI_BASE_URL || "").trim());
        const xai_config_source = externalBaseSet ? "external" : legacyBaseSet ? "legacy" : "external";
        const upstreamMeta = getResolvedUpstreamMeta(xaiUrl);

        console.log(`[import-start] XAI Endpoint: ${xaiEndpointRaw ? "configured" : "NOT SET"}`);
        console.log(`[import-start] XAI Key: ${xaiKey ? "configured" : "NOT SET"}`);
        console.log("[import-start] env_check", {
          has_xai_key: Boolean(xaiKey),
          xai_key_length: xaiKey ? String(xaiKey).length : 0,
          xai_config_source,
          resolved_upstream_host: upstreamMeta.resolved_upstream_host,
          resolved_upstream_path: upstreamMeta.resolved_upstream_path,
        });
        console.log("[import-start] xai_routing", {
          xai_config_source,
          resolved_upstream_host: upstreamMeta.resolved_upstream_host,
          resolved_upstream_path: upstreamMeta.resolved_upstream_path,
          xai_url: xaiUrlForLog || null,
        });
        console.log(`[import-start] XAI Request URL: ${xaiUrlForLog || "(unparseable)"}`);

        if ((!xaiUrl || !xaiKey) && !noUpstreamMode) {
          setStage("config");
          return respondError(new Error("XAI not configured"), {
            status: 500,
            details: {
              message: "Please set XAI_EXTERNAL_BASE and XAI_EXTERNAL_KEY environment variables",
            },
          });
        }

        const getRemainingMs = () => budget.getRemainingMs();

        // throwAccepted stays in handler — it closes over respondAcceptedBeforeGatewayTimeout
        const throwAccepted = (nextStageBeacon, reason, extra) => {
          const beacon = String(nextStageBeacon || stage_beacon || stage || "unknown") || "unknown";
          const remainingMs = getRemainingMs();

          try {
            console.log("[import-start] returning_202", {
              stage: extra && typeof extra === "object" && typeof extra.stage === "string" ? extra.stage : stage,
              stage_beacon: beacon,
              reason: String(reason || "deadline_budget_guard"),
              remainingMs,
              request_id: requestId,
              session_id: sessionId,
            });
          } catch {}

          throw new AcceptedResponseError(
            respondAcceptedBeforeGatewayTimeout(beacon, reason, {
              ...(extra && typeof extra === "object" ? extra : {}),
              remainingMs,
            })
          );
        };

        // ── XAI request pipeline (delegated to _importStartXaiRequest.js) ──
        const _xaiReqCtx = { budget, requestId, sessionId, xaiUrl, xaiKey, throwAccepted };
        const ensureStageBudgetOrThrow = (stageKey, nextStageBeacon) =>
          _ensureStageBudgetOrThrow(stageKey, nextStageBeacon, _xaiReqCtx);
        const postXaiJsonWithBudget = (opts) => _postXaiJsonWithBudget(opts, _xaiReqCtx);
        const postXaiJsonWithBudgetRetry = (opts) => _postXaiJsonWithBudgetRetry(opts, _xaiReqCtx);

        // Early check: if import was already stopped, return immediately
        if (!noUpstreamMode) {
          const wasAlreadyStopped = await safeCheckIfSessionStopped(sessionId);
          if (wasAlreadyStopped) {
          setStage("stopped");
          console.log(`[import-start] session=${sessionId} stop signal detected before XAI call`);
          return jsonWithRequestId(
            {
              ok: false,
              stage,
              session_id: sessionId,
              request_id: requestId,
              details:
                requestDetails ||
                buildRequestDetails(req, {
                  body_source,
                  body_source_detail,
                  raw_text_preview,
                  raw_text_starts_with_brace,
                }),
              error: {
                code: "IMPORT_STOPPED",
                message: "Import was stopped",
                request_id: requestId,
                step: stage,
              },
              legacy_error: "Import was stopped",
              ...buildInfo,
              companies: [],
              saved: 0,
            },
            200
          );
          }
        }

        let xaiCallMeta = null;

        // Build XAI request messages (never allow empty messages)
        setStage("build_prompt", { queryTypes });

        xaiCallMeta = {
          handler_version: handlerVersion,
          stage: "build_prompt",
          queryTypes,
          query_len: query.length,
          prompt_len: 0,
          messages_len: 0,
          has_system_message: false,
          has_user_message: false,
          user_message_len: 0,
          // Back-compat
          has_system_content: false,
          has_user_content: false,
        };

        if (!query) {
          return respondError(new Error("Missing query"), {
            status: 400,
            details: {
              code: "IMPORT_START_BUILD_PROMPT_FAILED",
              message: "Missing query",
              queryTypes,
              prompt_len: xaiCallMeta.prompt_len,
              meta: xaiCallMeta,
            },
          });
        }

        let promptString = "";

        if (queryTypes.includes("company_url")) {
          // When company_url_hint is provided, the query field contains the company name
          // and the URL is in the hint. Otherwise, the query IS the URL.
          const urlForPrompt = xaiPayload.company_url_hint || query;
          const nameForPrompt = xaiPayload.company_url_hint ? query : "";

          promptString = `You are a business research assistant specializing in manufacturing location extraction.

Company website URL: ${urlForPrompt}
${nameForPrompt ? `Company name: ${nameForPrompt}\n` : ""}
Extract the company details represented by this URL.${nameForPrompt ? ` The company is known as "${nameForPrompt}".` : ""}

Return ONLY a valid JSON array (no markdown, no prose). The array should contain 1 item.
Each item must follow this schema:
{
  "company_name": "",
  "website_url": "",
  "industries": [""],
  "product_keywords": "",
  "headquarters_location": "",
  "manufacturing_locations": [""],
  "location_sources": [
    {
      "location": "",
      "source_url": "",
      "source_type": "official_website|government_guide|b2b_directory|trade_data|packaging|media|other",
      "location_type": "headquarters|manufacturing"
    }
  ],
  "red_flag": false,
  "red_flag_reason": "",
  "tagline": "",
  "social": {
    "linkedin": "",
    "instagram": "",
    "x": "",
    "twitter": "",
    "facebook": "",
    "tiktok": "",
    "youtube": ""
  },
  "location_confidence": "high|medium|low"
}

Return strictly valid JSON only.`;
        } else {
          promptString = `You are a business research assistant specializing in manufacturing location extraction. Find and return information about ${xaiPayload.limit} DIFFERENT companies or products based on this search.

Search query: "${xaiPayload.query}"
Search type(s): ${xaiPayload.queryType}
${xaiPayload.company_url_hint ? `Known website: ${xaiPayload.company_url_hint}
- Use this website as the primary source for the company. The search query is the company's real name.
` : ""}${xaiPayload.location ? `
Location boost: "${xaiPayload.location}"
- If you can, prefer and rank higher companies whose HQ or manufacturing locations match this location.
- The location is OPTIONAL; do not block the import if it is empty.
` : ""}

CRITICAL PRIORITY #1: HEADQUARTERS & MANUFACTURING LOCATIONS (THIS IS THE TOP VALUE PROP)
These location fields are FIRST-CLASS and non-negotiable. Be AGGRESSIVE and MULTI-SOURCE in extraction - do not accept "website is vague" as final answer.

1. HEADQUARTERS LOCATION (Required, high priority):
   - Extract the company's headquarters location at minimum: city, state/region, country.
   - If no street address is available, that is acceptable - city + state/region + country is the minimum acceptable.
   - Use the company's official "Headquarters", "Head Office", or primary corporate address.
   - Check: Official website's About/Contact pages, LinkedIn company profile, Crunchbase, business directories.
   - If the website's Contact page is missing/404, use the header/footer contact info and the Terms/Privacy pages for the company address.
   - Acceptable formats: "San Francisco, CA, USA" or "London, UK" or "Tokyo, Japan"

   IMPORTANT: Government Buyer Guides and Business Directories often list headquarters with complete address.
   Examples: Yumpu (government buyers guide), Dun & Bradstreet, LinkedIn, Crunchbase, Google Business, SIC/NAICS registries.

2. MANUFACTURING LOCATIONS (Array, STRONGLY REQUIRED - be aggressive and multi-source):
   - Gather ALL identifiable manufacturing, production, factory, and plant locations from ALL available sources.
   - Return as an array of strings, each string being a location. DO NOT leave this empty unless there is truly no credible signal.
   - Acceptable detail per entry: Full address OR City + state/region + country OR country only (e.g., "United States", "China").
   - "Country only" manufacturing locations are FULLY ACCEPTABLE and PREFERRED over empty array.
   - Examples of acceptable results: ["Charlotte, NC, USA", "Shanghai, China", "Vietnam", "United States", "Mexico"]

   PRIMARY SOURCES (check ALL of these first):
   a) Official website: "Facilities", "Plants", "Manufacturing", "Where We Make", "Our Factories", "Production Sites" pages
   b) Product pages: Any "Made in X" labels or manufacturing claims on product listings and packaging photos
   c) FAQ or policy pages: "Where is this made?", "Manufacturing standards", "Supply chain" sections
   d) About/Sustainability: "Where we produce", "Supply chain transparency", "Ethical sourcing" pages
   e) Job postings: Roles mentioning "factory", "plant", "warehouse", "production", "manufacturing" reveal facility locations
   f) LinkedIn company profile: Manufacturing locations and facility information often listed in company description

   SECONDARY SOURCES - USE THESE AGGRESSIVELY WHEN PRIMARY SOURCES ARE VAGUE (these are just as credible):
   g) Government Buyer Guides & Federal Databases:
      - Yumpu government buyer guide listings (often list exact location, products, "all made in USA" claims)
      - GSA Schedules and federal procurement databases
      - State business registrations and Secretary of State records
      - These databases often capture manufacturer status and location explicitly

   h) B2B and Industrial Manufacturer Directories:
      - Thomas Register (thomasnet.com) - explicitly lists manufacturers by industry and location
      - SIC/NAICS manufacturer registries
      - Industrial manufacturer databases (SJN databases, Kompass, etc.)
      - These sources EXPLICITLY note if a company is a "Manufacturer" vs. reseller, and list facility locations

   i) Public Import/Export Records and Trade Data:
      - Customs data, shipping records, and trade databases showing origin countries
      - Alibaba, Global Sources, and other trade platform records showing source locations
      - Repeated shipments from specific countries (China, Vietnam, etc.) indicate manufacturing origin

   j) Supplier Databases and Records:
      - Known suppliers and manufacturing partners reveal facility regions
      - Supply chain data aggregators often show where goods originate

   k) Packaging and Product Labeling:
      - "Made in..." text on actual product images, packaging, inserts, or labels found online
      - Manufacturing claims in product descriptions and certifications

   l) Media, Press, and Third-Party Sources:
      - Industry articles, news, blog posts, or investigations mentioning manufacturing locations
      - Product review sites that mention where items are made
      - LinkedIn company posts discussing facilities or manufacturing

   m) Financial/Regulatory Filings:
      - SEC filings, annual reports, business registrations mentioning facilities
      - Patent filings showing inventor locations (sometimes reveals manufacturing)

   INFERENCE RULES FOR MANUFACTURING LOCATIONS:
   - If a brand shows repeated shipments from a specific region in trade records (China, Vietnam, Mexico), include that region
   - If government guides or B2B directories list the company as a "Manufacturer" with specific location, include that location
   - If packaging or product listings consistently say "Made in [X]", include X even if the brand website doesn't explicitly state it
   - If multiple independent sources consistently point to one or more countries, include those countries
   - "All made in the USA" or similar inclusive statements â†’ manufacturing_locations: ["United States"]
   - If only country-level information is available after exhaustive checking, country-only entries are FULLY VALID and PREFERRED
   - When inferring from suppliers, customs, packaging, or government guides, set location_confidence to "medium" and note the inference source in red_flag_reason
   - Inferred manufacturing locations from secondary sources should NOT trigger red_flag: true (the flag is only for completely unknown locations)

3. CONFIDENCE AND RED FLAGS:
   - location_confidence: "high" if HQ and manufacturing are clearly stated on official site; "medium" if inferred from reliable secondary sources (government guides, B2B directories, customs, packaging); "low" if from limited sources
   - If HQ is found but manufacturing is completely unknown AFTER exhaustive checking â†’ red_flag: true, reason: "Manufacturing location unknown, not found in official site, government guides, B2B directories, customs records, or packaging"
   - If manufacturing is inferred from government guides, B2B directories, customs data, suppliers, or packaging â†’ red_flag: false (this is NOT a reason to flag), location_confidence: "medium"
   - If BOTH HQ and manufacturing are documented â†’ red_flag: false, reason: ""
   - Only leave manufacturing_locations empty and red_flag: true if there is TRULY no credible signal after checking government guides, B2B directories, custom records, supplier data, packaging, and media

4. SOURCE PRIORITY FOR HQ:
   a) Official website: About, Contact, Locations, Head Office sections
   b) Government Buyer Guides and business databases (Yumpu, GSA, state registrations)
   c) B2B directories (Thomas Register, etc.) and LinkedIn company profile
   d) Crunchbase / public business directories
   e) News and public records

5. LOCATION SOURCES (Required for structured data):
   - For EVERY location (both HQ and manufacturing) you extract, provide the source information in location_sources array
   - Each entry in location_sources must have:
     a) location: the exact location string (e.g., "San Francisco, CA, USA")
     b) source_url: the URL where this location was found (or empty string if no specific URL)
     c) source_type: one of: official_website, government_guide, b2b_directory, trade_data, packaging, media, other
     d) location_type: either "headquarters" or "manufacturing"
   - This allows us to display source attribution to users and verify data quality
   - Example: { "location": "Shanghai, China", "source_url": "https://company.com/facilities", "source_type": "official_website", "location_type": "manufacturing" }

6. TAGLINE (Optional but valuable):
   - Extract the company's official tagline, mission statement, or brand slogan if available
   - Check: Company website homepage, About page, marketing materials, "Tagline" or "Slogan" field
   - If no explicit tagline found, leave empty (do NOT fabricate)
   - Example: "Tagline": "Where Quality Meets Innovation" or empty string ""

7. PRODUCT KEYWORDS (Required - MUST follow these rules strictly):
   You are extracting structured product intelligence for a consumer-facing company.
   Your task is to generate a comprehensive, concrete list of the companyâ€™s actual products and product categories.
   Rules:
   â€¢ Return up to 25 product keywords
   â€¢ Each keyword must be a real product, product line, or specific product category
   â€¢ Avoid vague marketing terms (e.g., â€œpremium,â€ â€œhigh-quality,â€ â€œinnovative,â€ â€œlifestyleâ€)
   â€¢ Prefer noun-based product names
   â€¢ Include both flagship products and secondary products
   â€¢ If exact product names are not available, infer industry-standard product types sold by the company
   â€¢ Do NOT repeat near-duplicates (e.g., â€œwater bottleâ€ and â€œbottlesâ€)
   â€¢ Do NOT include services unless the company primarily sells services
   Output format for product_keywords field:
   â€¢ Return a comma-separated list
   â€¢ Maximum 25 items
   â€¢ No explanations or extra text

CRITICAL REQUIREMENTS FOR THIS SEARCH:
- Do NOT return empty manufacturing_locations arrays unless you have exhaustively checked government guides, B2B directories, and trade data
- Do NOT treat "not explicitly stated on website" as "manufacturing location unknown" - use secondary sources
- Always prefer country-level manufacturing locations (e.g., "United States") over empty arrays
- Government Buyer Guides (like Yumpu entries) are CREDIBLE PRIMARY sources for both HQ and manufacturing claims
- Companies listed in B2B manufacturer directories should have their listed location included
- For EACH location returned, MUST have a corresponding entry in location_sources array (this is non-negotiable)

SECONDARY: DIVERSITY & COVERAGE
- Prioritize smaller, regional, and lesser-known companies (40% small/regional/emerging, 35% mid-market, 25% major brands)
- Return DIVERSE companies - independent manufacturers, local producers, regional specialists, family-owned businesses, emerging/niche players
- Include regional and international companies
- Verify each company URL is valid

FORMAT YOUR RESPONSE AS A VALID JSON ARRAY. EACH OBJECT MUST HAVE:
- company_name (string): Exact company name
- website_url (string): Valid company website URL (must work)
- industries (array): Industry categories
- product_keywords (string): Comma-separated list of up to 25 concrete product keywords (real products/product lines/product categories; no vague marketing terms; prefer noun phrases; include flagship + secondary products; infer industry-standard product types if needed; no near-duplicates; no services unless primarily services)
- headquarters_location (string, REQUIRED): "City, State/Region, Country" format (or empty string ONLY if truly unknown after checking all sources)
- manufacturing_locations (array, REQUIRED): Array of location strings (MUST include all credible sources - official, government guides, B2B directories, suppliers, customs, packaging labels). Use country-only entries (e.g., "United States") if that's all that's known.
- location_sources (array, REQUIRED): Array of objects with structure: { "location": "City, State, Country", "source_url": "https://...", "source_type": "official_website|government_guide|b2b_directory|trade_data|packaging|media|other", "location_type": "headquarters|manufacturing" }. Include ALL sources found for both HQ and manufacturing locations.
- red_flag (boolean, REQUIRED): true only if HQ unknown or manufacturing completely unverifiable despite exhaustive checking of ALL sources including government guides and B2B directories
- red_flag_reason (string, REQUIRED): Explanation if red_flag=true, empty string if false; may note if manufacturing was inferred from secondary sources
- hq_lat (number, optional): Headquarters latitude
- hq_lng (number, optional): Headquarters longitude
- amazon_url (string, optional): Amazon storefront URL
- tagline (string, optional): Company's official tagline or mission statement (from website or marketing materials)
- social (object, optional): Social media URLs {linkedin, instagram, x, twitter, facebook, tiktok, youtube}
- location_confidence (string, optional): "high", "medium", or "low" based on data quality and sources used

IMPORTANT FINAL RULES:
1. For companies with vague or missing manufacturing info on their website, ALWAYS check government guides, B2B directories, suppliers, import records, packaging claims, and third-party sources BEFORE returning an empty manufacturing_locations array.
2. Country-only manufacturing locations (e.g., ["United States"]) are FULLY ACCEPTABLE results - do NOT treat them as incomplete.
3. If government sources (like Yumpu buyer guides) list "all made in the USA", return manufacturing_locations: ["United States"] with high confidence.
4. Only flag as red_flag: true when you have actually exhaustively checked all sources listed above and still have no credible signal.

Return ONLY the JSON array, no other text. Return at least ${Math.max(1, xaiPayload.limit)} diverse results if possible.`;
        }

        promptString = String(promptString || "").trim();
        xaiCallMeta.prompt_len = promptString.length;

        if (!promptString) {
          setStage("build_prompt", { error: "Empty prompt" });
          return respondError(new Error("Empty prompt"), {
            status: 400,
            details: {
              code: "IMPORT_START_BUILD_PROMPT_FAILED",
              message: "Empty prompt",
              queryTypes,
              prompt_len: xaiCallMeta.prompt_len,
              meta: xaiCallMeta,
            },
          });
        }

        logImportStartMeta({
          request_id: requestId,
          session_id: sessionId,
          handler_version: handlerVersion,
          stage: "build_prompt",
          queryTypes,
          query_len: query.length,
          prompt_len: xaiCallMeta.prompt_len,
          messages_len: 0,
          has_system_message: false,
          has_user_message: false,
          user_message_len: 0,
          elapsedMs: Date.now() - startTime,
          upstream_status: null,
        });

        setStage("build_messages");

        const promptInput = typeof bodyObj.prompt === "string" ? bodyObj.prompt.trim() : "";

        const SAFE_SYSTEM_PROMPT =
          typeof XAI_SYSTEM_PROMPT === "string" && XAI_SYSTEM_PROMPT.trim()
            ? XAI_SYSTEM_PROMPT
            : "You are a helpful assistant.";

        const ALLOWED_ROLES = new Set(["system", "user", "assistant", "tool"]);

        const buildFallbackPromptFromRequest = () => {
          const qt = Array.isArray(queryTypes) ? queryTypes.map((t) => String(t || "").trim()).filter(Boolean) : [];
          const limitVal = Number.isFinite(Number(xaiPayload?.limit)) ? Number(xaiPayload.limit) : 0;
          const location = typeof bodyObj.location === "string" ? bodyObj.location.trim() : "";
          const center = safeCenter(bodyObj.center);
          const centerStr = center ? `${center.lat},${center.lng}` : "";

          const lines = [];
          if (String(query || "").trim()) lines.push(`Query: ${String(query).trim()}`);
          if (qt.length) lines.push(`QueryTypes: ${qt.join(", ")}`);
          if (Number.isFinite(limitVal) && limitVal > 0) lines.push(`Limit: ${limitVal}`);
          if (location) lines.push(`Location: ${location}`);
          else if (centerStr) lines.push(`Center: ${centerStr}`);

          return lines.join("\n").trim();
        };

        const builtUserPrompt = (promptInput || promptString || buildFallbackPromptFromRequest()).trim();

        const parseAndValidateProvidedMessages = (raw) => {
          if (!Array.isArray(raw)) {
            return { ok: false, reason: "MESSAGES_NOT_ARRAY", messages: [] };
          }

          const out = [];
          for (let i = 0; i < raw.length; i += 1) {
            const m = raw[i];
            if (!m || typeof m !== "object") return { ok: false, reason: "MESSAGE_NOT_OBJECT", index: i, messages: [] };

            const role = typeof m.role === "string" ? m.role.trim() : "";
            if (!role || !ALLOWED_ROLES.has(role)) {
              return { ok: false, reason: "INVALID_ROLE", index: i, messages: [] };
            }

            if (typeof m.content !== "string") {
              return { ok: false, reason: "NON_STRING_CONTENT", index: i, messages: [] };
            }

            const content = m.content.trim();
            if (!content) {
              return { ok: false, reason: "EMPTY_CONTENT", index: i, messages: [] };
            }

            out.push({ role, content });
          }

          return { ok: true, messages: out };
        };

        const ensureSystemAndUser = (rawMessages, { userFallback }) => {
          const out = Array.isArray(rawMessages) ? [...rawMessages] : [];

          const hasSystem = out.some((m) => m?.role === "system" && typeof m.content === "string" && m.content.trim());
          const hasUser = out.some((m) => m?.role === "user" && typeof m.content === "string" && m.content.trim());

          if (!hasSystem) out.unshift({ role: "system", content: SAFE_SYSTEM_PROMPT });
          if (!hasUser) {
            const fb = typeof userFallback === "string" ? userFallback.trim() : "";
            if (fb) out.push({ role: "user", content: fb });
          }

          return out;
        };

        const buildMessageDebugFields = (msgs) => {
          const arr = Array.isArray(msgs) ? msgs : [];
          const system_count = arr.filter((m) => m?.role === "system").length;
          const user_count = arr.filter((m) => m?.role === "user").length;
          const system_content_len =
            system_count > 0
              ? (typeof arr.find((m) => m?.role === "system")?.content === "string"
                  ? arr.find((m) => m?.role === "system").content.trim().length
                  : 0)
              : 0;
          const user_content_len =
            user_count > 0
              ? (typeof arr.find((m) => m?.role === "user")?.content === "string"
                  ? arr.find((m) => m?.role === "user").content.trim().length
                  : 0)
              : 0;

          return {
            messages_len: arr.length,
            system_count,
            user_count,
            system_content_len,
            user_content_len,
            prompt_len: builtUserPrompt.length,
            handler_version: handlerVersion,
            mode: String(bodyObj.mode || "direct"),
            queryTypes,
          };
        };

        const validateMessagesForUpstream = (msgs) => {
          if (!Array.isArray(msgs) || msgs.length < 2) {
            return { ok: false, reason: "MESSAGES_TOO_SHORT" };
          }

          let system_count = 0;
          let user_count = 0;

          for (let i = 0; i < msgs.length; i += 1) {
            const m = msgs[i];
            if (!m || typeof m !== "object") return { ok: false, reason: "MESSAGE_NOT_OBJECT" };
            if (m.role === "system") system_count += 1;
            if (m.role === "user") user_count += 1;
            if (typeof m.content !== "string" || m.content.trim().length === 0) {
              return { ok: false, reason: "EMPTY_CONTENT" };
            }
          }

          if (system_count < 1 || user_count < 1) {
            return { ok: false, reason: "MISSING_SYSTEM_OR_USER" };
          }

          return { ok: true, system_count, user_count };
        };

        let messages;
        if (Object.prototype.hasOwnProperty.call(bodyObj, "messages")) {
          const raw = bodyObj.messages;

          if (Array.isArray(raw) && raw.length === 0) {
            // Builder bug recovery: if messages is [], always auto-generate from prompt/query.
            messages = [
              { role: "system", content: SAFE_SYSTEM_PROMPT },
              { role: "user", content: builtUserPrompt },
            ];
          } else {
            const parsed = parseAndValidateProvidedMessages(raw);
            if (!parsed.ok) {
              const rawArr = Array.isArray(raw) ? raw : [];
              const system_count = rawArr.filter((m) => m && typeof m === "object" && m.role === "system").length;
              const user_count = rawArr.filter((m) => m && typeof m === "object" && m.role === "user").length;
              const firstSystem = rawArr.find((m) => m && typeof m === "object" && m.role === "system");
              const firstUser = rawArr.find((m) => m && typeof m === "object" && m.role === "user");

              const debugFields = {
                messages_len: rawArr.length,
                system_count,
                user_count,
                system_content_len: typeof firstSystem?.content === "string" ? firstSystem.content.trim().length : 0,
                user_content_len: typeof firstUser?.content === "string" ? firstUser.content.trim().length : 0,
                prompt_len: typeof builtUserPrompt === "string" ? builtUserPrompt.length : 0,
                handler_version: handlerVersion,
                mode: String(bodyObj.mode || "direct"),
                queryTypes,
              };
              setStage("build_messages", { error: parsed.reason });
              return respondError(new Error("Invalid messages"), {
                status: 400,
                details: {
                  code: "EMPTY_MESSAGE_CONTENT_BUILDER_BUG",
                  message: "Invalid messages content (refusing to call upstream)",
                  ...debugFields,
                  meta: {
                    ...xaiCallMeta,
                    stage: "build_messages",
                    ...debugFields,
                    error: parsed.reason,
                  },
                },
              });
            }

            messages = ensureSystemAndUser(parsed.messages, { userFallback: builtUserPrompt });
          }
        } else {
          messages = [
            { role: "system", content: SAFE_SYSTEM_PROMPT },
            { role: "user", content: builtUserPrompt },
          ];
        }

        xaiCallMeta.prompt_input_len = promptInput.length;

        const debugFields = buildMessageDebugFields(messages);
        const validation = validateMessagesForUpstream(messages);

        xaiCallMeta.prompt_len = debugFields.prompt_len;
        xaiCallMeta.messages_len = debugFields.messages_len;
        xaiCallMeta.has_system_message = debugFields.system_count > 0;
        xaiCallMeta.has_user_message = debugFields.user_count > 0;
        xaiCallMeta.user_message_len = debugFields.user_content_len;
        xaiCallMeta.system_message_len = debugFields.system_content_len;
        xaiCallMeta.system_count = debugFields.system_count;
        xaiCallMeta.user_count = debugFields.user_count;

        if (!validation.ok) {
          setStage("build_messages", { error: validation.reason });
          return respondError(new Error("Invalid messages"), {
            status: 400,
            details: {
              code: "EMPTY_MESSAGE_CONTENT_BUILDER_BUG",
              message: "Invalid messages content (refusing to call upstream)",
              ...debugFields,
              meta: {
                ...xaiCallMeta,
                stage: "build_messages",
                ...debugFields,
                error: validation.reason,
              },
            },
          });
        }

        if (debugOutput) {
          debugOutput.xai.prompt_len = typeof builtUserPrompt === "string" ? builtUserPrompt.length : 0;
        }

        const xaiRequestPayload = {
          model: xaiModel,
          messages,
          temperature: 0.1,
          stream: false,
        };

        try {
          // Hard guard right before upstream fetch.
          const guardDebugFields = typeof buildMessageDebugFields === "function"
            ? buildMessageDebugFields(xaiRequestPayload.messages)
            : {
                messages_len: Array.isArray(xaiRequestPayload.messages) ? xaiRequestPayload.messages.length : 0,
                system_count: 0,
                user_count: 0,
                system_content_len: 0,
                user_content_len: 0,
                prompt_len: typeof builtUserPrompt === "string" ? builtUserPrompt.length : 0,
                handler_version: handlerVersion,
                mode: String(bodyObj.mode || "direct"),
                queryTypes,
              };

          const guardValidation = typeof validateMessagesForUpstream === "function"
            ? validateMessagesForUpstream(xaiRequestPayload.messages)
            : { ok: Array.isArray(xaiRequestPayload.messages) && xaiRequestPayload.messages.length >= 2 };

          if (!guardValidation.ok) {
            return respondError(new Error("Invalid messages"), {
              status: 400,
              details: {
                code: "EMPTY_MESSAGE_CONTENT_BUILDER_BUG",
                message: "Invalid messages content (refusing to call upstream)",
                ...guardDebugFields,
                meta: {
                  ...xaiCallMeta,
                  stage: "xai_call",
                  ...guardDebugFields,
                  error: guardValidation.reason || "INVALID_MESSAGES",
                },
              },
            });
          }

          if (noUpstreamMode) {
            setStage("no_upstream");
            return json(
              {
                ok: true,
                messages_len: Number(guardDebugFields?.messages_len) || 0,
                system_count: Number(guardDebugFields?.system_count) || 0,
                user_count: Number(guardDebugFields?.user_count) || 0,
                resolved_upstream_url_redacted: redactUrlQueryAndHash(xaiUrl) || null,
                auth_header_present: Boolean(xaiKey),
              },
              200,
              responseHeaders
            );
          }

          setStage("searchCompanies", {
            queryType: xaiPayload.queryType,
            limit: xaiPayload.limit,
          });

          xaiCallMeta.stage = "xai_call";
          const elapsedMs = Date.now() - startTime;

          logImportStartMeta({
            request_id: requestId,
            session_id: sessionId,
            handler_version: handlerVersion,
            stage: "xai_call",
            queryTypes,
            query_len: query.length,
            prompt_len: xaiCallMeta.prompt_len,
            messages_len: xaiCallMeta.messages_len,
            has_system_message: xaiCallMeta.has_system_message,
            has_user_message: xaiCallMeta.has_user_message,
            user_message_len: xaiCallMeta.user_message_len,
            elapsedMs,
            upstream_status: null,
          });

          const explainRaw = Object.prototype.hasOwnProperty.call(bodyObj || {}, "explain")
            ? bodyObj.explain
            : readQueryParam(req, "explain");
          const explainMode = isProxyExplicitlyEnabled(explainRaw);

          const outboundBody = JSON.stringify(xaiRequestPayload);
          primaryXaiOutboundBody = outboundBody;
          const payload_meta = buildXaiPayloadMetaSnapshotFromOutboundBody(outboundBody, {
            handler_version: handlerVersion,
            build_id: buildInfo?.build_id || "",
          });

          if (debugOutput) {
            debugOutput.xai.payload_meta = payload_meta;
          }

          try {
            ensureValidOutboundXaiBodyOrThrow(payload_meta);
          } catch (e) {
            return respondError(e instanceof Error ? e : new Error(String(e || "Invalid messages")), {
              status: 400,
              details: {
                code: "EMPTY_MESSAGE_CONTENT_BUILDER_BUG",
                message: "Invalid messages content (refusing to call upstream)",
                ...payload_meta,
              },
            });
          }

          if (explainMode) {
            setStage("explain");

            const execution_plan = buildXaiExecutionPlan(xaiPayload);
            const upstream_resolution = buildUpstreamResolutionSnapshot({
              url: xaiUrl,
              authHeaderValue: xaiKey ? "Bearer [REDACTED]" : "",
              timeoutMsUsed: timeout,
              executionPlan: execution_plan,
            });

            return jsonWithRequestId(
              {
                ok: true,
                explain: true,
                session_id: sessionId,
                request_id: requestId,
                payload_meta,
                ...upstream_resolution,
              },
              200
            );
          }

          console.log(`[import-start] Calling XAI API at: ${toHostPathOnlyForLog(xaiUrl)}`);

          let inputCompanies = (Array.isArray(bodyObj.companies) ? bodyObj.companies : [])
            .filter((it) => it && typeof it === "object")
            .slice(0, 500);

          // NOTE: company_url imports should still attempt the upstream primary call (it tends to be the
          // best source for HQ + manufacturing), but we must NOT ever return 202 for company_url.
          // If primary times out, we fall back to a local URL seed and continue downstream enrichment inline.
          function buildCompanyUrlSeedFromQuery(rawQuery) {
            // When company_url_hint is provided, the URL source is the hint
            // and the rawQuery contains the real company name.
            const hintUrl = String(xaiPayload.company_url_hint || "").trim();
            const urlSource = hintUrl || String(rawQuery || "").trim();
            const q = urlSource;

            let parsed = null;
            try {
              parsed = q.includes("://") ? new URL(q) : new URL(`https://${q}`);
            } catch {
              parsed = null;
            }

            const hostnameFromParsed = parsed ? String(parsed.hostname || "").trim() : "";
            const fallbackHost = q.replace(/^https?:\/\//i, "").split("/")[0].trim();
            const hostname = hostnameFromParsed || fallbackHost;

            const cleanHost = String(hostname || "").toLowerCase().replace(/^www\./, "");

            // If we cannot extract a hostname, do NOT seed a company doc.
            // This prevents accumulating "seed-fallback" junk rows with normalized_domain="unknown".
            if (!cleanHost) return null;

            // Required semantics:
            // - company_url + website_url should reflect the input URL (normalized to include protocol).
            // - canonical_url should be the normalized canonical host URL.
            const inputUrl = (() => {
              if (parsed) return parsed.toString();
              if (cleanHost) return `https://${cleanHost}/`;
              return q;
            })();

            const canonicalUrl = cleanHost ? `https://${cleanHost}/` : inputUrl;

            // Use real company name when provided via company_url_hint flow;
            // otherwise guess from domain as before.
            const realName = hintUrl ? String(rawQuery || "").trim() : "";
            const companyName = realName || (() => {
              const base = cleanHost ? cleanHost.split(".")[0] : "";
              if (!base) return cleanHost || canonicalUrl || inputUrl;
              return base.charAt(0).toUpperCase() + base.slice(1);
            })();

            const nowIso = new Date().toISOString();

            // NOTE: saveCompaniesToCosmos refuses to persist URL shortcuts unless they show
            // "meaningful enrichment". For a seed, we encode "attempted but unknown" markers so
            // the record can be saved and later upgraded by resume-worker.
            return {
              company_name: companyName,
              company_url: inputUrl,
              website_url: inputUrl,
              canonical_url: canonicalUrl,
              url: inputUrl,
              normalized_domain: cleanHost,
              source: "company_url_shortcut",
              candidate: false,
              source_stage: "seed",
              seed_ready: true,
              hq_unknown: true,
              hq_unknown_reason: "seed_from_company_url",
              mfg_unknown: true,
              mfg_unknown_reason: "seed_from_company_url",
              red_flag_reason: "Imported from URL; enrichment pending",
              curated_reviews: [],
              review_count: 0,
              reviews_stage_status: "pending",
              logo_stage_status: "pending",
              reviews_last_updated_at: nowIso,
              review_cursor: {
                exhausted: false,
                last_error: {
                  code: "SEED_FROM_COMPANY_URL",
                  message: "Seed created from URL; enrichment pending",
                },
              },
            };
          }

          async function respondWithCompanyUrlSeedFallback(acceptedError) {
            const seed = buildCompanyUrlSeedFromQuery(query);
            if (!seed || typeof seed !== "object") {
              const errorAt = new Date().toISOString();
              try {
                upsertImportSession({
                  session_id: sessionId,
                  request_id: requestId,
                  status: "error",
                  stage_beacon: "company_url_seed_invalid",
                  resume_needed: false,
                  resume_error: "invalid_company_url",
                  resume_error_details: {
                    root_cause: "invalid_company_url",
                    message: "company_url query did not contain a valid hostname; refusing to seed a company doc",
                    updated_at: errorAt,
                  },
                });
              } catch {}

              if (cosmosEnabled) {
                try {
                  await upsertCosmosImportSessionDoc({
                    sessionId,
                    requestId,
                    patch: {
                      status: "error",
                      stage_beacon: "company_url_seed_invalid",
                      resume_needed: false,
                      resume_error: "invalid_company_url",
                      resume_error_details: {
                        root_cause: "invalid_company_url",
                        message: "company_url query did not contain a valid hostname; refusing to seed a company doc",
                        updated_at: errorAt,
                      },
                      updated_at: errorAt,
                    },
                  }).catch(() => null);
                } catch {}
              }

              return jsonWithRequestId(
                {
                  ok: false,
                  session_id: sessionId,
                  request_id: requestId,
                  stage_beacon: "company_url_seed_invalid",
                  status: "error",
                  error: "invalid_company_url",
                  message: "company_url query did not contain a valid hostname; refusing to seed a company doc",
                },
                200
              );
            }

            const companies = [seed];

            const dryRunRequested = Boolean(bodyObj?.dry_run || bodyObj?.dryRun);

            const missing_by_company = [
              {
                company_name: seed.company_name,
                website_url: seed.website_url,
                normalized_domain: seed.normalized_domain,
                missing_fields: [
                  "industries",
                  "product_keywords",
                  "headquarters_location",
                  "manufacturing_locations",
                  "reviews",
                  "logo",
                ],
              },
            ];

            let saveResult = {
              saved: 0,
              skipped: 0,
              failed: 0,
              saved_ids: [],
              skipped_ids: [],
              skipped_duplicates: [],
              failed_items: [],
            };

            const canPersist = !dryRunRequested && cosmosEnabled;

            if (canPersist) {
              sessionCreatedAtIso ||= new Date().toISOString();

              try {
                const container = getCompaniesCosmosContainer();

                // Dedupe rule (imports): normalized_domain is the primary key; canonical_url is a secondary matcher.
                // This prevents "seed-fallback" duplicates accumulating when URL formatting differs.
                const existingRow = await findExistingCompany(
                  container,
                  seed.normalized_domain,
                  seed.company_name,
                  seed.canonical_url
                ).catch(() => null);

                const duplicateOfId = existingRow && existingRow.id ? String(existingRow.id).trim() : "";

                if (duplicateOfId && container) {
                  const existingMissing = Array.isArray(existingRow?.import_missing_fields) ? existingRow.import_missing_fields : [];

                  // "Verified" for import-start seed-fallback means the minimum required fields exist
                  // (name + website). Enrichment completeness is handled by resume-worker.
                  const existingVerified = Boolean(
                    asMeaningfulString(existingRow?.company_name || existingRow?.name || "") &&
                      asMeaningfulString(existingRow?.website_url || existingRow?.company_url || existingRow?.url || "")
                  );

                  const outcome = existingVerified
                    ? "duplicate_detected"
                    : "duplicate_detected_unverified_missing_required_fields";

                  saveResult = {
                    saved: existingVerified ? 1 : 0,
                    skipped: 0,
                    failed: 0,
                    saved_ids: existingVerified ? [duplicateOfId] : [],
                    skipped_ids: [],
                    skipped_duplicates: [
                      {
                        duplicate_of_id: duplicateOfId,
                        match_key: existingRow?.duplicate_match_key || "normalized_domain",
                        match_value:
                          existingRow?.duplicate_match_value ||
                          String(seed.normalized_domain || "").trim() ||
                          String(seed.canonical_url || "").trim() ||
                          null,
                      },
                    ],
                    failed_items: [],
                    saved_company_ids_verified: existingVerified ? [duplicateOfId] : [],
                    saved_company_ids_unverified: existingVerified ? [] : [duplicateOfId],
                    saved_verified_count: existingVerified ? 1 : 0,
                    saved_write_count: 0,
                    saved_ids_write: [],
                    duplicate_of_id: duplicateOfId,
                    duplicate_existing_incomplete: !existingVerified,
                    duplicate_existing_missing_fields: existingVerified ? [] : existingMissing.slice(0, 20),
                    save_outcome: outcome,
                  };
                } else {
                  const isExplicitCompanyImport =
                    String(bodyObj?.queryType || "").trim() === "company_url" ||
                    Boolean(String(bodyObj?.company_url_hint || "").trim());
                  const saveResultRaw = await saveCompaniesToCosmos({
                    companies,
                    sessionId,
                    requestId,
                    sessionCreatedAt: sessionCreatedAtIso,
                    axiosTimeout: Math.min(timeout, 20_000),
                    saveStub: Boolean(bodyObj?.save_stub || bodyObj?.saveStub),
                    getRemainingMs,
                    allowUpdateExisting: isExplicitCompanyImport,
                  });

                  const verification = await verifySavedCompaniesReadAfterWrite(saveResultRaw).catch(() => ({
                    verified_ids: [],
                    unverified_ids: Array.isArray(saveResultRaw?.saved_ids) ? saveResultRaw.saved_ids : [],
                    verified_persisted_items: [],
                  }));

                  saveResult = applyReadAfterWriteVerification(saveResultRaw, verification);
                }
              } catch (e) {
                const errorMessage = toErrorString(e);

                addWarning("company_url_seed_save_failed", {
                  stage: "save",
                  root_cause: "seed_save_failed",
                  retryable: true,
                  message: `Failed to persist URL seed: ${errorMessage}`,
                });

                saveResult = {
                  ...saveResult,
                  saved: 0,
                  saved_ids: [],
                  failed: Math.max(1, Number(saveResult.failed || 0) || 0),
                  failed_items: [
                    {
                      index: 0,
                      company_name: seed.company_name,
                      error: errorMessage,
                    },
                  ],
                };
              }

              saveReport = saveResult;
            }

            const queryUrlForTelemetry = String(seed.company_url || seed.website_url || seed.url || "").trim();
            const normalizedDomainForTelemetry = String(seed.normalized_domain || "").trim();

            const getDuplicateOfId = (result) => {
              const dup =
                Array.isArray(result?.skipped_duplicates)
                  ? result.skipped_duplicates
                      .map((d) => String(d?.duplicate_of_id || "").trim())
                      .find(Boolean)
                  : "";
              if (dup) return dup;

              const fromSkippedIds =
                Array.isArray(result?.skipped_ids)
                  ? result.skipped_ids.map((id) => String(id || "").trim()).find(Boolean)
                  : "";
              return fromSkippedIds || "";
            };

            let save_outcome = "not_persisted";
            if (dryRunRequested) save_outcome = "dry_run";

            if (canPersist) {
              const verifiedCountPre = Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0;
              const writeCountPre = Number(saveResult.saved_write_count || 0) || 0;

              if (verifiedCountPre > 0) {
                save_outcome = "saved_verified";
              } else if (getDuplicateOfId(saveResult)) {
                save_outcome = "duplicate_detected";
              } else if (
                writeCountPre > 0 &&
                Array.isArray(saveResult.saved_company_ids_unverified) &&
                saveResult.saved_company_ids_unverified.length > 0
              ) {
                save_outcome = "saved_unverified_missing_required_fields";
              } else if (writeCountPre > 0) {
                save_outcome = "read_after_write_failed";
              } else if (Number(saveResult.failed || 0) > 0) {
                save_outcome = "cosmos_write_failed";
              } else if (Number(saveResult.skipped || 0) > 0) {
                save_outcome = "validation_failed_missing_required_fields";
              } else {
                save_outcome = "cosmos_write_failed";
              }

              // If we skipped due to duplicate, treat the existing company doc as a verified saved result.
              if (
                save_outcome === "duplicate_detected" &&
                (Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0) === 0
              ) {
                const duplicateOfId = getDuplicateOfId(saveResult);
                if (duplicateOfId) {
                  try {
                    const container = getCompaniesCosmosContainer();
                    const existingDoc = container
                      ? await readItemWithPkCandidates(container, duplicateOfId, {
                          id: duplicateOfId,
                          normalized_domain: normalizedDomainForTelemetry,
                          partition_key: normalizedDomainForTelemetry,
                        }).catch(() => null)
                      : null;

                    if (existingDoc) {
                      const existingMissing = Array.isArray(existingDoc?.import_missing_fields)
                        ? existingDoc.import_missing_fields
                        : [];

                      const existingVerified = Boolean(
                        asMeaningfulString(existingDoc?.company_name || existingDoc?.name || "") &&
                          asMeaningfulString(existingDoc?.website_url || existingDoc?.company_url || existingDoc?.url || "")
                      );

                      if (!existingVerified) {
                        save_outcome = "duplicate_detected_unverified_missing_required_fields";
                      }

                      saveResult = {
                        ...saveResult,
                        saved: existingVerified ? 1 : 0,
                        skipped: 0,
                        failed: 0,
                        saved_ids: existingVerified ? [duplicateOfId] : [],
                        skipped_ids: [],
                        failed_items: [],
                        saved_company_ids_verified: existingVerified ? [duplicateOfId] : [],
                        saved_company_ids_unverified: existingVerified ? [] : [duplicateOfId],
                        saved_verified_count: existingVerified ? 1 : 0,
                        saved_write_count: 0,
                        saved_ids_write: [],
                        duplicate_of_id: duplicateOfId,
                        duplicate_existing_incomplete: !existingVerified,
                        duplicate_existing_missing_fields: existingVerified ? [] : existingMissing.slice(0, 20),
                      };
                    } else {
                      save_outcome = "read_after_write_failed";
                    }
                  } catch {
                    save_outcome = "read_after_write_failed";
                  }
                }
              }

              if (saveResult && typeof saveResult === "object") {
                saveResult.save_outcome = save_outcome;
                saveResult.seed_url = queryUrlForTelemetry || null;
                saveResult.seed_normalized_domain = normalizedDomainForTelemetry || null;
              }

              saveReport = saveResult;
            }

            const verifiedCount = Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0;
            const writeCount = Number(saveResult.saved_write_count || 0) || 0;

            const resumeCompanyIds = (() => {
              const ids = [];
              if (Array.isArray(saveResult?.saved_ids_write)) ids.push(...saveResult.saved_ids_write);
              if (Array.isArray(saveResult?.saved_company_ids_verified)) ids.push(...saveResult.saved_company_ids_verified);
              if (Array.isArray(saveResult?.saved_company_ids_unverified)) ids.push(...saveResult.saved_company_ids_unverified);
              if (Array.isArray(saveResult?.saved_ids)) ids.push(...saveResult.saved_ids);

              return Array.from(
                new Set(
                  ids
                    .map((v) => String(v || "").trim())
                    .filter(Boolean)
                    .slice(0, 50)
                )
              );
            })();

            // We must resume even when we dedupe to an existing company (saved_write_count === 0)
            // because the record may still be missing required fields.
            const canResume = canPersist && resumeCompanyIds.length > 0;

            if (canResume) {
              if (cosmosEnabled) {
                try {
                  const cosmosTarget = await getCompaniesCosmosTargetDiagnostics().catch(() => null);

                  const verifiedCount = Number(saveResult?.saved_verified_count ?? saveResult?.saved ?? 0) || 0;
                  const verifiedIds = Array.isArray(saveResult?.saved_company_ids_verified)
                    ? saveResult.saved_company_ids_verified
                    : Array.isArray(saveResult?.saved_ids)
                      ? saveResult.saved_ids
                      : [];

                  await upsertCosmosImportSessionDoc({
                    sessionId,
                    requestId,
                    patch: {
                      status: "running",
                      stage_beacon: "company_url_seed_fallback",
                      save_outcome,
                      saved: verifiedCount,
                      skipped: Number(saveResult.skipped || 0),
                      failed: Number(saveResult.failed || 0),
                      saved_count: verifiedCount,
                      saved_verified_count: verifiedCount,
                      saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified) ? saveResult.saved_company_ids_verified : verifiedIds,
                      saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [],
                      saved_company_ids: resumeCompanyIds,
                      saved_company_urls: [String(seed.company_url || seed.website_url || seed.url || "").trim()].filter(Boolean),
                      saved_ids: resumeCompanyIds,
                      saved_write_count: Number(saveResult.saved_write_count || 0) || 0,
                      saved_ids_write: Array.isArray(saveResult.saved_ids_write) ? saveResult.saved_ids_write : [],
                      skipped_ids: Array.isArray(saveResult.skipped_ids) ? saveResult.skipped_ids : [],
                      failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
                      ...(cosmosTarget ? cosmosTarget : {}),
                      resume_needed: true,
                      resume_updated_at: new Date().toISOString(),
                    },
                  }).catch(() => null);
                } catch {
                  // ignore
                }
              }

              try {
                upsertImportSession({
                  session_id: sessionId,
                  request_id: requestId,
                  status: "running",
                  stage_beacon: "company_url_seed_fallback",
                  companies_count: companies.length,
                  resume_needed: true,
                });
              } catch {}

              // Non-negotiable: fresh seeds must immediately queue + run xAI enrichment.
              // Build domain map from save result for partition key resolution
              const seedDomainMap = {};
              const seedDomain = String(seed?.normalized_domain || "").trim();
              for (const cid of resumeCompanyIds) { if (cid && seedDomain) seedDomainMap[cid] = seedDomain; }
              if (Array.isArray(saveResult?.persisted_items)) {
                for (const pi of saveResult.persisted_items) {
                  const pid = String(pi?.id || "").trim();
                  const pd = String(pi?.normalized_domain || "").trim();
                  if (pid && pd) seedDomainMap[pid] = pd;
                }
              }

              let resumeEnqueue = await maybeQueueAndInvokeMandatoryEnrichment({
                sessionId,
                requestId,
                context,
                companyIds: resumeCompanyIds,
                companyDomainMap: seedDomainMap,
                reason: "seed_complete_auto_enrich",
                cosmosEnabled,
              }).catch((err) => {
                console.error(`[import-start] maybeQueueAndInvokeMandatoryEnrichment failed: ${err?.message || err}`);
                return { queued: false, invoked: false, error: err?.message };
              });

              // Fallback: if direct invocation failed, explicitly enqueue to resume-worker queue
              if (!resumeEnqueue?.invoked && !resumeEnqueue?.queued && resumeCompanyIds.length > 0) {
                console.log(`[import-start] Direct enrichment failed, attempting fallback queue for session ${sessionId}`);
                const fallbackQueue = await enqueueResumeRun({
                  session_id: sessionId,
                  company_ids: resumeCompanyIds,
                  reason: "company_url_seed_fallback_queue",
                  requested_by: "import_start",
                }).catch((qErr) => {
                  console.error(`[import-start] Fallback queue also failed: ${qErr?.message || qErr}`);
                  return null;
                });
                if (fallbackQueue?.ok) {
                  console.log(`[import-start] Fallback queue succeeded: ${JSON.stringify(fallbackQueue)}`);
                  resumeEnqueue = {
                    queued: true,
                    enqueued: true,
                    queue: fallbackQueue.queue,
                    message_id: fallbackQueue.message_id,
                    fallback: true,
                  };

                  // Immediately invoke resume-worker to process the queued item (don't wait for polling)
                  try {
                    const invokeRes = await invokeResumeWorkerInProcess({
                      session_id: sessionId,
                      context,
                      deadline_ms: 900000, // 15 minutes - allows all 7 fields to complete with thorough xAI research
                    });
                    console.log(`[import-start] company_url_seed_fallback_queue: resume-worker invoked, ok=${invokeRes?.ok}`);
                    resumeEnqueue.invoked = Boolean(invokeRes?.ok);
                  } catch (invokeErr) {
                    console.warn(`[import-start] company_url_seed_fallback_queue: resume-worker invoke failed: ${invokeErr?.message}`);
                    resumeEnqueue.invoked = false;
                  }
                }
              }

              const cosmosTarget = await getCompaniesCosmosTargetDiagnostics().catch(() => null);

              return jsonWithRequestId(
                {
                  ok: true,
                  session_id: sessionId,
                  request_id: requestId,
                  stage_beacon: "company_url_seed_fallback",
                  status: "running",
                  resume_needed: true,
                  resume: {
                    status: resumeEnqueue?.enqueued ? "queued" : "stalled",
                    enqueued: Boolean(resumeEnqueue?.enqueued),
                    queue: resumeEnqueue?.queue || null,
                    message_id: resumeEnqueue?.message_id || null,
                    internal_auth_configured: Boolean(internalAuthConfigured),
                    ...buildResumeAuthDiagnostics(),
                  },
                  missing_by_company,
                  company_name: seed.company_name,
                  company_url: seed.company_url || seed.website_url,
                  website_url: seed.website_url,
                  companies,
                  meta: {
                    mode: "direct",
                    seed_fallback: true,
                    accepted_reason: typeof acceptedError?.reason === "string" ? acceptedError.reason : undefined,
                  },
                  ...(cosmosTarget ? cosmosTarget : {}),
                  save_outcome,
                  saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
                  saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified)
                    ? saveResult.saved_company_ids_verified
                    : Array.isArray(saveResult.saved_ids)
                      ? saveResult.saved_ids
                      : [],
                  saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [],
                  saved: Number(saveResult.saved || 0),
                  skipped: Number(saveResult.skipped || 0),
                  failed: Number(saveResult.failed || 0),
                  save_report: buildSaveReport(saveResult, { save_outcome }),
                  ...(warningKeys.size ? { warnings: Array.from(warningKeys), warnings_detail, warnings_v2 } : {}),
                  ...(debugOutput ? { debug: debugOutput } : {}),
                },
                200
              );
            }

            const seedVerifiedCount = Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0;
            const seedWriteCount = Number(saveResult.saved_write_count || 0) || 0;
            const seedSaveFailed = canPersist && seedVerifiedCount === 0;

            if (seedSaveFailed) {
              const firstFailure = Array.isArray(saveResult.failed_items) && saveResult.failed_items.length > 0
                ? saveResult.failed_items[0]
                : null;

              const firstSkipped =
                Array.isArray(saveResult.skipped_duplicates) && saveResult.skipped_duplicates.length > 0
                  ? saveResult.skipped_duplicates[0]
                  : null;

              const outcome = typeof saveResult?.save_outcome === "string" ? saveResult.save_outcome.trim() : "";

              const errorMessage = (() => {
                const failedMsg = typeof firstFailure?.error === "string" && firstFailure.error.trim() ? firstFailure.error.trim() : "";
                if (failedMsg) return failedMsg;

                if (seedWriteCount > 0) {
                  return "Cosmos write reported success, but read-after-write verification could not confirm the saved document.";
                }

                if (outcome === "validation_failed_missing_required_fields") {
                  return "Seed was rejected before persistence (missing required fields or enrichment markers).";
                }

                const dupId = String(firstSkipped?.duplicate_of_id || "").trim();
                if (dupId) {
                  return `Seed was treated as a duplicate of ${dupId}, but the existing company doc could not be verified.`;
                }

                return "Failed to save company seed";
              })();

              const failureStage =
                seedWriteCount > 0
                  ? "read_after_write_failed"
                  : outcome === "validation_failed_missing_required_fields"
                    ? "validation_failed_missing_required_fields"
                    : "cosmos_write_failed";

              const last_error = {
                code:
                  failureStage === "read_after_write_failed"
                    ? "READ_AFTER_WRITE_FAILED"
                    : failureStage === "validation_failed_missing_required_fields"
                      ? "VALIDATION_FAILED"
                      : "COSMOS_SAVE_FAILED",
                message: errorMessage,
              };

              if (cosmosEnabled) {
                try {
                  const container = getCompaniesCosmosContainer();
                  if (container) {
                    const errorDoc = {
                      id: `_import_error_${sessionId}`,
                      ...buildImportControlDocBase(sessionId),
                      request_id: requestId,
                      stage: failureStage,
                      error: {
                        ...last_error,
                        request_id: requestId,
                        step: "save",
                      },
                      details: {
                        stage_beacon: "company_url_seed_fallback",
                        save_report: saveResult,
                      },
                    };

                    await upsertItemWithPkCandidates(container, errorDoc).catch(() => null);

                    await upsertCosmosImportSessionDoc({
                      sessionId,
                      requestId,
                      patch: {
                        status: "error",
                        stage_beacon: failureStage,
                        last_error,
                        save_outcome: outcome || failureStage,
                        saved: 0,
                        saved_verified_count: 0,
                        saved_company_ids_verified: [],
                        saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified)
                          ? saveResult.saved_company_ids_unverified
                          : [],
                        skipped: Number(saveResult.skipped || 0),
                        failed: Number(saveResult.failed || 0),
                        failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
                        completed_at: new Date().toISOString(),
                        resume_needed: false,
                      },
                    }).catch(() => null);
                  }
                } catch {
                  // ignore
                }
              }

              try {
                upsertImportSession({
                  session_id: sessionId,
                  request_id: requestId,
                  status: "error",
                  stage_beacon: failureStage,
                  companies_count: companies.length,
                  resume_needed: false,
                  last_error,
                });
              } catch {}

              const cosmosTarget = await getCompaniesCosmosTargetDiagnostics().catch(() => null);

              return jsonWithRequestId(
                {
                  ok: false,
                  session_id: sessionId,
                  request_id: requestId,
                  stage_beacon: failureStage,
                  status: "error",
                  resume_needed: false,
                  company_name: seed.company_name,
                  company_url: seed.company_url || seed.website_url,
                  website_url: seed.website_url,
                  companies,
                  meta: {
                    mode: "direct",
                    seed_fallback: true,
                    accepted_reason: typeof acceptedError?.reason === "string" ? acceptedError.reason : undefined,
                  },
                  ...(cosmosTarget ? cosmosTarget : {}),
                  last_error,
                  save_outcome: outcome || failureStage,
                  saved_verified_count: 0,
                  saved_company_ids_verified: [],
                  saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified)
                    ? saveResult.saved_company_ids_unverified
                    : [],
                  saved: 0,
                  skipped: Number(saveResult.skipped || 0),
                  failed: Number(saveResult.failed || 0),
                  save_report: buildSaveReport(saveResult, { save_outcome: outcome || failureStage, saved: 0, saved_verified_count: 0, saved_ids: [], saved_ids_verified: [] }),
                  ...(warningKeys.size ? { warnings: Array.from(warningKeys), warnings_detail, warnings_v2 } : {}),
                  ...(debugOutput ? { debug: debugOutput } : {}),
                },
                200
              );
            }

            // If we cannot persist or cannot resume, end the session deterministically with a completion marker.
            if (canPersist) {
              try {
                const container = getCompaniesCosmosContainer();
                if (container) {
                  const completed_at = new Date().toISOString();
                  const completionDoc = {
                    id: `_import_complete_${sessionId}`,
                    ...buildImportControlDocBase(sessionId),
                    completed_at,
                    reason: "company_url_seed_fallback",
                    saved: Number(saveResult.saved || 0),
                    skipped: Number(saveResult.skipped || 0),
                    failed: Number(saveResult.failed || 0),
                    saved_ids: Array.isArray(saveResult.saved_ids) ? saveResult.saved_ids : [],
                    skipped_ids: Array.isArray(saveResult.skipped_ids) ? saveResult.skipped_ids : [],
                    failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
                  };

                  await upsertItemWithPkCandidates(container, completionDoc).catch(() => null);

                  // company_url_seed_fallback saves a skeleton company that still needs
                  // enrichment (HQ, mfg locations, reviews, logo). Mark as "running" with
                  // resume_needed=true so import-status triggers the resume-worker.
                  await upsertCosmosImportSessionDoc({
                    sessionId,
                    requestId,
                    patch: {
                      status: "running",
                      stage_beacon: "company_url_seed_fallback",
                      resume_needed: true,
                      saved: completionDoc.saved,
                      skipped: completionDoc.skipped,
                      failed: completionDoc.failed,
                      completed_at,
                    },
                  }).catch(() => null);
                }
              } catch {
                // ignore
              }
            }

            try {
              upsertImportSession({
                session_id: sessionId,
                request_id: requestId,
                status: "running",
                stage_beacon: "company_url_seed_fallback",
                companies_count: companies.length,
                resume_needed: true,
              });
            } catch {}

            const cosmosTarget = await getCompaniesCosmosTargetDiagnostics().catch(() => null);

            return jsonWithRequestId(
              {
                ok: true,
                session_id: sessionId,
                request_id: requestId,
                stage_beacon: "company_url_seed_fallback",
                status: "running",
                resume_needed: true,
                company_name: seed.company_name,
                company_url: seed.company_url || seed.website_url,
                website_url: seed.website_url,
                companies,
                meta: {
                  mode: "direct",
                  seed_fallback: true,
                  accepted_reason: typeof acceptedError?.reason === "string" ? acceptedError.reason : undefined,
                },
                ...(cosmosTarget ? cosmosTarget : {}),
                saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
                saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified)
                  ? saveResult.saved_company_ids_verified
                  : Array.isArray(saveResult.saved_ids)
                    ? saveResult.saved_ids
                    : [],
                saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [],
                saved: Number(saveResult.saved || 0),
                skipped: Number(saveResult.skipped || 0),
                failed: Number(saveResult.failed || 0),
                save_report: buildSaveReport(saveResult),
                ...(warningKeys.size ? { warnings: Array.from(warningKeys), warnings_detail, warnings_v2 } : {}),
                ...(debugOutput ? { debug: debugOutput } : {}),
              },
              200
            );
          }

          const isCompanyUrlImport =
            Array.isArray(queryTypes) &&
            queryTypes.includes("company_url") &&
            typeof query === "string" &&
            looksLikeCompanyUrlQuery(query);

          // Core rule: company_url imports must never spend the full request budget on inline enrichment.
          // Persist a deterministic seed immediately and let resume-worker do the heavy lifting.
          if (isCompanyUrlImport && !skipStages.has("primary") && maxStage !== "primary") {
            mark("company_url_seed_short_circuit");
            return await respondWithCompanyUrlSeedFallback(null);
          }

          const wantsAsyncPrimary =
            inputCompanies.length === 0 &&
            shouldRunStage("primary") &&
            !queryTypes.includes("company_url") &&
            ((Number.isFinite(Number(requested_stage_ms_primary)) &&
              Number(requested_stage_ms_primary) > inline_budget_ms) ||
              maxStage === "primary");

          if (wantsAsyncPrimary) {
            const jobId = buildImportPrimaryJobId(sessionId);
            let existingJob = null;

            try {
              existingJob = await getImportPrimaryJob({ sessionId, cosmosEnabled });
            } catch (e) {
              try {
                console.warn(
                  `[import-start] request_id=${requestId} session=${sessionId} failed to read primary job: ${e?.message || String(e)}`
                );
              } catch {}
            }

            const existingState = existingJob ? String(existingJob.job_state || "").trim() : "";

            if (existingState === "complete" && Array.isArray(existingJob.companies)) {
              inputCompanies = existingJob.companies
                .filter((it) => it && typeof it === "object")
                .slice(0, 500);

              try {
                console.log("[import-start] primary_async_cached_companies", {
                  request_id: requestId,
                  session_id: sessionId,
                  companies_count: inputCompanies.length,
                });
              } catch {}
            } else {
              const jobDoc = {
                id: jobId,
                session_id: sessionId,
                job_state: existingState === "running" ? "running" : "queued",
                stage: "primary",
                stage_beacon:
                  typeof existingJob?.stage_beacon === "string" && existingJob.stage_beacon.trim()
                    ? existingJob.stage_beacon.trim()
                    : "primary_enqueued",
                request_payload: {
                  query: String(xaiPayload.query || ""),
                  queryTypes: Array.isArray(xaiPayload.queryTypes) ? xaiPayload.queryTypes : [],
                  limit: Number(xaiPayload.limit) || 0,
                  expand_if_few: Boolean(xaiPayload.expand_if_few),
                },
                inline_budget_ms,
                requested_deadline_ms,
                requested_stage_ms_primary: requested_stage_ms_primary_effective,
                xai_outbound_body: outboundBody,
                attempt: Number.isFinite(Number(existingJob?.attempt)) ? Number(existingJob.attempt) : 0,
                companies_count: Number.isFinite(Number(existingJob?.companies_count))
                  ? Number(existingJob.companies_count)
                  : 0,
                last_error: existingJob?.last_error || null,
                created_at: existingJob?.created_at || new Date().toISOString(),
                updated_at: new Date().toISOString(),
                last_heartbeat_at: existingJob?.last_heartbeat_at || null,
              };

              const upserted = await upsertImportPrimaryJob({ jobDoc, cosmosEnabled }).catch(() => null);

              try {
                console.log("[import-start] primary_async_decision", {
                  request_id: requestId,
                  session_id: sessionId,
                  decision: "async_enqueue",
                  max_stage: maxStage,
                  skip_stages: Array.from(skipStages),
                  requested_deadline_ms,
                  requested_stage_ms_primary: requested_stage_ms_primary_effective,
                  inline_budget_ms,
                  job_storage: upserted?.job?.storage || (cosmosEnabled ? "cosmos" : "memory"),
                });
              } catch {}

              try {
                upsertImportSession({
                  session_id: sessionId,
                  request_id: requestId,
                  status: "running",
                  stage_beacon: jobDoc.stage_beacon,
                  companies_count: 0,
                });
              } catch {}

              if (!noUpstreamMode && cosmosEnabled) {
                (async () => {
                  const container = getCompaniesCosmosContainer();
                  if (!container) return;

                  const acceptDoc = {
                    id: `_import_accept_${sessionId}`,
                    ...buildImportControlDocBase(sessionId),
                    created_at: new Date().toISOString(),
                    accepted_at: new Date().toISOString(),
                    request_id: requestId,
                    stage_beacon: jobDoc.stage_beacon,
                    reason: "primary_async_enqueued",
                    remaining_ms: null,
                  };

                  await upsertItemWithPkCandidates(container, acceptDoc).catch(() => null);

                  await upsertCosmosImportSessionDoc({
                    sessionId,
                    requestId,
                    patch: {
                      status: "running",
                      stage_beacon: jobDoc.stage_beacon,
                      requested_deadline_ms,
                      requested_stage_ms_primary: requested_stage_ms_primary_effective,
                    },
                  }).catch(() => null);
                })().catch(() => null);
              }

              try {
                const base = new URL(req.url);
                const triggerUrl = new URL("/api/import/primary-worker", base.origin);
                triggerUrl.searchParams.set("session_id", sessionId);
                if (!cosmosEnabled) triggerUrl.searchParams.set("no_cosmos", "1");

                setTimeout(() => {
                  fetch(triggerUrl.toString(), {
                    method: "POST",
                    headers: buildInternalFetchHeaders(),
                    body: JSON.stringify({ session_id: sessionId }),
                  }).catch(() => {});
                }, 0);
              } catch {}

              return jsonWithRequestId(
                {
                  ok: true,
                  accepted: true,
                  session_id: sessionId,
                  request_id: requestId,
                  stage_beacon: jobDoc.stage_beacon,
                  reason: "primary_async_enqueued",
                  stage: "primary",
                  inline_budget_ms,
                  requested_deadline_ms,
                  requested_stage_ms_primary: requested_stage_ms_primary_effective,
                  stageCapMs: inline_budget_ms,
                  note: "start endpoint is inline capped; long primary runs async",
                },
                200
              );
            }
          }

          const deadlineBeforePrimary = checkDeadlineOrReturn("xai_primary_fetch_start", "primary");
          if (deadlineBeforePrimary) return deadlineBeforePrimary;

          if (!shouldRunStage("primary") && inputCompanies.length === 0) {
            mark("xai_primary_fetch_skipped");
            try {
              upsertImportSession({
                session_id: sessionId,
                request_id: requestId,
                status: "running",
                stage_beacon,
                companies_count: 0,
              });
            } catch {}

            return jsonWithRequestId(
              {
                ok: true,
                session_id: sessionId,
                request_id: requestId,
                stage_beacon,
                companies: [],
                meta: {
                  mode: "direct",
                  max_stage: maxStage,
                  skip_stages: Array.from(skipStages),
                  stopped_after_stage: "primary",
                  skipped_primary: true,
                },
              },
              200
            );
          }

          ensureStageBudgetOrThrow("primary", "xai_primary_fetch_start");
          mark("xai_primary_fetch_start");

          let xaiResponse;
          if (inputCompanies.length > 0) {
            try {
              console.log("[import-start] primary_input_companies", {
                count: inputCompanies.length,
                request_id: requestId,
                session_id: sessionId,
              });
            } catch {}

            xaiResponse = {
              status: 200,
              headers: {},
              data: {
                choices: [
                  {
                    message: {
                      content: JSON.stringify(inputCompanies),
                    },
                  },
                ],
              },
            };
          } else {
            try {
              xaiResponse = await postXaiJsonWithBudget({
                stageKey: "primary",
                stageBeacon: "xai_primary_fetch_start",
                body: outboundBody,
              });
            } catch (e) {
              const isCompanyUrlImport =
                Array.isArray(queryTypes) && queryTypes.includes("company_url") && typeof query === "string" && query.trim();

              // Critical: company_url imports must never return 202 + depend on the primary worker.
              // The primary worker explicitly skips company_url queries.
              if (isCompanyUrlImport && e instanceof AcceptedResponseError) {
                const seed = buildCompanyUrlSeedFromQuery(query);

                addWarning("primary_timeout_company_url", {
                  stage: "primary",
                  root_cause: "upstream_timeout_returning_202",
                  retryable: true,
                  message: "Primary upstream timed out for company_url. Continuing inline with URL seed.",
                  upstream_status: 202,
                  company_name: seed.company_name,
                  website_url: seed.website_url,
                });

                mark("xai_primary_fallback_company_url_seed");

                xaiResponse = {
                  status: 200,
                  headers: {},
                  data: {
                    choices: [
                      {
                        message: {
                          content: JSON.stringify([seed]),
                        },
                      },
                    ],
                  },
                };
              } else {
                throw e;
              }
            }
          }

          const elapsed = Date.now() - startTime;
        console.log(`[import-start] session=${sessionId} xai response status=${xaiResponse.status}`);

        const xaiRequestId = extractXaiRequestId(xaiResponse.headers);
        if (xaiRequestId) {
          setStage("searchCompanies", { xai_request_id: xaiRequestId });
          if (debugOutput) debugOutput.xai.request_id = xaiRequestId;
        }

        mark("xai_primary_fetch_done");

        if (xaiResponse.status >= 200 && xaiResponse.status < 300) {
          // Extract the response content
          const responseText = extractXaiResponseText(xaiResponse.data) || JSON.stringify(xaiResponse.data);
          console.log(
            `[import-start] session=${sessionId} xai response received chars=${typeof responseText === "string" ? responseText.length : 0}`
          );

          // Parse the JSON array from the response
          let companies = [];
          let parseError = null;
          try {
            const jsonMatch = responseText.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              companies = JSON.parse(jsonMatch[0]);
              if (!Array.isArray(companies)) companies = [];
            }
          } catch (parseErr) {
            parseError = parseErr?.message || String(parseErr);
            console.warn(`[import-start] session=${sessionId} failed to parse companies from response: ${parseError}`);
            companies = [];
          }

          if (debugOutput) {
            debugOutput.xai.raw_response = responseText.length > 50000 ? responseText.slice(0, 50000) : responseText;
            debugOutput.xai.parse_error = parseError;
            debugOutput.xai.parsed_companies = Array.isArray(companies) ? companies.length : 0;
          }

          console.log(`[import-start] session=${sessionId} xai response status=${xaiResponse.status} companies=${companies.length}`);

          setStage("enrichCompany");
          const center = safeCenter(bodyObj.center);
          let enriched = companies.map((c) => enrichCompany(c, center));

          // When company_url_hint was provided, ensure the result set includes a company
          // with the hinted URL. If the primary search found it by name, patch its website_url
          // to match the hint. If not found, inject a seed with the real name + URL.
          if (xaiPayload.company_url_hint) {
            const hintDomain = String(xaiPayload.company_url_hint || "")
              .replace(/^https?:\/\//i, "").replace(/^www\./, "").split("/")[0].toLowerCase().trim();

            if (hintDomain) {
              const matchIdx = enriched.findIndex((c) => {
                const d = String(c?.normalized_domain || c?.website_url || c?.url || "")
                  .replace(/^https?:\/\//i, "").replace(/^www\./, "").split("/")[0].toLowerCase().trim();
                return d === hintDomain;
              });

              if (matchIdx >= 0) {
                // Grok found the company â€” ensure website_url and normalized_domain are set
                const match = enriched[matchIdx];
                if (!match.website_url) match.website_url = `https://${hintDomain}/`;
                if (!match.normalized_domain) match.normalized_domain = hintDomain;
                console.log(`[import-start] company_url_hint matched enriched[${matchIdx}] "${match.company_name}" (${hintDomain})`);
              } else {
                // Grok didn't return a company matching the hint domain â€” inject a seed
                const hintSeed = buildCompanyUrlSeedFromQuery(query);
                if (hintSeed) {
                  enriched.unshift(hintSeed);
                  console.log(`[import-start] company_url_hint injected seed for "${hintSeed.company_name}" (${hintDomain})`);
                }
              }
            }
          }

          // For company_url imports, XAI can legitimately return an empty array (or parsing can fail).
          // In that case we still want to proceed with a deterministic URL seed so the session can
          // persist and resume-worker has something to enrich.
          if (enriched.length === 0 && queryTypes.includes("company_url")) {
            enriched = [buildCompanyUrlSeedFromQuery(query)];
            mark("company_url_seed_created");
          }

          enrichedForCounts = enriched;

          // Populate a baseline profile deterministically from the company's own website.
          // This is especially important for company_url shortcut runs, where the initial company_name
          // (derived from the hostname) is often too weak to drive reviews/location enrichment.
          const downstreamStagesSkipped =
            !shouldRunStage("keywords") && !shouldRunStage("reviews") && !shouldRunStage("location");

          const baselineEligible = queryTypes.includes("company_url") || enriched.length <= 3;
          const baselineNeeded =
            baselineEligible &&
            (downstreamStagesSkipped || downstreamDeferredByBudget ||
              (queryTypes.includes("company_url") &&
                enriched.some((c) => !String(c?.tagline || "").trim())));

          if (baselineNeeded) {
            try {
              const remaining = getRemainingMs();
              if (remaining > 7000) {
                setStage("baselineWebsiteParse");

                const baselineConcurrency = queryTypes.includes("company_url") ? 1 : 2;
                enriched = await mapWithConcurrency(enriched, baselineConcurrency, async (company) => {
                  try {
                    return await fillCompanyBaselineFromWebsite(company, {
                      timeoutMs: queryTypes.includes("company_url") ? 7000 : 5000,
                      extraPageTimeoutMs: 3500,
                    });
                  } catch (e) {
                    if (e instanceof AcceptedResponseError) throw e;
                    return company;
                  }
                });

                // HARD RULE: website scraping must NOT be used for these fields at any stage.
                // Even if baselineWebsiteParse runs for other enrichment needs, strip any accidental
                // HQ/MFG/Reviews fields so resume-worker remains the single source of truth.
                enriched = enriched.map((c) => {
                  if (!c || typeof c !== "object") return c;
                  const next = { ...c };
                  delete next.headquarters_location;
                  delete next.manufacturing_locations;
                  delete next.curated_reviews;
                  delete next.review_count;
                  delete next.review_cursor;
                  delete next.reviews_stage_status;
                  return next;
                });

                enrichedForCounts = enriched;
              }
            } catch (e) {
              if (e instanceof AcceptedResponseError) throw e;
            }
          }

          // Early exit if no companies found
          // (For company_url runs, we always fall back to a URL seed above instead of exiting.)
          if (enriched.length === 0 && !queryTypes.includes("company_url")) {
            console.log(`[import-start] session=${sessionId} no companies found in XAI response, returning early`);

            // Write a completion marker so import-progress knows this session is done with 0 results
            if (cosmosEnabled) {
              try {
                const container = getCompaniesCosmosContainer();
                if (container) {
                  const completionDoc = {
                    id: `_import_complete_${sessionId}`,
                    ...buildImportControlDocBase(sessionId),
                    completed_at: new Date().toISOString(),
                    reason: "no_results_from_xai",
                    saved: 0,
                    skipped: 0,
                    failed: 0,
                    saved_ids: [],
                    skipped_ids: [],
                    failed_items: [],
                  };

                  const result = await upsertItemWithPkCandidates(container, completionDoc);
                  if (!result.ok) {
                    console.warn(
                      `[import-start] request_id=${requestId} session=${sessionId} failed to upsert completion marker: ${result.error}`
                    );
                  } else {
                    console.log(`[import-start] request_id=${requestId} session=${sessionId} completion marker written`);
                  }

                  await upsertCosmosImportSessionDoc({
                    sessionId,
                    requestId,
                    patch: {
                      status: "complete",
                      stage_beacon,
                      saved: 0,
                      skipped: 0,
                      failed: 0,
                      completed_at: completionDoc.completed_at,
                    },
                  }).catch(() => null);
                }
              } catch (e) {
                console.warn(
                  `[import-start] request_id=${requestId} session=${sessionId} error writing completion marker: ${e?.message || String(e)}`
                );
              }
            }

            return jsonWithRequestId(
              {
                ok: true,
                session_id: sessionId,
                request_id: requestId,
                details:
                  requestDetails ||
                  buildRequestDetails(req, {
                    body_source,
                    body_source_detail,
                    raw_text_preview,
                    raw_text_starts_with_brace,
                  }),
                company_name: contextInfo.company_name,
                website_url: contextInfo.website_url,
                companies: [],
                meta: {
                  mode: "direct",
                  expanded: false,
                  timedOut: false,
                  elapsedMs: Date.now() - startTime,
                  no_results_reason: "XAI returned empty response",
                },
                saved: 0,
                skipped: 0,
                failed: 0,
              },
              200
            );
          }

          // ── Enrichment functions (delegated to _importStartInlineEnrichment.js) ──
          const mapWithConcurrency = _mapWithConcurrency;
          const ensureCompanyKeywords = (company) =>
            _ensureCompanyKeywordsBase(company, {
              xaiUrl, xaiKey, postXaiJsonWithBudgetRetry, getRemainingMs, timeout, debugOutput,
            });

          if (shouldStopAfterStage("primary")) {
            const companiesCount = Array.isArray(enriched) ? enriched.length : 0;

            try {
              upsertImportSession({
                session_id: sessionId,
                request_id: requestId,
                status: "running",
                stage_beacon,
                companies_count: companiesCount,
              });
            } catch {}

            if (!noUpstreamMode && cosmosEnabled) {
              await upsertCosmosImportSessionDoc({
                sessionId,
                requestId,
                patch: {
                  status: "running",
                  stage_beacon,
                  companies_count: companiesCount,
                },
              }).catch(() => null);
            }

            return jsonWithRequestId(
              {
                ok: true,
                session_id: sessionId,
                request_id: requestId,
                stage_beacon,
                companies: enriched,
                meta: {
                  mode: "direct",
                  max_stage: maxStage,
                  skip_stages: Array.from(skipStages),
                  stopped_after_stage: "primary",
                },
              },
              200
            );
          }

          // â”€â”€ Fast-path: for company_url imports, skip inline enrichment entirely. â”€â”€
          // Save the stub company to Cosmos now, return 202, and let
          // maybeQueueAndInvokeMandatoryEnrichment handle ALL enrichment async.
          // This prevents the SWA gateway from killing the connection during the
          // 30-90 second xAI call.
          const isCompanyUrlFastPath =
            (queryType === "company_url" || Boolean(companyUrlHint)) &&
            enriched.length > 0 &&
            !dryRunRequested &&
            cosmosEnabled;

          if (isCompanyUrlFastPath) {
            // Ensure enrichment field defaults so import_missing_fields is populated correctly
            // by saveCompaniesToCosmos. All real values will be populated by async enrichment.
            for (const company of enriched) {
              if (!company.tagline) company.tagline = "";
              if (!company.headquarters_location) company.headquarters_location = "";
              if (!Array.isArray(company.manufacturing_locations)) company.manufacturing_locations = [];
              if (!Array.isArray(company.industries) || company.industries.length === 0) company.industries = [];
              if (!company.product_keywords) company.product_keywords = "";
              if (!Array.isArray(company.keywords) || company.keywords.length === 0) company.keywords = [];
            }

            mark("fast_path_company_url_skip_inline_enrichment");
            console.log(
              `[import-start] session=${sessionId} FAST PATH: company_url import â€” skipping keywords/location/geocode stages, saving stub immediately`
            );
          }

          const deadlineBeforeKeywords = checkDeadlineOrReturn("xai_keywords_fetch_start", "keywords");
          if (deadlineBeforeKeywords) return deadlineBeforeKeywords;

          let keywordStageCompleted = isCompanyUrlFastPath ? true : !shouldRunStage("keywords");

          if (shouldRunStage("keywords") && !isCompanyUrlFastPath) {
            const remainingBeforeKeywords = getRemainingMs();
            if (remainingBeforeKeywords < MIN_STAGE_REMAINING_MS) {
              keywordStageCompleted = false;
              downstreamDeferredByBudget = true;
              deferredStages.add("keywords");
              mark("xai_keywords_fetch_deferred_budget");
            } else {
              ensureStageBudgetOrThrow("keywords", "xai_keywords_fetch_start");
              mark("xai_keywords_fetch_start");
              setStage("generateKeywords");

              const keywordsConcurrency = 4;
              keywordStageCompleted = true;
              for (let i = 0; i < enriched.length; i += keywordsConcurrency) {
                if (getRemainingMs() < MIN_STAGE_REMAINING_MS) {
                  keywordStageCompleted = false;
                  downstreamDeferredByBudget = true;
                  deferredStages.add("keywords");
                  console.log(
                    `[import-start] session=${sessionId} keyword enrichment stopping early: remaining budget low`
                  );
                  break;
                }

                const slice = enriched.slice(i, i + keywordsConcurrency);
                const batch = await Promise.all(
                  slice.map(async (company) => {
                    try {
                      return await ensureCompanyKeywords(company);
                    } catch (e) {
                      if (e instanceof AcceptedResponseError) throw e;
                      try {
                        console.log(
                          `[import-start] session=${sessionId} keyword enrichment failed for ${company?.company_name || "(unknown)"}: ${e?.message || String(e)}`
                        );
                      } catch {}
                      return company;
                    }
                  })
                );

                for (let j = 0; j < batch.length; j++) {
                  enriched[i + j] = batch[j];
                }

                enrichedForCounts = enriched;
              }
              mark(keywordStageCompleted ? "xai_keywords_fetch_done" : "xai_keywords_fetch_partial");
            }
          } else {
            mark("xai_keywords_fetch_skipped");
          }

          if (shouldStopAfterStage("keywords")) {
            const companiesCount = Array.isArray(enriched) ? enriched.length : 0;

            try {
              upsertImportSession({
                session_id: sessionId,
                request_id: requestId,
                status: "running",
                stage_beacon,
                companies_count: companiesCount,
              });
            } catch {}

            if (!noUpstreamMode && cosmosEnabled) {
              await upsertCosmosImportSessionDoc({
                sessionId,
                requestId,
                patch: {
                  status: "running",
                  stage_beacon,
                  companies_count: companiesCount,
                },
              }).catch(() => null);
            }

            return jsonWithRequestId(
              {
                ok: true,
                session_id: sessionId,
                request_id: requestId,
                stage_beacon,
                companies: enriched,
                meta: {
                  mode: "direct",
                  max_stage: maxStage,
                  skip_stages: Array.from(skipStages),
                  stopped_after_stage: "keywords",
                },
              },
              200
            );
          }

          // Geocode and persist per-location coordinates (HQ + manufacturing)
          let geocodeStageCompleted = isCompanyUrlFastPath ? true : !shouldRunStage("location");

          if (shouldRunStage("location") && !isCompanyUrlFastPath) {
            const remainingBeforeGeocode = getRemainingMs();
            if (remainingBeforeGeocode < MIN_STAGE_REMAINING_MS) {
              geocodeStageCompleted = false;
              downstreamDeferredByBudget = true;
              deferredStages.add("location");
              mark("xai_location_geocode_deferred_budget");
            } else {
              ensureStageBudgetOrThrow("location", "xai_location_geocode_start");

              const deadlineBeforeGeocode = checkDeadlineOrReturn("xai_location_geocode_start", "location");
              if (deadlineBeforeGeocode) return deadlineBeforeGeocode;

              mark("xai_location_geocode_start");
              setStage("geocodeLocations");
              console.log(`[import-start] session=${sessionId} geocoding start count=${enriched.length}`);

              geocodeStageCompleted = true;
              for (let i = 0; i < enriched.length; i++) {
                if (getRemainingMs() < MIN_STAGE_REMAINING_MS) {
                  geocodeStageCompleted = false;
                  downstreamDeferredByBudget = true;
                  deferredStages.add("location");
                  console.log(
                    `[import-start] session=${sessionId} geocoding stopping early: remaining budget low`
                  );
                  break;
                }

                if (shouldAbort()) {
                  console.log(`[import-start] session=${sessionId} aborting during geocoding: time limit exceeded`);
                  break;
                }

                const stopped = await safeCheckIfSessionStopped(sessionId);
                if (stopped) {
                  console.log(`[import-start] session=${sessionId} stop signal detected, aborting during geocoding`);
                  break;
                }

                const company = enriched[i];
                try {
                  enriched[i] = await geocodeCompanyLocations(company, { timeoutMs: 5000 });
                } catch (e) {
                  console.log(
                    `[import-start] session=${sessionId} geocoding failed for ${company?.company_name || "(unknown)"}: ${e?.message || String(e)}`
                  );
                }
              }

              const okCount = enriched.filter((c) => Number.isFinite(c.hq_lat) && Number.isFinite(c.hq_lng)).length;
              console.log(`[import-start] session=${sessionId} geocoding done success=${okCount} failed=${enriched.length - okCount}`);
              mark(geocodeStageCompleted ? "xai_location_geocode_done" : "xai_location_geocode_partial");
            }
          } else {
            mark("xai_location_geocode_skipped");
          }

          // Reviews must be a first-class import stage.
          // We run the same pipeline as "Fetch more reviews" (xadmin-api-refresh-reviews),
          // and we run it AFTER the company is persisted so it can be committed.
          const usePostSaveReviews = true;

          let reviewStageCompleted = isCompanyUrlFastPath ? true : !shouldRunStage("reviews");

          if (shouldRunStage("reviews") && usePostSaveReviews && !isCompanyUrlFastPath) {
            // Defer until after saveCompaniesToCosmos so we have stable company_id values.
            reviewStageCompleted = false;
            mark("xai_reviews_fetch_deferred");
          } else if (shouldRunStage("reviews") && !shouldAbort() && !assertNoWebsiteFallback("reviews")) {
            ensureStageBudgetOrThrow("reviews", "xai_reviews_fetch_start");

            const deadlineBeforeReviews = checkDeadlineOrReturn("xai_reviews_fetch_start", "reviews");
            if (deadlineBeforeReviews) return deadlineBeforeReviews;

            mark("xai_reviews_fetch_start");
            setStage("fetchEditorialReviews");
            console.log(`[import-start] session=${sessionId} editorial review enrichment start count=${enriched.length}`);
            reviewStageCompleted = true;
            for (let i = 0; i < enriched.length; i++) {
              if (getRemainingMs() < MIN_STAGE_REMAINING_MS) {
                reviewStageCompleted = false;
                downstreamDeferredByBudget = true;
                deferredStages.add("reviews");
                console.log(
                  `[import-start] session=${sessionId} review enrichment stopping early: remaining budget low`
                );
                break;
              }

              // Check if import was stopped OR we're running out of time
              if (shouldAbort()) {
                console.log(`[import-start] session=${sessionId} aborting during review fetch: time limit exceeded`);
                break;
              }

              const stopped = await safeCheckIfSessionStopped(sessionId);
              if (stopped) {
                console.log(`[import-start] session=${sessionId} stop signal detected, aborting during review fetch`);
                break;
              }

              const company = enriched[i];
              setStage("fetchEditorialReviews", {
                company_name: String(company?.company_name || company?.name || ""),
                website_url: String(company?.website_url || company?.url || ""),
                normalized_domain: String(company?.normalized_domain || ""),
              });

              const effectiveWebsiteUrl = String(company?.website_url || company?.canonical_url || company?.url || "").trim();
              const nowReviewsIso = new Date().toISOString();

              if (!company.company_name || !effectiveWebsiteUrl) {
                enriched[i] = {
                  ...company,
                  curated_reviews: [],
                  review_count: 0,
                  reviews_last_updated_at: nowReviewsIso,
                  review_cursor: buildReviewCursor({
                    nowIso: nowReviewsIso,
                    count: 0,
                    exhausted: false,
                    last_error: {
                      code: "MISSING_COMPANY_INPUT",
                      message: "Missing company_name or website_url",
                    },
                    prev_cursor: company.review_cursor,
                  }),
                };
                continue;
              }

              // If unified enrichment already provided reviews, use those instead of a separate Grok call.
              if (Array.isArray(company._unified_reviews) && company._unified_reviews.length > 0) {
                const curated = dedupeCuratedReviews(company._unified_reviews);
                const nowUnifiedIso = new Date().toISOString();
                enriched[i] = {
                  ...company,
                  curated_reviews: curated,
                  review_count: curated.length,
                  reviews_last_updated_at: nowUnifiedIso,
                  review_cursor: buildReviewCursor({
                    nowIso: nowUnifiedIso,
                    count: curated.length,
                    exhausted: false,
                    last_error: null,
                    prev_cursor: company.review_cursor,
                  }),
                };
                // Clean up temp property
                delete enriched[i]._unified_reviews;
                delete enriched[i]._unified_reviews_status;
                delete enriched[i]._unified_enrichment_done;
                console.log(
                  `[import-start][reviews] session=${sessionId} unified_reviews=${curated.length} company=${company.company_name}`
                );
                continue;
              }

              try {
                const companyForReviews = company.website_url ? company : { ...company, website_url: effectiveWebsiteUrl };

                const grokReviews = await fetchCuratedReviewsGrok({
                  companyName: String(companyForReviews.company_name || "").trim(),
                  normalizedDomain:
                    String(companyForReviews.normalized_domain || "").trim() || toNormalizedDomain(effectiveWebsiteUrl),
                  budgetMs: Math.min(
                    6500,
                    Math.max(
                      3000,
                      (typeof getRemainingMs === "function" ? getRemainingMs() : 12000) - DEADLINE_SAFETY_BUFFER_MS
                    )
                  ),
                  xaiUrl,
                  xaiKey,
                  model: "grok-4-latest",
                });

                const reviewsStageStatus =
                  typeof grokReviews?.reviews_stage_status === "string" && grokReviews.reviews_stage_status.trim()
                    ? grokReviews.reviews_stage_status.trim()
                    : "upstream_unreachable";

                const fetchOk = reviewsStageStatus !== "upstream_unreachable";
                const fetchErrorCode = fetchOk ? null : "REVIEWS_UPSTREAM_UNREACHABLE";
                const fetchErrorMsg =
                  fetchOk ? null : typeof grokReviews?.diagnostics?.error === "string" ? grokReviews.diagnostics.error : "Reviews fetch failed";

                const curated = dedupeCuratedReviews(Array.isArray(grokReviews?.curated_reviews) ? grokReviews.curated_reviews : []);
                const candidateCount =
                  typeof grokReviews?.diagnostics?.candidate_count === "number" && Number.isFinite(grokReviews.diagnostics.candidate_count)
                    ? grokReviews.diagnostics.candidate_count
                    : Array.isArray(grokReviews?.curated_reviews)
                      ? grokReviews.curated_reviews.length
                      : 0;

                const rejectedCount = Math.max(0, candidateCount - curated.length);

                const reviewsTelemetry = {
                  stage_status: reviewsStageStatus,
                  review_candidates_fetched_count: candidateCount,
                  review_candidates_considered_count: candidateCount,
                  review_candidates_rejected_count: rejectedCount,
                  review_candidates_rejected_reasons: {},
                  review_validated_count: curated.length,
                  review_saved_count: curated.length,
                  duplicate_host_used_as_fallback: false,
                  time_budget_exhausted: false,
                  upstream_status: null,
                  upstream_error_code: fetchOk ? null : fetchErrorCode,
                  upstream_failure_buckets: {
                    upstream_4xx: 0,
                    upstream_5xx: 0,
                    upstream_rate_limited: 0,
                    upstream_unreachable: fetchOk ? 0 : 1,
                  },
                  excluded_websites_original_count:
                    typeof grokReviews?.search_telemetry?.excluded_websites_original_count === "number"
                      ? grokReviews.search_telemetry.excluded_websites_original_count
                      : null,
                  excluded_websites_used_count:
                    typeof grokReviews?.search_telemetry?.excluded_websites_used_count === "number"
                      ? grokReviews.search_telemetry.excluded_websites_used_count
                      : null,
                  excluded_websites_truncated:
                    typeof grokReviews?.search_telemetry?.excluded_websites_truncated === "boolean"
                      ? grokReviews.search_telemetry.excluded_websites_truncated
                      : null,
                  excluded_hosts_spilled_to_prompt_count:
                    typeof grokReviews?.search_telemetry?.excluded_hosts_spilled_to_prompt_count === "number"
                      ? grokReviews.search_telemetry.excluded_hosts_spilled_to_prompt_count
                      : null,
                };

                const candidatesDebug = [];

                // Only mark reviews "exhausted" when upstream returned *no candidates*.
                const cursorExhausted = fetchOk && reviewsStageStatus === "exhausted";

                const cursorError = !fetchOk
                  ? {
                      code: fetchErrorCode || "REVIEWS_FAILED",
                      message: fetchErrorMsg || "Reviews fetch failed",
                    }
                  : null;

                const cursor = buildReviewCursor({
                  nowIso: nowReviewsIso,
                  count: curated.length,
                  exhausted: cursorExhausted,
                  last_error: cursorError,
                  prev_cursor: companyForReviews.review_cursor,
                });

                // Persist candidate/rejection telemetry for retries and diagnostics.
                cursor._candidate_count = candidateCount;
                if (rejectedCount != null) cursor._rejected_count = rejectedCount;
                cursor._saved_count = curated.length;
                cursor.exhausted_reason = cursorExhausted ? "no_candidates" : "";

                cursor.reviews_stage_status = reviewsStageStatus;
                if (reviewsTelemetry) {
                  cursor.reviews_telemetry = {
                    stage_status: reviewsTelemetry.stage_status,
                    review_candidates_fetched_count: reviewsTelemetry.review_candidates_fetched_count,
                    review_candidates_considered_count: reviewsTelemetry.review_candidates_considered_count,
                    review_candidates_rejected_count: reviewsTelemetry.review_candidates_rejected_count,
                    review_candidates_rejected_reasons: reviewsTelemetry.review_candidates_rejected_reasons,
                    review_validated_count: reviewsTelemetry.review_validated_count,
                    review_saved_count: reviewsTelemetry.review_saved_count,
                    duplicate_host_used_as_fallback: reviewsTelemetry.duplicate_host_used_as_fallback,
                    time_budget_exhausted: reviewsTelemetry.time_budget_exhausted,
                    upstream_status: reviewsTelemetry.upstream_status,
                    upstream_error_code: reviewsTelemetry.upstream_error_code,
                    upstream_failure_buckets: reviewsTelemetry.upstream_failure_buckets,

                    excluded_websites_original_count: reviewsTelemetry.excluded_websites_original_count,
                    excluded_websites_used_count: reviewsTelemetry.excluded_websites_used_count,
                    excluded_websites_truncated: reviewsTelemetry.excluded_websites_truncated,
                    excluded_hosts_spilled_to_prompt_count: reviewsTelemetry.excluded_hosts_spilled_to_prompt_count,
                  };
                }

                if ((reviewsStageStatus !== "ok" || curated.length === 0) && candidatesDebug.length) {
                  cursor.review_candidates_debug = candidatesDebug;
                }

                console.log(
                  `[import-start][reviews] session=${sessionId} upstream_candidates=${candidateCount} saved=${curated.length} rejected=${rejectedCount != null ? rejectedCount : ""} exhausted=${cursorExhausted ? "true" : "false"} company=${companyForReviews.company_name}`
                );

                enriched[i] = {
                  ...companyForReviews,
                  curated_reviews: curated,
                  review_count: curated.length,
                  reviews_last_updated_at: nowReviewsIso,
                  review_cursor: cursor,
                };

                if (curated.length > 0) {
                  console.log(
                    `[import-start] session=${sessionId} fetched ${curated.length} editorial reviews for ${companyForReviews.company_name}`
                  );
                }
              } catch (e) {
                // Never allow review enrichment failures to abort the import.
                const msg = e?.message || String(e || "reviews_failed");
                warnReviews({
                  stage: "reviews",
                  root_cause: "reviews_exception",
                  retryable: true,
                  message: msg,
                  company_name: String(company?.company_name || company?.name || ""),
                  website_url: effectiveWebsiteUrl,
                });

                enriched[i] = {
                  ...company,
                  curated_reviews: Array.isArray(company.curated_reviews) ? company.curated_reviews : [],
                  review_count: typeof company.review_count === "number" ? company.review_count : 0,
                  reviews_last_updated_at: nowReviewsIso,
                  review_cursor: buildReviewCursor({
                    nowIso: nowReviewsIso,
                    count: typeof company.review_count === "number" ? company.review_count : 0,
                    exhausted: false,
                    last_error: {
                      code: "REVIEWS_EXCEPTION",
                      message: msg,
                    },
                    prev_cursor: company.review_cursor,
                  }),
                };
              }
            }

            try {
              const summary = {
                companies_total: Array.isArray(enriched) ? enriched.length : 0,
                companies_with_saved_0: 0,
                candidates_fetched_total: 0,
                candidates_considered_total: 0,
                validated_total: 0,
                saved_total: 0,
                rejected_total: 0,
                stage_status_counts: {},
                rejected_reasons_total: {},
              };

              for (const c of Array.isArray(enriched) ? enriched : []) {
                const cursor = c?.review_cursor && typeof c.review_cursor === "object" ? c.review_cursor : null;
                const stageStatus = String(cursor?.reviews_stage_status || "").trim() || "unknown";
                summary.stage_status_counts[stageStatus] = (summary.stage_status_counts[stageStatus] || 0) + 1;

                const saved = typeof c?.review_count === "number" ? c.review_count : Array.isArray(c?.curated_reviews) ? c.curated_reviews.length : 0;
                if (saved === 0) summary.companies_with_saved_0 += 1;

                const t = cursor?.reviews_telemetry && typeof cursor.reviews_telemetry === "object" ? cursor.reviews_telemetry : null;
                if (t) {
                  summary.candidates_fetched_total += Number(t.review_candidates_fetched_count) || 0;
                  summary.candidates_considered_total += Number(t.review_candidates_considered_count) || 0;
                  summary.validated_total += Number(t.review_validated_count) || 0;
                  summary.saved_total += Number(t.review_saved_count) || 0;
                  summary.rejected_total += Number(t.review_candidates_rejected_count) || 0;

                  const reasons = t.review_candidates_rejected_reasons && typeof t.review_candidates_rejected_reasons === "object" ? t.review_candidates_rejected_reasons : null;
                  if (reasons) {
                    for (const [k, v] of Object.entries(reasons)) {
                      if (!k) continue;
                      summary.rejected_reasons_total[k] = (summary.rejected_reasons_total[k] || 0) + (Number(v) || 0);
                    }
                  }
                } else {
                  summary.saved_total += saved;
                }
              }

              if (!noUpstreamMode && cosmosEnabled) {
                await upsertCosmosImportSessionDoc({
                  sessionId,
                  requestId,
                  patch: {
                    reviews_summary: summary,
                    reviews_summary_updated_at: new Date().toISOString(),
                  },
                });
              }

              console.log("[import-start][reviews_summary] " + JSON.stringify({ session_id: sessionId, request_id: requestId, ...summary }));
            } catch {}

            console.log(`[import-start] session=${sessionId} editorial review enrichment done`);
            mark(reviewStageCompleted ? "xai_reviews_fetch_done" : "xai_reviews_fetch_partial");
          } else if (!shouldRunStage("reviews")) {
            mark("xai_reviews_fetch_skipped");
          }

          if (shouldStopAfterStage("reviews")) {
            const companiesCount = Array.isArray(enriched) ? enriched.length : 0;

            try {
              upsertImportSession({
                session_id: sessionId,
                request_id: requestId,
                status: "running",
                stage_beacon,
                companies_count: companiesCount,
              });
            } catch {}

            if (!noUpstreamMode && cosmosEnabled) {
              await upsertCosmosImportSessionDoc({
                sessionId,
                requestId,
                patch: {
                  status: "running",
                  stage_beacon,
                  companies_count: companiesCount,
                },
              }).catch(() => null);
            }

            return jsonWithRequestId(
              {
                ok: true,
                session_id: sessionId,
                request_id: requestId,
                stage_beacon,
                companies: enriched,
                meta: {
                  mode: "direct",
                  max_stage: maxStage,
                  skip_stages: Array.from(skipStages),
                  stopped_after_stage: "reviews",
                },
              },
              200
            );
          }

          // Check if any companies have missing or weak location data
          // Trigger refinement if: HQ is missing, manufacturing is missing, or confidence is low (aggressive approach)
          const companiesNeedingLocationRefinement = enriched.filter(c =>
            (!c.headquarters_location || c.headquarters_location === "") ||
            (!c.manufacturing_locations || c.manufacturing_locations.length === 0) ||
            (c.location_confidence === "low")
          );

          // Location refinement pass: if too many companies have missing locations, run a refinement
          // But skip if we're running out of time
          if (shouldRunStage("location") && companiesNeedingLocationRefinement.length > 0 && enriched.length > 0 && !shouldAbort()) {
            console.log(`[import-start] ${companiesNeedingLocationRefinement.length} companies need location refinement`);

            try {
              // HQ + Manufacturing are Grok-only fields. Use Grok live search and record source URLs.
              ensureStageBudgetOrThrow("location", "grok_location_enrichment_start");

              const deadlineBeforeLocation = checkDeadlineOrReturn("grok_location_enrichment_start", "location");
              if (deadlineBeforeLocation) return deadlineBeforeLocation;

              mark("grok_location_enrichment_start");
              setStage("grokLocationEnrichment");

              const locationSourcesDebug = [];

              for (let i = 0; i < enriched.length; i++) {
                if (getRemainingMs() < MIN_STAGE_REMAINING_MS) {
                  downstreamDeferredByBudget = true;
                  deferredStages.add("location");
                  break;
                }

                const company = enriched[i];
                const needsHq = !String(company?.headquarters_location || "").trim();
                const needsMfg = !Array.isArray(company?.manufacturing_locations) || company.manufacturing_locations.length === 0;
                if (!needsHq && !needsMfg) continue;

                const companyName = String(company?.company_name || company?.name || "").trim();
                const websiteUrl = String(company?.website_url || company?.canonical_url || company?.url || "").trim();
                const normalizedDomain = String(company?.normalized_domain || toNormalizedDomain(websiteUrl)).trim();

                if (!companyName || !normalizedDomain) continue;

                const perCompanyBudgetMs = Math.min(
                  18_000,
                  Math.max(6_000, getRemainingMs() - DEADLINE_SAFETY_BUFFER_MS)
                );

                const hqResult = needsHq
                  ? await fetchHeadquartersLocationGrok({ companyName, normalizedDomain, budgetMs: perCompanyBudgetMs, xaiUrl, xaiKey })
                  : null;

                const mfgResult = needsMfg
                  ? await fetchManufacturingLocationsGrok({ companyName, normalizedDomain, budgetMs: perCompanyBudgetMs, xaiUrl, xaiKey })
                  : null;

                const next = { ...company };

                if (hqResult) {
                  const status = String(hqResult?.hq_status || "").trim();
                  const value = String(hqResult?.headquarters_location || "").trim();
                  if (status === "ok" && value) {
                    next.headquarters_location = value;
                    next.hq_unknown = false;
                    next.hq_unknown_reason = null;
                  } else if (status === "not_disclosed") {
                    next.headquarters_location = "Not disclosed";
                    next.hq_unknown = true;
                    next.hq_unknown_reason = "not_disclosed";
                  }

                  next.enrichment_debug = next.enrichment_debug && typeof next.enrichment_debug === "object" ? next.enrichment_debug : {};
                  next.enrichment_debug.location_sources = next.enrichment_debug.location_sources && typeof next.enrichment_debug.location_sources === "object"
                    ? next.enrichment_debug.location_sources
                    : {};
                  next.enrichment_debug.location_sources.hq_source_urls = Array.isArray(hqResult?.source_urls) ? hqResult.source_urls : [];
                }

                if (mfgResult) {
                  const status = String(mfgResult?.mfg_status || "").trim();
                  const list = Array.isArray(mfgResult?.manufacturing_locations) ? mfgResult.manufacturing_locations : [];
                  if (status === "ok" && list.length > 0) {
                    next.manufacturing_locations = list;
                    next.mfg_unknown = false;
                    next.mfg_unknown_reason = null;
                  } else if (status === "not_disclosed") {
                    next.manufacturing_locations = ["Not disclosed"];
                    next.mfg_unknown = true;
                    next.mfg_unknown_reason = "not_disclosed";
                  }

                  next.enrichment_debug = next.enrichment_debug && typeof next.enrichment_debug === "object" ? next.enrichment_debug : {};
                  next.enrichment_debug.location_sources = next.enrichment_debug.location_sources && typeof next.enrichment_debug.location_sources === "object"
                    ? next.enrichment_debug.location_sources
                    : {};
                  next.enrichment_debug.location_sources.mfg_source_urls = Array.isArray(mfgResult?.source_urls) ? mfgResult.source_urls : [];
                }

                // Company doc (debug-only) + session diagnostics.
                if (next?.enrichment_debug?.location_sources) {
                  locationSourcesDebug.push({
                    company_name: companyName,
                    normalized_domain: normalizedDomain,
                    hq_source_urls: next.enrichment_debug.location_sources.hq_source_urls || [],
                    mfg_source_urls: next.enrichment_debug.location_sources.mfg_source_urls || [],
                  });
                }

                enriched[i] = next;
              }

              if (debugOutput && locationSourcesDebug.length) {
                debugOutput.location_sources_debug = locationSourcesDebug;
              }

              if (!noUpstreamMode && cosmosEnabled && locationSourcesDebug.length) {
                await upsertCosmosImportSessionDoc({
                  sessionId,
                  requestId,
                  patch: {
                    location_sources_debug: locationSourcesDebug,
                    location_sources_updated_at: new Date().toISOString(),
                  },
                }).catch(() => null);
              }
            } catch (refinementErr) {
              if (refinementErr instanceof AcceptedResponseError) throw refinementErr;
              console.warn(`[import-start] Grok location enrichment failed: ${refinementErr.message}`);
              // Continue with original data if enrichment fails
            } finally {
              mark("grok_location_enrichment_done");
            }
          }

          if (!shouldRunStage("location")) {
            mark("xai_location_refinement_skipped");
          }

          if (shouldStopAfterStage("location")) {
            const companiesCount = Array.isArray(enriched) ? enriched.length : 0;

            try {
              upsertImportSession({
                session_id: sessionId,
                request_id: requestId,
                status: "running",
                stage_beacon,
                companies_count: companiesCount,
              });
            } catch {}

            if (!noUpstreamMode && cosmosEnabled) {
              await upsertCosmosImportSessionDoc({
                sessionId,
                requestId,
                patch: {
                  status: "running",
                  stage_beacon,
                  companies_count: companiesCount,
                },
              }).catch(() => null);
            }

            return jsonWithRequestId(
              {
                ok: true,
                session_id: sessionId,
                request_id: requestId,
                stage_beacon,
                companies: enriched,
                meta: {
                  mode: "direct",
                  max_stage: maxStage,
                  skip_stages: Array.from(skipStages),
                  stopped_after_stage: "location",
                },
              },
              200
            );
          }

          if (shouldRunStage("location") && geocodeStageCompleted) {
            for (let i = 0; i < enriched.length; i += 1) {
              const c = enriched[i];

              const hqMeaningful = asMeaningfulString(c?.headquarters_location);
              const hasMfg = isRealValue("manufacturing_locations", c?.manufacturing_locations, c);

              if (!hqMeaningful) {
                // Terminal sentinel: we have attempted location enrichment and still found no HQ.
                const existingDebug = c?.enrichment_debug && typeof c.enrichment_debug === "object" ? c.enrichment_debug : {};
                const sources = Array.isArray(c?.location_sources) ? c.location_sources.slice(0, 10) : [];

                enriched[i] = {
                  ...c,
                  headquarters_location: "Not disclosed",
                  hq_unknown: true,
                  hq_unknown_reason: "not_disclosed",
                  red_flag: true,
                  red_flag_reason: String(c?.red_flag_reason || "Headquarters not disclosed").trim(),
                  enrichment_debug: {
                    ...existingDebug,
                    location: {
                      at: new Date().toISOString(),
                      outcome: "not_disclosed",
                      missing_hq: true,
                      missing_mfg: !hasMfg,
                      location_sources_count: Array.isArray(c?.location_sources) ? c.location_sources.length : 0,
                      location_sources: sources,
                    },
                  },
                };
              }

              if (!hasMfg && !c?.mfg_unknown) {
                // Non-retryable terminal sentinel (explicit + typed).
                const existingDebug = c?.enrichment_debug && typeof c.enrichment_debug === "object" ? c.enrichment_debug : {};
                const sources = Array.isArray(c?.location_sources) ? c.location_sources.slice(0, 10) : [];

                enriched[i] = {
                  ...(enriched[i] || c),
                  manufacturing_locations: ["Not disclosed"],
                  manufacturing_locations_reason: "not_disclosed",
                  mfg_unknown: true,
                  mfg_unknown_reason: "not_disclosed",
                  red_flag: true,
                  red_flag_reason: String(
                    (enriched[i] || c)?.red_flag_reason || "Manufacturing locations not disclosed"
                  ).trim(),
                  enrichment_debug: {
                    ...existingDebug,
                    location: {
                      at: new Date().toISOString(),
                      outcome: "not_disclosed",
                      missing_hq: !hqMeaningful,
                      missing_mfg: true,
                      location_sources_count: Array.isArray(c?.location_sources) ? c.location_sources.length : 0,
                      location_sources: sources,
                    },
                  },
                };
              }
            }

            enrichedForCounts = enriched;
          }

          // If we're deferring reviews to post-save, ensure every company already has
          // a stable reviews shape so we never finish an import with "reviews missing".
          if (shouldRunStage("reviews") && usePostSaveReviews) {
            const nowReviewsIso = new Date().toISOString();

            for (let i = 0; i < enriched.length; i += 1) {
              const c = enriched[i] && typeof enriched[i] === "object" ? enriched[i] : {};

              const curated = Array.isArray(c.curated_reviews)
                ? c.curated_reviews.filter((r) => r && typeof r === "object")
                : [];

              const reviewCount = Number.isFinite(Number(c.review_count)) ? Number(c.review_count) : curated.length;
              const cursorExisting = c.review_cursor && typeof c.review_cursor === "object" ? c.review_cursor : null;

              const cursor = cursorExisting
                ? { ...cursorExisting }
                : buildReviewCursor({
                    nowIso: nowReviewsIso,
                    count: reviewCount,
                    exhausted: false,
                    last_error: {
                      code: "REVIEWS_PENDING",
                      message: "Reviews will be fetched after company persistence",
                    },
                    prev_cursor: null,
                  });

              if (!cursor.reviews_stage_status) cursor.reviews_stage_status = "pending";

              enriched[i] = {
                ...c,
                curated_reviews: curated,
                review_count: reviewCount,
                reviews_last_updated_at: c.reviews_last_updated_at || nowReviewsIso,
                review_cursor: cursor,
                reviews_stage_status:
                  (typeof c.reviews_stage_status === "string" ? c.reviews_stage_status.trim() : "") || "pending",
                reviews_upstream_status: c.reviews_upstream_status ?? null,
              };
            }
          }

          let saveResult = { saved: 0, failed: 0, skipped: 0 };

          if (!dryRunRequested && enriched.length > 0 && cosmosEnabled) {
            const deadlineBeforeCosmosWrite = checkDeadlineOrReturn("cosmos_write_start");
            if (deadlineBeforeCosmosWrite) return deadlineBeforeCosmosWrite;

            // Enforce canonical "usable import" contract *before* persistence.
            // This ensures we never save partially undefined records.
            try {
              for (let i = 0; i < enriched.length; i += 1) {
                const base = enriched[i] && typeof enriched[i] === "object" ? enriched[i] : {};

                let company_name = String(base.company_name || base.name || "").trim();
                let website_url = String(base.website_url || base.url || base.canonical_url || "").trim();

                const import_missing_fields = Array.isArray(base.import_missing_fields)
                  ? base.import_missing_fields.map((v) => String(v || "").trim()).filter(Boolean)
                  : [];

                const import_missing_reason =
                  base.import_missing_reason && typeof base.import_missing_reason === "object" && !Array.isArray(base.import_missing_reason)
                    ? { ...base.import_missing_reason }
                    : {};

                const import_warnings = Array.isArray(base.import_warnings)
                  ? base.import_warnings.filter((w) => w && typeof w === "object")
                  : [];

                const LOW_QUALITY_MAX_ATTEMPTS = 3;

                const applyLowQualityPolicy = (field, reason) =>
                  applyLowQualityPolicyCore(field, reason, {
                    doc: base,
                    importMissingReason: import_missing_reason,
                    requestId,
                    maxAttempts: LOW_QUALITY_MAX_ATTEMPTS,
                  });

                const ensureMissing = (field, reason, message, retryable = true) => {
                  const entry = pushMissingFieldEntry(field, reason, {
                    root_cause: field,
                    message,
                    retryable,
                    importMissingFields: import_missing_fields,
                    importMissingReason: import_missing_reason,
                    importWarnings: import_warnings,
                  });

                  if (entry) {
                    // Session-level warning (visible in import completion doc)
                    addWarning(`import_missing_${field}_${i}`, {
                      stage: "enrich",
                      root_cause: `missing_${field}`,
                      missing_reason: entry.missing_reason,
                      retryable: entry.retryable,
                      terminal: entry.terminal,
                      message: entry.message,
                      company_name: company_name || undefined,
                      website_url: website_url || undefined,
                    });
                  }
                };

                // company_name
                if (!company_name) {
                  base.company_name = "Unknown";
                  base.company_name_unknown = true;
                  company_name = base.company_name;
                  ensureMissing("company_name", "missing", "company_name missing; set to placeholder 'Unknown'", false);
                }

                // website_url
                if (!website_url) {
                  base.website_url = "Unknown";
                  base.website_url_unknown = true;
                  if (!String(base.normalized_domain || "").trim()) base.normalized_domain = "unknown";
                  website_url = base.website_url;
                  ensureMissing("website_url", "missing", "website_url missing; set to placeholder 'Unknown'", false);
                }

                // industries â€” quality gate
                const industriesRaw = Array.isArray(base.industries) ? base.industries : [];
                const industriesSanitized = sanitizeIndustries(industriesRaw);

                if (industriesSanitized.length === 0) {
                  const hadAny = normalizeStringArray(industriesRaw).length > 0;

                  // Placeholder hygiene: keep canonical field empty.
                  base.industries = [];
                  base.industries_unknown = true;

                  const policy = applyLowQualityPolicy("industries", hadAny ? "low_quality" : "not_found");
                  const messageBase = hadAny
                    ? "Industries present but low-quality; cleared industries and marked industries_unknown=true"
                    : "Industries missing; left empty and marked industries_unknown=true";

                  const message =
                    policy.missing_reason === "low_quality_terminal"
                      ? `${messageBase} (terminal after ${policy.attemptCount || LOW_QUALITY_MAX_ATTEMPTS} attempts)`
                      : messageBase;

                  ensureMissing("industries", policy.missing_reason, message, policy.retryable);
                } else {
                  base.industries = industriesSanitized;
                  base.industries_unknown = false;
                }

                // product keywords â€” sanitize + quality gate
                if (!Array.isArray(base.keywords)) base.keywords = [];

                const keywordStats = sanitizeKeywords({
                  product_keywords: base.product_keywords,
                  keywords: base.keywords,
                });

                const meetsKeywordQuality = isRealValue(
                "product_keywords",
                keywordStats.sanitized.join(", "),
                { ...base, keywords: keywordStats.sanitized }
              );

                if (meetsKeywordQuality) {
                  base.keywords = keywordStats.sanitized;
                  base.product_keywords = keywordStats.sanitized.join(", ");
                  base.product_keywords_unknown = false;
                } else {
                  const hadAny = keywordStats.total_raw > 0;
                  base.keywords = keywordStats.sanitized;

                  // Placeholder hygiene: keep canonical field empty.
                  base.product_keywords = "";
                  base.product_keywords_unknown = true;

                  const policy = applyLowQualityPolicy("product_keywords", hadAny ? "low_quality" : "not_found");
                  const messageBase = hadAny
                    ? `product_keywords low quality (raw=${keywordStats.total_raw}, sanitized=${keywordStats.product_relevant_count}); cleared and marked product_keywords_unknown=true`
                    : "product_keywords missing; left empty and marked product_keywords_unknown=true";

                  const message =
                    policy.missing_reason === "low_quality_terminal"
                      ? `${messageBase} (terminal after ${policy.attemptCount || LOW_QUALITY_MAX_ATTEMPTS} attempts)`
                      : messageBase;

                  ensureMissing("product_keywords", policy.missing_reason, message, policy.retryable);
                }

                // headquarters_location is Grok-only (resume-worker). Do not force terminal sentinels here.
                if (!isRealValue("headquarters_location", base.headquarters_location, base)) {
                  const reasonRaw = String(
                    base.hq_unknown_reason || base.import_missing_reason?.headquarters_location || "seed_from_company_url"
                  )
                    .trim()
                    .toLowerCase();

                  base.hq_unknown = true;

                  if (reasonRaw === "not_disclosed") {
                    base.headquarters_location = "Not disclosed";
                    base.hq_unknown_reason = "not_disclosed";
                    ensureMissing(
                      "headquarters_location",
                      "not_disclosed",
                      "headquarters_location missing; recorded as terminal sentinel 'Not disclosed'",
                      false
                    );
                  } else {
                    base.headquarters_location = "";
                    base.hq_unknown_reason = base.hq_unknown_reason || "seed_from_company_url";
                    ensureMissing(
                      "headquarters_location",
                      String(base.hq_unknown_reason || "seed_from_company_url"),
                      "headquarters_location missing; left empty for resume-worker (hq_unknown=true)",
                      true
                    );
                  }
                }

                // manufacturing_locations is Grok-only (resume-worker). Do not force terminal sentinels here.
                {
                  const rawList = Array.isArray(base.manufacturing_locations)
                    ? base.manufacturing_locations
                    : base.manufacturing_locations == null
                      ? []
                      : [base.manufacturing_locations];

                  const normalized = rawList
                    .map((loc) => {
                      if (typeof loc === "string") return String(loc).trim().toLowerCase();
                      if (loc && typeof loc === "object") {
                        return String(loc.formatted || loc.full_address || loc.address || loc.location || "")
                          .trim()
                          .toLowerCase();
                      }
                      return "";
                    })
                    .filter(Boolean);

                  const hasNotDisclosed = normalized.length > 0 && normalized.every((v) => v === "not disclosed" || v === "not_disclosed");
                  const hasUnknownPlaceholder = normalized.length > 0 && normalized.every((v) => v === "unknown");

                  const hasRealMfg =
                    isRealValue("manufacturing_locations", base.manufacturing_locations, base) && !hasNotDisclosed && !hasUnknownPlaceholder;

                  if (!hasRealMfg) {
                    const reasonRaw = String(
                      base.mfg_unknown_reason || base.import_missing_reason?.manufacturing_locations || "seed_from_company_url"
                    )
                      .trim()
                      .toLowerCase();

                    base.mfg_unknown = true;

                    if (reasonRaw === "not_disclosed") {
                      base.manufacturing_locations = ["Not disclosed"];
                      base.mfg_unknown_reason = "not_disclosed";
                      ensureMissing(
                        "manufacturing_locations",
                        "not_disclosed",
                        "manufacturing_locations missing; recorded as terminal sentinel ['Not disclosed']",
                        false
                      );
                    } else {
                      base.manufacturing_locations = [];
                      base.mfg_unknown_reason = base.mfg_unknown_reason || "seed_from_company_url";
                      ensureMissing(
                        "manufacturing_locations",
                        String(base.mfg_unknown_reason || "seed_from_company_url"),
                        "manufacturing_locations missing; left empty for resume-worker (mfg_unknown=true)",
                        true
                      );
                    }
                  }
                }

                // logo
                if (!asMeaningfulString(base.logo_url)) {
                  base.logo_url = null;
                  base.logo_status = base.logo_status || "not_found_on_site";
                  base.logo_import_status = base.logo_import_status || "missing";
                  base.logo_stage_status = base.logo_stage_status || "not_found_on_site";
                  ensureMissing("logo", base.logo_stage_status, "logo_url missing or not imported");
                }

                // curated reviews
                if (!Array.isArray(base.curated_reviews)) base.curated_reviews = [];
                if (!Number.isFinite(Number(base.review_count))) base.review_count = base.curated_reviews.length;

                if (base.curated_reviews.length === 0) {
                  ensureMissing("curated_reviews", String(base.reviews_stage_status || "none"), "curated_reviews empty (persisted as empty list)");
                }

                // Persist per-company import diagnostics.
                base.import_missing_fields = import_missing_fields;
                base.import_missing_reason = import_missing_reason;
                base.import_warnings = import_warnings;

                enriched[i] = base;
              }
            } catch (placeholderErr) {
              // Never block imports on placeholder enforcement — but log for diagnostics.
              console.warn(`[import-start] session=${sessionId} placeholder enforcement error for company[${i}]: ${placeholderErr?.message || placeholderErr}`);
            }

            mark("cosmos_write_start");
            setStage("saveCompaniesToCosmos");
            console.log(`[import-start] session=${sessionId} saveCompaniesToCosmos start count=${enriched.length}`);
            const isExplicitCompanyImportMain =
              String(bodyObj?.queryType || "").trim() === "company_url" ||
              Boolean(String(bodyObj?.company_url_hint || "").trim());
            const saveResultRaw = await saveCompaniesToCosmos({
              companies: enriched,
              sessionId,
              requestId,
              sessionCreatedAt: sessionCreatedAtIso,
              axiosTimeout: timeout,
              saveStub: Boolean(bodyObj?.save_stub || bodyObj?.saveStub),
              getRemainingMs,
              allowUpdateExisting: isExplicitCompanyImportMain,
            });

            const verification = await verifySavedCompaniesReadAfterWrite(saveResultRaw).catch(() => ({
              verified_ids: [],
              unverified_ids: Array.isArray(saveResultRaw?.saved_ids) ? saveResultRaw.saved_ids : [],
              verified_persisted_items: [],
            }));

            saveResult = applyReadAfterWriteVerification(saveResultRaw, verification);
            saveReport = saveResult;

            const verifiedCount = Number(saveResult.saved_verified_count || 0) || 0;
            const unverifiedIds = Array.isArray(saveResult.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [];

            console.log(
              `[import-start] session=${sessionId} saveCompaniesToCosmos done saved_verified=${verifiedCount} saved_write=${Number(saveResult.saved_write_count || 0) || 0} skipped=${saveResult.skipped} failed=${saveResult.failed}`
            );

            if (Number(saveResult.saved_write_count || 0) > 0 && verifiedCount === 0) {
              addWarning("cosmos_read_after_write_failed", {
                stage: "save",
                root_cause: "read_after_write_failed",
                retryable: true,
                message: "Cosmos write reported success, but read-after-write verification could not read the document back.",
              });
            }

            if (unverifiedIds.length > 0) {
              addWarning("cosmos_saved_unverified", {
                stage: "save",
                root_cause: "read_after_write_partial",
                retryable: true,
                message: `Some saved company IDs could not be verified via read-after-write (${unverifiedIds.length}).`,
              });
            }

            // Compute saved company URLs early so both the in-memory sync and session doc upsert can use them.
            const savedCompanyUrls = (Array.isArray(enriched) ? enriched : [])
              .map((c) => String(c?.company_url || c?.website_url || c?.canonical_url || c?.url || "").trim())
              .filter(Boolean)
              .slice(0, 50);

            // â”€â”€ Sync in-memory store IMMEDIATELY after company save â”€â”€
            // import-status may poll at any moment on the same Azure Functions process.
            // By updating the in-memory store here (before the Cosmos session doc upsert),
            // we ensure that even the earliest status polls see the correct seed data.
            upsertImportSession({
              session_id: sessionId,
              request_id: requestId,
              status: "running",
              stage_beacon: "seed_saved_enriching_async",
              saved: verifiedCount,
              saved_verified_count: verifiedCount,
              saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified) ? saveResult.saved_company_ids_verified : [],
              saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [],
              saved_company_urls: savedCompanyUrls,
              save_outcome: "seed_saved",
              resume_needed: true,
              companies_count: enriched.length,
            });

            // Critical: persist canonical saved IDs immediately so /import/status can recover even if SWA kills
            // later enrichment stages.
            try {
              const cosmosTarget = await getCompaniesCosmosTargetDiagnostics().catch(() => null);

              const preSessionResult = await upsertCosmosImportSessionDoc({
                sessionId,
                requestId,
                patch: {
                  saved: verifiedCount,
                  saved_count: verifiedCount,
                  saved_verified_count: verifiedCount,
                  saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified) ? saveResult.saved_company_ids_verified : [],
                  saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [],
                  saved_company_ids: Array.isArray(saveResult.saved_company_ids_verified) ? saveResult.saved_company_ids_verified : [],
                  saved_company_urls: savedCompanyUrls,
                  saved_ids: Array.isArray(saveResult.saved_company_ids_verified) ? saveResult.saved_company_ids_verified : [],
                  saved_write_count: Number(saveResult.saved_write_count || 0) || 0,
                  saved_ids_write: Array.isArray(saveResult.saved_ids_write) ? saveResult.saved_ids_write : [],
                  skipped_ids: Array.isArray(saveResult.skipped_ids) ? saveResult.skipped_ids : [],
                  failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
                  ...(cosmosTarget ? cosmosTarget : {}),
                  stage_beacon: "seed_saved_enriching_async",
                  status: "running",
                },
              });
              if (!preSessionResult?.ok) {
                console.error(`[import-start] session=${sessionId} pre-202 session doc upsert FAILED: ${preSessionResult?.error || "unknown"}`);
              }

              // â”€â”€ CHANGE 3: Read-back verification â”€â”€
              // Verify the upsert actually persisted seed_saved_enriching_async.
              // If the read-back shows a stale beacon, force a direct upsert with explicit PK.
              if (preSessionResult?.ok) {
                try {
                  const verifyContainer = getCompaniesCosmosContainer();
                  if (verifyContainer) {
                    const verifyRead = await readItemWithPkCandidates(
                      verifyContainer,
                      `_import_session_${sessionId}`,
                      { id: `_import_session_${sessionId}`, ...buildImportControlDocBase(sessionId), created_at: "" }
                    );
                    const vBeacon = verifyRead?.stage_beacon || "NOT_FOUND";
                    const vSaved = verifyRead?.saved ?? "NOT_FOUND";
                    console.log(`[import-start] session=${sessionId} PRE-202 READ-BACK: beacon=${vBeacon} saved=${vSaved}`);
                    if (vBeacon !== "seed_saved_enriching_async") {
                      console.error(`[import-start] session=${sessionId} PRE-202 MISMATCH: expected seed_saved_enriching_async got ${vBeacon}`);
                      // Force direct upsert with explicit PK="import"
                      await verifyContainer.items.upsert({
                        id: `_import_session_${sessionId}`,
                        ...buildImportControlDocBase(sessionId),
                        created_at: new Date().toISOString(),
                        request_id: requestId,
                        saved: verifiedCount,
                        saved_count: verifiedCount,
                        saved_verified_count: verifiedCount,
                        saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified) ? saveResult.saved_company_ids_verified : [],
                        saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [],
                        saved_company_urls: savedCompanyUrls,
                        stage_beacon: "seed_saved_enriching_async",
                        status: "running",
                      }, { partitionKey: "import" }).catch((e) => {
                        console.error(`[import-start] session=${sessionId} FORCE DIRECT UPSERT FAILED: ${e?.message}`);
                      });
                    }
                  }
                } catch (verifyErr) {
                  console.warn(`[import-start] session=${sessionId} PRE-202 read-back failed: ${verifyErr?.message}`);
                }
              }

              const mandatoryCompanyIds = Array.from(
                new Set(
                  [
                    ...(Array.isArray(saveResult.saved_ids_write) ? saveResult.saved_ids_write : []),
                    ...(Array.isArray(saveResult.saved_company_ids_verified) ? saveResult.saved_company_ids_verified : []),
                    ...(Array.isArray(saveResult.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : []),
                    ...(Array.isArray(saveResult.saved_ids) ? saveResult.saved_ids : []),
                  ]
                    .map((v) => String(v || "").trim())
                    .filter(Boolean)
                )
              );

              // Build domain map from save results + enriched companies
              const mainDomainMap = {};
              if (Array.isArray(saveResult?.persisted_items)) {
                for (const pi of saveResult.persisted_items) {
                  const pid = String(pi?.id || "").trim();
                  const pd = String(pi?.normalized_domain || "").trim();
                  if (pid && pd) mainDomainMap[pid] = pd;
                }
              }
              if (Array.isArray(enriched)) {
                for (const ec of enriched) {
                  const eid = String(ec?.id || "").trim();
                  const ed = String(ec?.normalized_domain || "").trim();
                  if (eid && ed) mainDomainMap[eid] = ed;
                }
              }

              // â”€â”€ Fast-path 202: return BEFORE enrichment so SWA doesn't kill the connection â”€â”€
              if (isCompanyUrlFastPath && mandatoryCompanyIds.length > 0) {
                mark("fast_path_202_accepted");

                // (In-memory store sync moved earlier â€” runs immediately after saveCompaniesToCosmos,
                // before the Cosmos session doc upsert, to close the race window.)

                // â”€â”€ CHANGE 2: Write accept doc for fast-path 202 â”€â”€
                // The fast-path 202 bypasses AcceptedResponseError, which is where accept docs
                // are normally written. Without this, import-status returns accepted: false.
                try {
                  const fastPathContainer = getCompaniesCosmosContainer();
                  if (fastPathContainer) {
                    const fastPathAcceptDoc = {
                      id: `_import_accept_${sessionId}`,
                      ...buildImportControlDocBase(sessionId),
                      created_at: new Date().toISOString(),
                      accepted_at: new Date().toISOString(),
                      request_id: requestId,
                      stage_beacon: "seed_saved_enriching_async",
                      reason: "upstream_timeout_returning_202",
                    };
                    upsertItemWithPkCandidates(fastPathContainer, fastPathAcceptDoc).catch(() => null);
                  }
                } catch {}

                console.log(
                  `[import-start] session=${sessionId} FAST PATH 202: returning 202 Accepted, firing enrichment async for ${mandatoryCompanyIds.length} companies`
                );

                // Fire-and-forget: run enrichment asynchronously.
                // The Azure Function runtime keeps the execution context alive after
                // returning the HTTP response. Don't await â€” let it run in background.
                maybeQueueAndInvokeMandatoryEnrichment({
                  sessionId,
                  requestId,
                  context,
                  companyIds: mandatoryCompanyIds,
                  companyDomainMap: mainDomainMap,
                  reason: "seed_complete_auto_enrich",
                  cosmosEnabled,
                }).catch((enrichErr) => {
                  console.error(`[import-start] async enrichment failed: ${enrichErr?.message || enrichErr}`);
                });

                return jsonWithRequestId(
                  {
                    ok: true,
                    accepted: true,
                    session_id: sessionId,
                    request_id: requestId,
                    stage_beacon: "seed_saved_enriching_async",
                    saved: verifiedCount,
                    saved_count: verifiedCount,
                    saved_verified_count: verifiedCount,
                    saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified) ? saveResult.saved_company_ids_verified : [],
                    resume_needed: true,
                    companies: enriched.map((c) => ({
                      id: c.id,
                      company_name: c.company_name || c.name,
                      website_url: c.website_url,
                      normalized_domain: c.normalized_domain,
                    })),
                    meta: {
                      enrichment_mode: "async",
                      enrichment_budget_ms: 360000,
                    },
                  },
                  202
                );
              }

              const enqueueResult = await maybeQueueAndInvokeMandatoryEnrichment({
                sessionId,
                requestId,
                context,
                companyIds: mandatoryCompanyIds,
                companyDomainMap: mainDomainMap,
                reason: "seed_complete_auto_enrich",
                cosmosEnabled,
              }).catch((err) => {
                console.error(`[import-start] maybeQueueAndInvokeMandatoryEnrichment failed: ${err?.message || err}`);
                return { queued: false, invoked: false, error: err?.message };
              });

              // Fallback: if direct invocation failed, explicitly enqueue to resume-worker queue
              if (!enqueueResult?.invoked && !enqueueResult?.queued && mandatoryCompanyIds.length > 0) {
                console.log(`[import-start] Direct enrichment failed, attempting fallback queue for session ${sessionId}`);
                const fallbackResult = await enqueueResumeRun({
                  session_id: sessionId,
                  company_ids: mandatoryCompanyIds,
                  reason: "seed_complete_fallback_queue",
                  requested_by: "import_start",
                }).catch((qErr) => {
                  console.error(`[import-start] Fallback queue also failed: ${qErr?.message || qErr}`);
                  return null;
                });

                // Immediately invoke resume-worker if queue succeeded (don't wait for polling)
                if (fallbackResult?.ok) {
                  try {
                    const invokeRes = await invokeResumeWorkerInProcess({
                      session_id: sessionId,
                      context,
                      deadline_ms: 900000, // 15 minutes - allows all 7 fields to complete with thorough xAI research
                    });
                    console.log(`[import-start] seed_complete_fallback_queue: resume-worker invoked, ok=${invokeRes?.ok}`);
                  } catch (invokeErr) {
                    console.warn(`[import-start] seed_complete_fallback_queue: resume-worker invoke failed: ${invokeErr?.message}`);
                  }
                }

                // LAST RESORT: if queue also failed, run direct enrichment inline
                if (!fallbackResult?.ok) {
                  console.log(`[import-start] session=${sessionId} LAST RESORT: queue failed, running direct enrichment inline`);
                  try {
                    const lastResortContainer = getCompaniesCosmosContainer();
                    for (const companyId of mandatoryCompanyIds.slice(0, 5)) {
                      const doc = lastResortContainer
                        ? await readItemWithPkCandidates(lastResortContainer, companyId, { id: companyId }).catch(() => null)
                        : null;
                      if (!doc) continue;

                      const enrichResult = await runDirectEnrichment({
                        company: doc,
                        sessionId,
                        budgetMs: 240000,
                        fieldsToEnrich: [...MANDATORY_ENRICH_FIELDS],
                      });

                      if (enrichResult?.enriched && Object.keys(enrichResult.enriched).length > 0) {
                        const updatedDoc = await applyEnrichmentToCompany(doc, enrichResult);
                        if (lastResortContainer) {
                          await upsertItemWithPkCandidates(lastResortContainer, updatedDoc).catch(() => null);
                        }
                        console.log(
                          `[import-start] session=${sessionId} last-resort enrichment OK for ${companyId}: ${Object.keys(enrichResult.enriched).join(", ")}`
                        );
                      }
                    }
                  } catch (directErr) {
                    console.error(`[import-start] last-resort direct enrichment failed: ${directErr?.message || directErr}`);
                  }
                }
              }
            } catch {}
          }

          // Reviews stage MUST execute (success or classified failure) before import is considered complete.
          // When enabled, we use the exact same pipeline as the Company Dashboard "Fetch more reviews" button.
          if (!dryRunRequested && cosmosEnabled && shouldRunStage("reviews") && usePostSaveReviews) {
            const companiesContainer = getCompaniesCosmosContainer();
            const persistedItems = Array.isArray(saveResult?.persisted_items) ? saveResult.persisted_items : [];

            if (companiesContainer && persistedItems.length > 0) {
              ensureStageBudgetOrThrow("reviews", "xai_reviews_post_save_start");

              const deadlineBeforePostSaveReviews = checkDeadlineOrReturn("xai_reviews_post_save_start", "reviews");
              if (deadlineBeforePostSaveReviews) return deadlineBeforePostSaveReviews;

              mark("xai_reviews_post_save_start");
              setStage("refreshReviewsPostSave");

              const normalizeReviewsStageStatus = (doc) => {
                const d = doc && typeof doc === "object" ? doc : null;
                if (!d) return "";

                const top = typeof d.reviews_stage_status === "string" ? d.reviews_stage_status.trim() : "";
                if (top) return top;

                const cursorStatus =
                  d.review_cursor && typeof d.review_cursor === "object" && typeof d.review_cursor.reviews_stage_status === "string"
                    ? d.review_cursor.reviews_stage_status.trim()
                    : "";

                return cursorStatus;
              };

              const isTerminalReviewsStageStatus = (status) => {
                const s = typeof status === "string" ? status.trim() : "";
                return Boolean(s && s !== "pending");
              };

              let postSaveReviewsCompleted = true;

              let refreshReviewsHandler = null;
              try {
                const xadminMod = require("../xadmin-api-refresh-reviews/index.js");
                refreshReviewsHandler = xadminMod?.handler;
              } catch {
                refreshReviewsHandler = null;
              }

              for (const item of persistedItems) {
                const companyId = String(item?.id || "").trim();
                if (!companyId) continue;

                const companyIndex = Number.isFinite(Number(item?.index)) ? Number(item.index) : null;
                const companyName = String(item?.company_name || "");
                const normalizedDomain = String(item?.normalized_domain || "").trim();

                const remaining = getRemainingMs();
                const minWindowMs = DEADLINE_SAFETY_BUFFER_MS + 6000;

                // If we cannot safely run the upstream request, persist a classified failure state (never silent).
                if (remaining < minWindowMs || typeof refreshReviewsHandler !== "function") {
                  const nowIso = new Date().toISOString();
                  try {
                    const existingDoc = await readItemWithPkCandidates(companiesContainer, companyId, {
                      id: companyId,
                      normalized_domain: normalizedDomain || "unknown",
                      partition_key: normalizedDomain || "unknown",
                    }).catch(() => null);

                    if (existingDoc) {
                      const prevCursor = existingDoc.review_cursor && typeof existingDoc.review_cursor === "object" ? existingDoc.review_cursor : null;
                      const cursor = buildReviewCursor({
                        nowIso,
                        count: 0,
                        exhausted: false,
                        last_error: {
                          code: "REVIEWS_TIME_BUDGET_EXHAUSTED",
                          message: "Skipped reviews fetch during import due to low remaining time budget",
                          retryable: true,
                        },
                        prev_cursor: prevCursor,
                      });
                      cursor.reviews_stage_status = "upstream_unreachable";

                      const patched = {
                        ...existingDoc,
                        review_cursor: cursor,
                        reviews_stage_status: "upstream_unreachable",
                        reviews_upstream_status: null,
                        reviews_attempts_count: 0,
                        reviews_retry_exhausted: false,
                        updated_at: nowIso,
                      };

                      const upserted = await upsertItemWithPkCandidates(companiesContainer, patched).catch(() => null);
                      if (!upserted || upserted.ok !== true) {
                        postSaveReviewsCompleted = false;
                      }

                      if (companyIndex != null && enriched[companyIndex]) {
                        enriched[companyIndex] = {
                          ...(enriched[companyIndex] || {}),
                          curated_reviews: Array.isArray(patched.curated_reviews) ? patched.curated_reviews : [],
                          review_count: Number(patched.review_count) || 0,
                          review_cursor: patched.review_cursor,
                          reviews_stage_status: patched.reviews_stage_status,
                          reviews_upstream_status: patched.reviews_upstream_status,
                        };
                      }
                    } else {
                      postSaveReviewsCompleted = false;
                    }
                  } catch {}

                  warnReviews({
                    stage: "reviews",
                    root_cause: "upstream_unreachable",
                    retryable: true,
                    upstream_status: null,
                    message:
                      typeof refreshReviewsHandler !== "function"
                        ? "Reviews refresh handler unavailable"
                        : "Skipped reviews due to low remaining time budget",
                    company_name: companyName,
                  });
                  continue;
                }

                // Execute the refresh pipeline with a timeout clamped to remaining budget.
                const timeoutMs = Math.max(
                  5000,
                  Math.min(
                    20000,
                    timeout,
                    Math.trunc(remaining - DEADLINE_SAFETY_BUFFER_MS - UPSTREAM_TIMEOUT_MARGIN_MS)
                  )
                );

                const reqMock = {
                  method: "POST",
                  url: "https://internal/api/xadmin-api-refresh-reviews",
                  headers: new Headers(),
                  json: async () => ({ company_id: companyId, take: 2, timeout_ms: timeoutMs }),
                };

                let refreshPayload = null;
                try {
                  const res = await refreshReviewsHandler(reqMock, context, {
                    companiesContainer,
                    validate_review_urls: false,
                  });
                  refreshPayload = safeJsonParse(res?.body);
                } catch (e) {
                  refreshPayload = { ok: false, root_cause: "unhandled_exception", message: e?.message || String(e) };
                }

                if (!refreshPayload || refreshPayload.ok !== true) {
                  warnReviews({
                    stage: "reviews",
                    root_cause: String(refreshPayload?.root_cause || "unknown"),
                    retryable: typeof refreshPayload?.retryable === "boolean" ? refreshPayload.retryable : true,
                    upstream_status: refreshPayload?.upstream_status ?? null,
                    message: String(refreshPayload?.message || "Reviews stage failed"),
                    company_name: companyName,
                  });
                }

                // Best-effort: load the updated company doc so the import response is consistent with persistence.
                // Critical requirement: do not let the import finalize while reviews_stage_status is missing or still "pending".
                try {
                  let latest = await readItemWithPkCandidates(companiesContainer, companyId, {
                    id: companyId,
                    normalized_domain: normalizedDomain || "unknown",
                    partition_key: normalizedDomain || "unknown",
                  }).catch(() => null);

                  if (!latest) {
                    postSaveReviewsCompleted = false;
                  } else {
                    const latestStatus = normalizeReviewsStageStatus(latest);

                    if (!isTerminalReviewsStageStatus(latestStatus)) {
                      const nowTerminalIso = new Date().toISOString();

                      try {
                        const prevCursor =
                          latest.review_cursor && typeof latest.review_cursor === "object" ? latest.review_cursor : null;

                        const count =
                          typeof latest.review_count === "number" && Number.isFinite(latest.review_count)
                            ? latest.review_count
                            : Array.isArray(latest.curated_reviews)
                              ? latest.curated_reviews.length
                              : 0;

                        const cursor = buildReviewCursor({
                          nowIso: nowTerminalIso,
                          count,
                          exhausted: false,
                          last_error: {
                            code: "REVIEWS_POST_SAVE_DID_NOT_FINALIZE",
                            message: "Reviews stage did not reach a terminal state during import; marking as terminal for diagnostics",
                            retryable: true,
                          },
                          prev_cursor: prevCursor,
                        });
                        cursor.reviews_stage_status = "unhandled_exception";

                        const patched = {
                          ...latest,
                          review_cursor: cursor,
                          reviews_stage_status: "unhandled_exception",
                          reviews_upstream_status: null,
                          updated_at: nowTerminalIso,
                        };

                        const upserted = await upsertItemWithPkCandidates(companiesContainer, patched).catch(() => null);
                        if (upserted && upserted.ok === true) {
                          latest = patched;
                        } else {
                          postSaveReviewsCompleted = false;
                        }

                        warnReviews({
                          stage: "reviews",
                          root_cause: "unhandled_exception",
                          retryable: true,
                          upstream_status: null,
                          message: "Reviews stage did not finalize during import; marking terminal state",
                          company_name: companyName,
                        });
                      } catch {
                        postSaveReviewsCompleted = false;
                      }
                    }
                  }

                  if (latest && companyIndex != null && enriched[companyIndex]) {
                    enriched[companyIndex] = {
                      ...(enriched[companyIndex] || {}),
                      curated_reviews: Array.isArray(latest.curated_reviews) ? latest.curated_reviews : [],
                      review_count: Number(latest.review_count) || 0,
                      reviews_last_updated_at: latest.reviews_last_updated_at || (enriched[companyIndex] || {}).reviews_last_updated_at,
                      review_cursor: latest.review_cursor || (enriched[companyIndex] || {}).review_cursor,
                      reviews_stage_status:
                        typeof latest.reviews_stage_status === "string" && latest.reviews_stage_status.trim()
                          ? latest.reviews_stage_status.trim()
                          : typeof latest?.review_cursor?.reviews_stage_status === "string"
                            ? latest.review_cursor.reviews_stage_status
                            : (enriched[companyIndex] || {}).reviews_stage_status,
                      reviews_upstream_status: latest.reviews_upstream_status ?? (enriched[companyIndex] || {}).reviews_upstream_status,
                    };
                  }
                } catch {
                  postSaveReviewsCompleted = false;
                }
              }

              // Final guard: do not allow completion while any persisted company remains pending/missing.
              try {
                const pendingCompanyIds = [];

                for (const item of persistedItems) {
                  const companyId = String(item?.id || "").trim();
                  if (!companyId) continue;

                  const normalizedDomain = String(item?.normalized_domain || "").trim();

                  const latest = await readItemWithPkCandidates(companiesContainer, companyId, {
                    id: companyId,
                    normalized_domain: normalizedDomain || "unknown",
                    partition_key: normalizedDomain || "unknown",
                  }).catch(() => null);

                  const status = normalizeReviewsStageStatus(latest);
                  if (!isTerminalReviewsStageStatus(status)) {
                    pendingCompanyIds.push(companyId);
                  }
                }

                if (pendingCompanyIds.length > 0) {
                  postSaveReviewsCompleted = false;
                  warnReviews({
                    stage: "reviews",
                    root_cause: "pending",
                    retryable: true,
                    upstream_status: null,
                    message: `Reviews stage still pending for ${pendingCompanyIds.length} persisted compan${pendingCompanyIds.length === 1 ? "y" : "ies"}; import will not finalize as complete`,
                    company_name: "",
                  });
                }
              } catch {
                postSaveReviewsCompleted = false;
              }

              reviewStageCompleted = postSaveReviewsCompleted;
              mark(postSaveReviewsCompleted ? "xai_reviews_post_save_done" : "xai_reviews_post_save_partial");
            }
          }

          // Detect when ALL results were skipped as duplicates â€” short-circuit expansion and return immediately
          const allSkippedAsDuplicates =
            cosmosEnabled &&
            Number(saveResult.saved || 0) === 0 &&
            Number(saveResult.failed || 0) === 0 &&
            Number(saveResult.skipped || 0) > 0 &&
            Array.isArray(saveResult.skipped_duplicates) &&
            saveResult.skipped_duplicates.length > 0 &&
            saveResult.skipped_duplicates.some((d) => d?.duplicate_of_id);

          if (allSkippedAsDuplicates) {
            const firstDup = saveResult.skipped_duplicates.find((d) => d?.duplicate_of_id) || saveResult.skipped_duplicates[0] || {};
            const dupId = String(firstDup.duplicate_of_id || "").trim();
            const dupName = String(firstDup.company_name || "").trim();

            console.log(`[import-start] session=${sessionId} All ${saveResult.skipped} result(s) are existing duplicates (${dupName || "unknown"}, id=${dupId}). Skipping expansion.`);

            mark("cosmos_write_done");

            // Write final session doc
            try {
              await upsertCosmosImportSessionDoc({
                sessionId,
                requestId,
                patch: {
                  status: "complete",
                  stage_beacon: "duplicate_detected",
                  save_outcome: "duplicate_detected",
                  saved: 0,
                  saved_verified_count: 0,
                  saved_company_ids_verified: [],
                  saved_company_ids_unverified: [],
                  skipped: Number(saveResult.skipped || 0),
                  skipped_ids: Array.isArray(saveResult.skipped_ids) ? saveResult.skipped_ids : [],
                  skipped_duplicates: saveResult.skipped_duplicates,
                  duplicate_of_id: dupId || null,
                  duplicate_company_name: dupName || null,
                  completed_at: new Date().toISOString(),
                  resume_needed: false,
                  last_error: {
                    code: "DUPLICATE_DETECTED",
                    message: `${dupName || "Company"} already exists in the database${dupId ? ` (${dupId})` : ""}`,
                  },
                },
              }).catch(() => null);
            } catch {}

            try {
              upsertImportSession({
                session_id: sessionId,
                request_id: requestId,
                status: "complete",
                stage_beacon: "duplicate_detected",
                companies_count: Number(saveResult.skipped || 0),
              });
            } catch {}

            return jsonWithRequestId(
              {
                ok: true,
                session_id: sessionId,
                request_id: requestId,
                completed: true,
                stage_beacon: "duplicate_detected",
                save_outcome: "duplicate_detected",
                duplicate_of_id: dupId || null,
                duplicate_company_name: dupName || null,
                saved: 0,
                skipped: Number(saveResult.skipped || 0),
                failed: 0,
                last_error: {
                  code: "DUPLICATE_DETECTED",
                  message: `${dupName || "Company"} already exists in the database${dupId ? ` (${dupId})` : ""}`,
                },
                save_report: saveReport,
              },
              200
            );
          }

          const effectiveResultCountForExpansion = cosmosEnabled ? saveResult.saved + saveResult.failed : enriched.length;

          // If expand_if_few is enabled and we got very few results (or all were skipped), try alternative search
          // But skip if we're running out of time
          const minThreshold = Math.max(1, Math.ceil(xaiPayload.limit * 0.6));
          if (shouldRunStage("expand") && xaiPayload.expand_if_few && effectiveResultCountForExpansion < minThreshold && companies.length > 0 && !shouldAbort()) {
            console.log(
              `[import-start] Few results found (${cosmosEnabled ? `${saveResult.saved} saved, ${saveResult.skipped} skipped` : `${enriched.length} found (no_cosmos mode)`}). Attempting expansion search.`
            );

            try {
              // Create a more general search prompt for related companies
              const expansionMessage = {
                role: "user",
                content: `You previously found companies for "${xaiPayload.query}" (${xaiPayload.queryType}).
Find ${xaiPayload.limit} MORE DIFFERENT companies that are related to "${xaiPayload.query}" (search type(s): ${xaiPayload.queryType}${xaiPayload.location ? `, location boost: ${xaiPayload.location}` : ""}) but were not in the previous results.
PRIORITIZE finding smaller, regional, and lesser-known companies that are alternatives to major brands.
Focus on independent manufacturers, craft producers, specialty companies, and regional players that serve the same market.

For EACH company, you MUST AGGRESSIVELY extract:
1. headquarters_location: City, State/Region, Country format (required - check official site, government buyer guides, B2B directories, LinkedIn, Crunchbase)
2. manufacturing_locations: Array of locations from ALL sources including:
   - Official site and product pages
   - Government Buyer Guides (Yumpu, GSA, etc.) - often list manufacturing explicitly
   - B2B/Industrial Manufacturer Directories (Thomas Register, etc.)
   - Supplier and import/export records
   - Packaging claims and "Made in..." labels
   - Media articles
   Be AGGRESSIVE in extraction - NEVER return empty without exhaustively checking all sources above
   - Country-only entries (e.g., "United States", "China") are FULLY ACCEPTABLE

Format your response as a valid JSON array with this structure:
- company_name (string)
- website_url (string)
- industries (array)
- product_keywords (string): Comma-separated list of up to 25 concrete product keywords (real products/product lines/product categories; no vague marketing terms; prefer noun phrases; include flagship + secondary products; infer industry-standard product types if needed; no near-duplicates; no services unless primarily services)
- headquarters_location (string, REQUIRED - "City, State/Region, Country" format, or empty only if truly unknown after checking all sources)
- manufacturing_locations (array, REQUIRED - must include all locations from government guides, B2B directories, suppliers, customs, packaging, media. Use country-only entries if that's all known. NEVER empty without exhaustive checking)
- red_flag (boolean, optional)
- red_flag_reason (string, optional)
- location_confidence (string, optional)
- amazon_url, social (optional)

IMPORTANT: Do not leave manufacturing_locations empty after checking government guides, B2B directories, and trade data. Prefer "United States" or "China" over empty array.

Return ONLY the JSON array, no other text.`,
              };

              const expansionPayload = {
                model: "grok-4-latest",
                messages: [
                  { role: "system", content: XAI_SYSTEM_PROMPT },
                  expansionMessage,
                ],
                // Expansion prompt asks for HQ/MFG using third-party sources; enforce live search.
                search_parameters: { mode: "on" },
                temperature: 0.3,
                stream: false,
              };

              console.log(
                `[import-start] Making expansion search for "${xaiPayload.query}" (upstream=${toHostPathOnlyForLog(xaiUrl)})`
              );

              ensureStageBudgetOrThrow("expand", "xai_expand_fetch_start");

              const deadlineBeforeExpand = checkDeadlineOrReturn("xai_expand_fetch_start", "expand");
              if (deadlineBeforeExpand) return deadlineBeforeExpand;

              mark("xai_expand_fetch_start");
              const expansionResponse = await postXaiJsonWithBudgetRetry({
                stageKey: "expand",
                stageBeacon: "xai_expand_fetch_start",
                body: JSON.stringify(expansionPayload),
                stageCapMsOverride: Math.min(timeout, 25000),
              });

              if (expansionResponse.status >= 200 && expansionResponse.status < 300) {
                const expansionText = extractXaiResponseText(expansionResponse.data) || "";
                console.log(`[import-start] Expansion response preview: ${expansionText.substring(0, 100)}...`);

                let expansionCompanies = [];
                try {
                  const jsonMatch = expansionText.match(/\[[\s\S]*\]/);
                  if (jsonMatch) {
                    expansionCompanies = JSON.parse(jsonMatch[0]);
                    if (!Array.isArray(expansionCompanies)) expansionCompanies = [];
                  }
                } catch (parseErr) {
                  console.warn(`[import-start] Failed to parse expansion companies: ${parseErr.message}`);
                }

                console.log(`[import-start] Found ${expansionCompanies.length} companies in expansion search`);

                if (expansionCompanies.length > 0) {
                  let enrichedExpansion = expansionCompanies.map((c) => enrichCompany(c, center));
                  enrichedExpansion = await mapWithConcurrency(enrichedExpansion, 4, ensureCompanyKeywords);

                  // Geocode expansion companies
                  console.log(`[import-start] Geocoding ${enrichedExpansion.length} expansion companies`);
                  for (let i = 0; i < enrichedExpansion.length; i++) {
                    const company = enrichedExpansion[i];
                    if (company.headquarters_location && company.headquarters_location.trim()) {
                      const geoResult = await geocodeHQLocation(company.headquarters_location);
                      if (geoResult.hq_lat !== undefined && geoResult.hq_lng !== undefined) {
                        enrichedExpansion[i] = { ...company, ...geoResult };
                        console.log(`[import-start] Geocoded expansion company ${company.company_name}: ${company.headquarters_location} â†’ (${geoResult.hq_lat}, ${geoResult.hq_lng})`);
                      }
                    }
                  }

                  // Reviews are Grok-only (xAI live search) and run post-save for persisted companies.
                  if (assertNoWebsiteFallback("reviews")) {
                    console.log(
                      `[import-start] Skipping pre-save reviews for expansion companies (Grok-only post-save stage).`
                    );
                  }

                  enriched = enriched.concat(enrichedExpansion);

                  // Re-save with expansion results
                  if (cosmosEnabled) {
                    const expansionRaw = await saveCompaniesToCosmos({
                      companies: enrichedExpansion,
                      sessionId,
                      requestId,
                      sessionCreatedAt: sessionCreatedAtIso,
                      axiosTimeout: timeout,
                      saveStub: Boolean(bodyObj?.save_stub || bodyObj?.saveStub),
                      getRemainingMs,
                    });

                    const expansionVerification = await verifySavedCompaniesReadAfterWrite(expansionRaw).catch(() => ({
                      verified_ids: [],
                      unverified_ids: Array.isArray(expansionRaw?.saved_ids) ? expansionRaw.saved_ids : [],
                      verified_persisted_items: [],
                    }));

                    const expansionResult = applyReadAfterWriteVerification(expansionRaw, expansionVerification);

                    const mergeUnique = (a, b) => {
                      const out = [];
                      const seen = new Set();
                      for (const id of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
                        const key = String(id || "").trim();
                        if (!key || seen.has(key)) continue;
                        seen.add(key);
                        out.push(key);
                      }
                      return out;
                    };

                    const mergedVerifiedIds = mergeUnique(
                      Array.isArray(saveResult?.saved_company_ids_verified) ? saveResult.saved_company_ids_verified : saveResult?.saved_ids,
                      Array.isArray(expansionResult?.saved_company_ids_verified) ? expansionResult.saved_company_ids_verified : expansionResult?.saved_ids
                    );

                    const mergedUnverifiedIds = mergeUnique(
                      Array.isArray(saveResult?.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [],
                      Array.isArray(expansionResult?.saved_company_ids_unverified) ? expansionResult.saved_company_ids_unverified : []
                    );

                    const mergedWriteIds = mergeUnique(
                      Array.isArray(saveResult?.saved_ids_write) ? saveResult.saved_ids_write : [],
                      Array.isArray(expansionResult?.saved_ids_write) ? expansionResult.saved_ids_write : []
                    );

                    saveResult = {
                      ...(saveResult && typeof saveResult === "object" ? saveResult : {}),
                      saved: mergedVerifiedIds.length,
                      saved_verified_count: mergedVerifiedIds.length,
                      saved_company_ids_verified: mergedVerifiedIds,
                      saved_company_ids_unverified: mergedUnverifiedIds,
                      saved_ids: mergedVerifiedIds,
                      saved_write_count: (Number(saveResult?.saved_write_count || 0) || 0) + (Number(expansionResult?.saved_write_count || 0) || 0),
                      saved_ids_write: mergedWriteIds,
                      skipped: (Number(saveResult?.skipped || 0) || 0) + (Number(expansionResult?.skipped || 0) || 0),
                      failed: (Number(saveResult?.failed || 0) || 0) + (Number(expansionResult?.failed || 0) || 0),
                      persisted_items: [
                        ...(Array.isArray(saveResult?.persisted_items) ? saveResult.persisted_items : []),
                        ...(Array.isArray(expansionResult?.persisted_items) ? expansionResult.persisted_items : []),
                      ],
                    };

                    saveReport = saveResult;
                    console.log(
                      `[import-start] Expansion: saved_verified ${Number(expansionResult.saved_verified_count || 0) || 0}, saved_write ${Number(expansionResult.saved_write_count || 0) || 0}, skipped ${expansionResult.skipped}, failed ${expansionResult.failed}`
                    );
                  }
                }
              }
            } catch (expansionErr) {
              if (expansionErr instanceof AcceptedResponseError) throw expansionErr;
              console.warn(`[import-start] Expansion search failed: ${expansionErr.message}`);
              // Continue without expansion results
            } finally {
              mark("xai_expand_fetch_done");
            }
          }

          const elapsed = Date.now() - startTime;
          const timedOut = isOutOfTime();

          if (noCosmosMode) {
            try {
              upsertImportSession({
                session_id: sessionId,
                request_id: requestId,
                status: "complete",
                stage_beacon,
                companies_count: Array.isArray(enriched) ? enriched.length : 0,
              });
            } catch {}

            return jsonWithRequestId(
              {
                ok: true,
                no_cosmos: true,
                stage_reached: stage_reached || "after_xai_primary_fetch",
                stage_beacon,
                session_id: sessionId,
                request_id: requestId,
                xai_request_id: contextInfo.xai_request_id,
                resolved_upstream_url_redacted: redactUrlQueryAndHash(xaiUrl) || null,
                build_id: buildInfo?.build_id || null,
                companies: enriched,
                meta: {
                  mode: "direct",
                  expanded: xaiPayload.expand_if_few && effectiveResultCountForExpansion < minThreshold,
                  timedOut: timedOut,
                  elapsedMs: elapsed,
                  cosmos_skipped: true,
                },
              },
              200
            );
          }

          const enrichmentMissingByCompany = (Array.isArray(enriched) ? enriched : [])
            .map((c) => {
              const missing = computeEnrichmentMissingFields(c);
              if (missing.length === 0) return null;
              return {
                company_name: String(c?.company_name || c?.name || "").trim(),
                website_url: String(c?.website_url || c?.url || "").trim(),
                normalized_domain: String(c?.normalized_domain || "").trim(),
                missing_fields: missing,
              };
            })
            .filter(Boolean);

          // Default to allowing the resume-worker (so required fields complete automatically)
          // unless the caller explicitly disables it.
          const allowResumeWorker = !(
            bodyObj?.allow_resume_worker === false ||
            bodyObj?.allowResumeWorker === false ||
            bodyObj?.allowResume === false ||
            String(readQueryParam(req, "allow_resume_worker") || "").trim() === "0" ||
            String(readQueryParam(req, "allowResumeWorker") || "").trim() === "0" ||
            String(readQueryParam(req, "allowResume") || "").trim() === "0"
          );

          const hasPersistedWrite =
            Number(saveResult.saved_write_count || 0) > 0 ||
            (Array.isArray(saveResult.saved_ids_write) && saveResult.saved_ids_write.length > 0);

          const hasMissingRequired = enrichmentMissingByCompany.length > 0;

          // Default (single-path) behavior: if we persisted anything but required enrichment fields are still missing,
          // fail deterministically rather than relying on a separate resume-worker invocation.
          if (!dryRunRequested && cosmosEnabled && hasPersistedWrite && hasMissingRequired && !allowResumeWorker) {
            mark("required_fields_missing_single_path");

            const failedAt = new Date().toISOString();

            const last_error = {
              code: "REQUIRED_FIELDS_MISSING",
              message:
                "Import incomplete: required fields missing after inline stages. Resume-worker is disabled (single-path), so failing deterministically.",
            };

            if (cosmosEnabled) {
              try {
                const container = getCompaniesCosmosContainer();
                if (container) {
                  const errorDoc = {
                    id: `_import_error_${sessionId}`,
                    ...buildImportControlDocBase(sessionId),
                    request_id: requestId,
                    stage: "required_fields_missing",
                    error: last_error,
                    details: {
                      stage_beacon,
                      deferred_stages: Array.from(deferredStages),
                      missing_by_company: enrichmentMissingByCompany,
                      saved_write_count: Number(saveResult.saved_write_count || 0) || 0,
                      saved_ids_write: Array.isArray(saveResult.saved_ids_write) ? saveResult.saved_ids_write : [],
                      saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
                      saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified)
                        ? saveResult.saved_company_ids_verified
                        : [],
                      saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified)
                        ? saveResult.saved_company_ids_unverified
                        : [],
                    },
                    failed_at: failedAt,
                  };

                  await upsertItemWithPkCandidates(container, errorDoc).catch(() => null);

                  await upsertCosmosImportSessionDoc({
                    sessionId,
                    requestId,
                    patch: {
                      status: "error",
                      stage_beacon: "required_fields_missing",
                      last_error,
                      save_outcome: typeof saveResult?.save_outcome === "string" ? saveResult.save_outcome : null,
                      saved: Number(saveResult.saved || 0) || 0,
                      skipped: Number(saveResult.skipped || 0) || 0,
                      failed: Number(saveResult.failed || 0) || 0,
                      saved_count: Number(saveResult.saved_write_count || 0) || Number(saveResult.saved || 0) || 0,
                      saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
                      saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified)
                        ? saveResult.saved_company_ids_verified
                        : [],
                      saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified)
                        ? saveResult.saved_company_ids_unverified
                        : [],
                      saved_company_ids: Array.isArray(saveResult.saved_ids_write)
                        ? saveResult.saved_ids_write
                        : Array.isArray(saveResult.saved_ids)
                          ? saveResult.saved_ids
                          : [],
                      saved_company_urls: (Array.isArray(enriched) ? enriched : [])
                        .map((c) => String(c?.company_url || c?.website_url || c?.canonical_url || c?.url || "").trim())
                        .filter(Boolean)
                        .slice(0, 50),
                      deferred_stages: Array.from(deferredStages),
                      resume_needed: false,
                      resume_updated_at: failedAt,
                      updated_at: failedAt,
                    },
                  }).catch(() => null);
                }
              } catch {}
            }

            try {
              upsertImportSession({
                session_id: sessionId,
                request_id: requestId,
                status: "error",
                stage_beacon: "required_fields_missing",
                companies_count: Array.isArray(enriched) ? enriched.length : 0,
                resume_needed: false,
                last_error,
                saved: Number(saveResult.saved || 0) || 0,
                saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
                saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified)
                  ? saveResult.saved_company_ids_verified
                  : [],
                saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified)
                  ? saveResult.saved_company_ids_unverified
                  : [],
              });
            } catch {}

            const cosmosTarget = cosmosEnabled ? await getCompaniesCosmosTargetDiagnostics().catch(() => null) : null;

            return jsonWithRequestId(
              {
                ok: false,
                session_id: sessionId,
                request_id: requestId,
                status: "error",
                stage_beacon: "required_fields_missing",
                resume_needed: false,
                last_error,
                deferred_stages: Array.from(deferredStages),
                missing_by_company: enrichmentMissingByCompany,
                ...(cosmosTarget ? cosmosTarget : {}),
                saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
                saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified)
                  ? saveResult.saved_company_ids_verified
                  : Array.isArray(saveResult.saved_ids)
                    ? saveResult.saved_ids
                    : [],
                saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified)
                  ? saveResult.saved_company_ids_unverified
                  : [],
                saved: saveResult.saved,
                skipped: saveResult.skipped,
                failed: saveResult.failed,
                save_report: buildSaveReport(saveResult),
              },
              200
            );
          }

          // Only mark the session as resume-needed if we successfully persisted at least one company.
          // Otherwise we can get stuck in "running" forever because resume-worker has nothing to load.
          // Status must never be the orchestrator; import-start already queued + invoked resume-worker
          // immediately after the seed save.
          const needsResume = false;

          if (needsResume) {
            let resumeDocPersisted = false;
            mark("enrichment_incomplete");

            if (cosmosEnabled) {
              try {
                const container = getCompaniesCosmosContainer();
                if (container) {
                  const resumeDocId = `_import_resume_${sessionId}`;
                  const nowResumeIso = new Date().toISOString();

                  const resumeDoc = {
                    id: resumeDocId,
                    ...buildImportControlDocBase(sessionId),
                    created_at: nowResumeIso,
                    updated_at: nowResumeIso,
                    request_id: requestId,
                    status: gatewayKeyConfigured ? "queued" : "stalled",
                    resume_auth: buildResumeAuthDiagnostics(),
                    ...(gatewayKeyConfigured
                      ? {}
                      : {
                          stalled_at: nowResumeIso,
                          last_error: buildResumeStallError(),
                        }),
                    saved_count: Number(saveResult.saved_write_count || 0) || 0,
                    saved_company_ids: Array.isArray(saveResult.saved_ids_write)
                      ? saveResult.saved_ids_write
                      : Array.isArray(saveResult.saved_ids)
                        ? saveResult.saved_ids
                        : [],
                    saved_company_urls: (Array.isArray(enriched) ? enriched : [])
                      .map((c) => String(c?.company_url || c?.website_url || c?.canonical_url || c?.url || "").trim())
                      .filter(Boolean)
                      .slice(0, 50),
                    deferred_stages: Array.from(deferredStages),
                    missing_by_company: enrichmentMissingByCompany,
                    keywords_stage_completed: Boolean(keywordStageCompleted),
                    reviews_stage_completed: Boolean(reviewStageCompleted),
                    location_stage_completed: Boolean(geocodeStageCompleted),
                  };

                  const resumeUpsert = await upsertItemWithPkCandidates(container, resumeDoc).catch(() => ({ ok: false }));
                  resumeDocPersisted = Boolean(resumeUpsert && resumeUpsert.ok);
                }

                await upsertCosmosImportSessionDoc({
                  sessionId,
                  requestId,
                  patch: {
                    status: "running",
                    stage_beacon: stage_beacon,
                    saved: Number(saveResult.saved || 0) || 0,
                    skipped: Number(saveResult.skipped || 0) || 0,
                    failed: Number(saveResult.failed || 0) || 0,
                    saved_count: Number(saveResult.saved_write_count || 0) || Number(saveResult.saved || 0) || 0,
                    saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
                    saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified)
                      ? saveResult.saved_company_ids_verified
                      : [],
                    saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified)
                      ? saveResult.saved_company_ids_unverified
                      : [],
                    saved_company_ids: Array.isArray(saveResult.saved_ids_write)
                      ? saveResult.saved_ids_write
                      : Array.isArray(saveResult.saved_ids)
                        ? saveResult.saved_ids
                        : [],
                    saved_company_urls: (Array.isArray(enriched) ? enriched : [])
                      .map((c) => String(c?.company_url || c?.website_url || c?.canonical_url || c?.url || "").trim())
                      .filter(Boolean)
                      .slice(0, 50),
                    deferred_stages: Array.from(deferredStages),
                    saved_ids: Array.isArray(saveResult.saved_ids_write)
                      ? saveResult.saved_ids_write
                      : Array.isArray(saveResult.saved_ids)
                        ? saveResult.saved_ids
                        : [],
                    skipped_ids: Array.isArray(saveResult.skipped_ids) ? saveResult.skipped_ids : [],
                    failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
                    resume_needed: true,
                    resume_updated_at: new Date().toISOString(),
                  },
                }).catch(() => null);
              } catch {}
            }

            // Auto-trigger the resume worker so missing enrichment stages get another chance
            // without requiring the client to manually poke the worker.
            try {
              const resumeWorkerRequested = !(bodyObj?.auto_resume === false || bodyObj?.autoResume === false);
              const invocationIsResumeWorker = String(new URL(req.url).searchParams.get("resume_worker") || "") === "1";

              let resumeEnqueue = null;

              if (resumeWorkerRequested && !invocationIsResumeWorker && resumeDocPersisted) {
                const resumeCompanyIds = Array.isArray(saveResult?.saved_ids_write)
                  ? saveResult.saved_ids_write
                  : Array.isArray(saveResult?.saved_company_ids_verified)
                    ? saveResult.saved_company_ids_verified
                    : Array.isArray(saveResult?.saved_ids)
                      ? saveResult.saved_ids
                      : [];

                // Build domain map from save results
                const lateDomainMap = {};
                if (Array.isArray(saveResult?.persisted_items)) {
                  for (const pi of saveResult.persisted_items) {
                    const pid = String(pi?.id || "").trim();
                    const pd = String(pi?.normalized_domain || "").trim();
                    if (pid && pd) lateDomainMap[pid] = pd;
                  }
                }

                resumeEnqueue = await maybeQueueAndInvokeMandatoryEnrichment({
                  sessionId,
                  requestId,
                  context,
                  companyIds: resumeCompanyIds,
                  companyDomainMap: lateDomainMap,
                  reason: "seed_complete_auto_enrich",
                  cosmosEnabled,
                }).catch((err) => {
                  console.error(`[import-start] maybeQueueAndInvokeMandatoryEnrichment failed: ${err?.message || err}`);
                  return { queued: false, invoked: false, error: err?.message };
                });

                // Fallback: if direct invocation failed, explicitly enqueue to resume-worker queue
                if (!resumeEnqueue?.invoked && !resumeEnqueue?.queued && resumeCompanyIds.length > 0) {
                  console.log(`[import-start] Direct enrichment failed, attempting fallback queue for session ${sessionId}`);
                  const fallbackQueue = await enqueueResumeRun({
                    session_id: sessionId,
                    company_ids: resumeCompanyIds,
                    reason: "auto_enrich_fallback_queue",
                    requested_by: "import_start",
                  }).catch((qErr) => {
                    console.error(`[import-start] Fallback queue also failed: ${qErr?.message || qErr}`);
                    return null;
                  });
                  if (fallbackQueue?.ok) {
                    console.log(`[import-start] Fallback queue succeeded: ${JSON.stringify(fallbackQueue)}`);
                    resumeEnqueue = {
                      queued: true,
                      enqueued: true,
                      queue: fallbackQueue.queue,
                      message_id: fallbackQueue.message_id,
                      fallback: true,
                    };

                    // Immediately invoke resume-worker to process the queued item (don't wait for polling)
                    try {
                      const invokeRes = await invokeResumeWorkerInProcess({
                        session_id: sessionId,
                        context,
                        deadline_ms: 900000, // 15 minutes - allows all 7 fields to complete with thorough xAI research
                      });
                      console.log(`[import-start] auto_enrich_fallback_queue: resume-worker invoked, ok=${invokeRes?.ok}`);
                      resumeEnqueue.invoked = Boolean(invokeRes?.ok);
                    } catch (invokeErr) {
                      console.warn(`[import-start] auto_enrich_fallback_queue: resume-worker invoke failed: ${invokeErr?.message}`);
                      resumeEnqueue.invoked = false;
                    }
                  }
                }
              }
            } catch {}

            return jsonWithRequestId(
              {
                ok: true,
                session_id: sessionId,
                request_id: requestId,
                stage_beacon,
                status: "running",
                resume_needed: true,
                resume: {
                  status: resumeEnqueue?.enqueued ? "queued" : resumeWorkerRequested ? "stalled" : "skipped",
                  enqueued: Boolean(resumeEnqueue?.enqueued),
                  queue: resumeEnqueue?.queue || null,
                  message_id: resumeEnqueue?.message_id || null,
                  internal_auth_configured: Boolean(internalAuthConfigured),
                  ...buildResumeAuthDiagnostics(),
                },
                deferred_stages: Array.from(deferredStages),
                saved_count: Number(saveResult.saved_write_count || 0) || Number(saveResult.saved || 0) || 0,
                saved_company_ids: Array.isArray(saveResult.saved_ids_write)
                  ? saveResult.saved_ids_write
                  : Array.isArray(saveResult.saved_ids)
                    ? saveResult.saved_ids
                    : [],
                saved_company_urls: (Array.isArray(enriched) ? enriched : [])
                  .map((c) => String(c?.company_url || c?.website_url || c?.canonical_url || c?.url || "").trim())
                  .filter(Boolean)
                  .slice(0, 50),
                missing_by_company: enrichmentMissingByCompany,
                companies: enriched,
                saved: saveResult.saved,
                skipped: saveResult.skipped,
                failed: saveResult.failed,
                save_report: buildSaveReport(saveResult),
              },
              200
            );
          }

          // Write a completion marker so import-progress knows this session is done
          if (cosmosEnabled) {
            try {
              const container = getCompaniesCosmosContainer();
              if (container) {
                const warningKeyList = Array.from(warningKeys);

                const completionReason = timedOut
                  ? "max_processing_time_exceeded"
                  : warningKeyList.length
                    ? "completed_with_warnings"
                    : "completed_normally";

                const completionDoc = timedOut
                  ? {
                      id: `_import_timeout_${sessionId}`,
                      ...buildImportControlDocBase(sessionId),
                      completed_at: new Date().toISOString(),
                      elapsed_ms: elapsed,
                      reason: completionReason,
                      ...(warningKeyList.length
                        ? {
                            warnings: warningKeyList,
                            warnings_detail,
                            warnings_v2,
                          }
                        : {}),
                    }
                  : {
                      id: `_import_complete_${sessionId}`,
                      ...buildImportControlDocBase(sessionId),
                      completed_at: new Date().toISOString(),
                      elapsed_ms: elapsed,
                      reason: completionReason,
                      saved: saveResult.saved,
                      skipped: saveResult.skipped,
                      failed: saveResult.failed,
                      saved_ids: Array.isArray(saveResult.saved_ids) ? saveResult.saved_ids : [],
                      skipped_ids: Array.isArray(saveResult.skipped_ids) ? saveResult.skipped_ids : [],
                      skipped_duplicates: Array.isArray(saveResult.skipped_duplicates) ? saveResult.skipped_duplicates : [],
                      failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
                      ...(warningKeyList.length
                        ? {
                            warnings: warningKeyList,
                            warnings_detail,
                            warnings_v2,
                          }
                        : {}),
                    };

                const result = await upsertItemWithPkCandidates(container, completionDoc);
                if (!result.ok) {
                  console.warn(
                    `[import-start] request_id=${requestId} session=${sessionId} failed to upsert completion marker: ${result.error}`
                  );
                } else if (timedOut) {
                  console.log(`[import-start] request_id=${requestId} session=${sessionId} timeout signal written`);
                } else {
                  console.log(
                    `[import-start] request_id=${requestId} session=${sessionId} completion marker written (saved=${saveResult.saved})`
                  );
                }

                await upsertCosmosImportSessionDoc({
                  sessionId,
                  requestId,
                  patch: {
                    status: timedOut ? "timeout" : "complete",
                    stage_beacon,
                    saved: saveResult.saved,
                    skipped: saveResult.skipped,
                    failed: saveResult.failed,
                    saved_ids: Array.isArray(saveResult.saved_ids) ? saveResult.saved_ids : [],
                    skipped_ids: Array.isArray(saveResult.skipped_ids) ? saveResult.skipped_ids : [],
                    failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
                    completed_at: completionDoc.completed_at,
                    ...(warningKeyList.length
                      ? {
                          warnings: warningKeyList,
                          warnings_detail,
                          warnings_v2,
                        }
                      : {}),
                  },
                }).catch(() => null);
              }
            } catch (e) {
              console.warn(
                `[import-start] request_id=${requestId} session=${sessionId} error writing completion marker: ${e?.message || String(e)}`
              );
            }

            mark("cosmos_write_done");
          }

          try {
            upsertImportSession({
              session_id: sessionId,
              request_id: requestId,
              status: "complete",
              stage_beacon,
              companies_count: Array.isArray(enriched) ? enriched.length : 0,
            });
          } catch {}

          const cosmosTarget = cosmosEnabled ? await getCompaniesCosmosTargetDiagnostics().catch(() => null) : null;

          return jsonWithRequestId(
            {
              ok: true,
              session_id: sessionId,
              request_id: requestId,
              details:
                requestDetails ||
                buildRequestDetails(req, {
                  body_source,
                  body_source_detail,
                  raw_text_preview,
                  raw_text_starts_with_brace,
                }),
              company_name: contextInfo.company_name,
              website_url: contextInfo.website_url,
              companies: enriched,
              meta: {
                mode: "direct",
                expanded: xaiPayload.expand_if_few && effectiveResultCountForExpansion < minThreshold,
                timedOut: timedOut,
                elapsedMs: elapsed,
              },
              completed_with_warnings: Boolean(warningKeys.size),
              ...(cosmosTarget ? cosmosTarget : {}),
              saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
              saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified)
                ? saveResult.saved_company_ids_verified
                : Array.isArray(saveResult.saved_ids)
                  ? saveResult.saved_ids
                  : [],
              saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [],
              saved: saveResult.saved,
              skipped: saveResult.skipped,
              failed: saveResult.failed,
              save_report: buildSaveReport(saveResult),
              ...(warningKeys.size ? { warnings: Array.from(warningKeys), warnings_detail, warnings_v2 } : {}),
              ...(debugOutput ? { debug: debugOutput } : {}),
            },
            200
          );
        } else {
          console.error(`[import-start] XAI error status: ${xaiResponse.status}`);
          const upstreamRequestId = extractXaiRequestId(xaiResponse.headers || {});
          const upstreamTextPreview = toTextPreview(xaiResponse.data);

          const xaiUrlForLog = toHostPathOnlyForLog(xaiUrl);
          console.error(
            `[import-start] session=${sessionId} upstream XAI non-2xx (${xaiResponse.status}) url=${xaiUrlForLog}`
          );

          const upstreamStatus = xaiResponse.status;
          const mappedStatus = upstreamStatus >= 400 && upstreamStatus < 500 ? upstreamStatus : 502;

          if (xaiCallMeta && typeof xaiCallMeta === "object") {
            xaiCallMeta.stage = "xai_error";
            xaiCallMeta.upstream_status = upstreamStatus;
          }

          logImportStartMeta({
            request_id: requestId,
            session_id: sessionId,
            handler_version: handlerVersion,
            stage: "xai_error",
            queryTypes,
            query_len: query.length,
            prompt_len: xaiCallMeta?.prompt_len || 0,
            messages_len: xaiCallMeta?.messages_len || 0,
            has_system_message: Boolean(xaiCallMeta?.has_system_message),
            has_user_message: Boolean(xaiCallMeta?.has_user_message),
            user_message_len: Number.isFinite(Number(xaiCallMeta?.user_message_len)) ? Number(xaiCallMeta.user_message_len) : 0,
            elapsedMs: Date.now() - startTime,
            upstream_status: upstreamStatus,
          });

          const failurePayload = {
            ok: false,
            stage: stage_beacon || "xai_primary_fetch_done",
            session_id: sessionId,
            request_id: requestId,
            resolved_upstream_url_redacted: redactUrlQueryAndHash(xaiUrl) || null,
            upstream_status: upstreamStatus,
            xai_request_id: upstreamRequestId || null,
            build_id: buildInfo?.build_id || null,
            error_message: `Upstream XAI returned ${upstreamStatus}`,
            upstream_text_preview: toTextPreview(xaiResponse.data, 1000),
          };

          return jsonWithRequestId({ ...failurePayload, http_status: mappedStatus }, 200);
        }
      } catch (xaiError) {
        if (xaiError instanceof AcceptedResponseError) throw xaiError;
        const elapsed = Date.now() - startTime;
        const xaiUrlForLog = toHostPathOnlyForLog(xaiUrl);
        console.error(
          `[import-start] session=${sessionId} xai call failed url=${xaiUrlForLog}: ${xaiError.message}`
        );
        console.error(`[import-start] session=${sessionId} error code: ${xaiError.code}`);
        if (xaiError.response) {
          console.error(`[import-start] session=${sessionId} xai error status: ${xaiError.response.status}`);
          console.error(
            `[import-start] session=${sessionId} xai error data preview: ${toTextPreview(xaiError.response.data).slice(0, 200)}`
          );
        }

        // Write timeout signal if this took too long
        if (cosmosEnabled && (isOutOfTime() || (xaiError.code === 'ECONNABORTED' || xaiError.message.includes('timeout')))) {
          try {
            console.log(
              `[import-start] request_id=${requestId} session=${sessionId} timeout detected during XAI call, writing timeout signal`
            );
            const container = getCompaniesCosmosContainer();
            if (container) {
              const timeoutDoc = {
                id: `_import_timeout_${sessionId}`,
                ...buildImportControlDocBase(sessionId),
                failed_at: new Date().toISOString(),
                elapsed_ms: elapsed,
                error: toErrorString(xaiError),
              };
              const result = await upsertItemWithPkCandidates(container, timeoutDoc);
              if (!result.ok) {
                console.warn(
                  `[import-start] request_id=${requestId} session=${sessionId} failed to upsert timeout signal: ${result.error}`
                );
              } else {
                console.log(`[import-start] request_id=${requestId} session=${sessionId} timeout signal written`);
              }
            }
          } catch (e) {
            console.warn(
              `[import-start] request_id=${requestId} session=${sessionId} failed to write timeout signal: ${e?.message || String(e)}`
            );
          }
        }

        const upstreamStatus = xaiError?.response?.status || null;
        if (xaiCallMeta && typeof xaiCallMeta === "object") {
          xaiCallMeta.stage = "xai_error";
          xaiCallMeta.upstream_status = upstreamStatus;
          xaiCallMeta.elapsedMs = elapsed;
        }
        const isTimeout =
          isOutOfTime() ||
          xaiError?.code === "ECONNABORTED" ||
          xaiError?.name === "CanceledError" ||
          String(xaiError?.message || "").toLowerCase().includes("timeout") ||
          String(xaiError?.message || "").toLowerCase().includes("aborted");

        const upstreamErrorCode =
          upstreamStatus === 400
            ? "IMPORT_START_UPSTREAM_BAD_REQUEST"
            : upstreamStatus === 401 || upstreamStatus === 403
              ? "IMPORT_START_UPSTREAM_UNAUTHORIZED"
              : upstreamStatus === 429
                ? "IMPORT_START_UPSTREAM_RATE_LIMITED"
                : upstreamStatus === 404
                  ? "IMPORT_START_UPSTREAM_NOT_FOUND"
                  : "IMPORT_START_UPSTREAM_FAILED";

        const upstreamMessage =
          upstreamStatus === 400
            ? "Upstream rejected the request (400)"
            : upstreamStatus === 401 || upstreamStatus === 403
              ? "XAI endpoint rejected the request (unauthorized). Check XAI_EXTERNAL_KEY / authorization settings."
              : upstreamStatus === 429
                ? "XAI endpoint rate-limited the request (429)."
                : upstreamStatus === 404
                  ? "XAI endpoint returned 404 (not found). Check XAI_EXTERNAL_BASE configuration."
                  : `XAI call failed: ${toErrorString(xaiError)}`;

        const mappedStatus = isTimeout ? 504 : upstreamStatus >= 400 && upstreamStatus < 500 ? upstreamStatus : 502;

        const upstreamRequestId = extractXaiRequestId(xaiError?.response?.headers || {});
        const upstreamTextPreview = toTextPreview(xaiError?.response?.data || xaiError?.response?.body || "");

        logImportStartMeta({
          request_id: requestId,
          session_id: sessionId,
          handler_version: handlerVersion,
          stage: "xai_error",
          queryTypes,
          query_len: query.length,
          prompt_len: xaiCallMeta?.prompt_len || 0,
          messages_len: xaiCallMeta?.messages_len || 0,
          has_system_message: Boolean(xaiCallMeta?.has_system_message),
          has_user_message: Boolean(xaiCallMeta?.has_user_message),
          user_message_len: Number.isFinite(Number(xaiCallMeta?.user_message_len)) ? Number(xaiCallMeta.user_message_len) : 0,
          elapsedMs: Date.now() - startTime,
          upstream_status: upstreamStatus,
        });

        const failurePayload = {
          ok: false,
          stage: stage_beacon || "xai_primary_fetch_start",
          session_id: sessionId,
          request_id: requestId,
          resolved_upstream_url_redacted: redactUrlQueryAndHash(xaiUrl) || null,
          upstream_status: upstreamStatus,
          xai_request_id: upstreamRequestId || null,
          build_id: buildInfo?.build_id || null,
          error_message: upstreamMessage || "XAI call failed",
          error_code: upstreamErrorCode,
          upstream_text_preview: toTextPreview(
            xaiError?.response?.data || xaiError?.response?.body || xaiError?.message || String(xaiError || ""),
            1000
          ),
        };

        return jsonWithRequestId({ ...failurePayload, http_status: mappedStatus }, 200);
      }
      } catch (e) {
        if (e instanceof AcceptedResponseError && e.response) {
          const isCompanyUrlImport =
            Array.isArray(queryTypes) &&
            queryTypes.includes("company_url") &&
            typeof query === "string" &&
            query.trim() &&
            looksLikeCompanyUrlQuery(query);

          if (isCompanyUrlImport) {
            const fallback = await respondWithCompanyUrlSeedFallback(e);
            if (fallback) return fallback;
          }

          return e.response;
        }

        return respondError(e, { status: 500 });
      }
    } catch (e) {
      if (e instanceof AcceptedResponseError && e.response) {
        const isCompanyUrlImport =
          Array.isArray(bodyObj?.queryTypes) &&
          bodyObj.queryTypes.map((t) => String(t || "").trim()).includes("company_url") &&
          typeof bodyObj?.query === "string" &&
          bodyObj.query.trim() &&
          looksLikeCompanyUrlQuery(bodyObj.query);

        if (isCompanyUrlImport) {
          const fallback = await respondWithCompanyUrlSeedFallback(e);
          if (fallback) return fallback;
        }

        return e.response;
      }

      const lastStage = String(stage_beacon || stage || "fatal") || "fatal";
      const error_message = toErrorString(e) || "Unhandled error";

      const stackRaw = e && typeof e === "object" && typeof e.stack === "string" ? e.stack : "";
      const stackRedacted = stackRaw
        ? stackRaw
            .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
            .replace(/(xai[_-]?key|function[_-]?key|cosmos[_-]?key)\s*[:=]\s*[^\s]+/gi, "$1=[REDACTED]")
        : "";
      const error_stack_preview = toTextPreview(stackRedacted || "", 2000);

      try {
        upsertImportSession({
          session_id: sessionId,
          request_id: requestId,
          status: "failed",
          stage_beacon: lastStage,
          companies_count: Array.isArray(enrichedForCounts) ? enrichedForCounts.length : 0,
        });
      } catch {}

      console.error("[import-start] Unhandled error:", error_message);

      // Avoid returning 5xx (SWA can mask it as raw text). Always return JSON.
      return jsonWithRequestId(
        {
          ok: false,
          stage: "import_start",
          stage_beacon: lastStage,
          root_cause: "server_exception",
          retryable: true,
          request_id: requestId,
          session_id: sessionId,
          error_message,
          error_stack_preview,
        },
        200
      );
    }
  };

const importStartHandler = async (req, context) => {
  try {
    return await importStartHandlerInner(req, context);
  } catch (e) {
    if (e instanceof AcceptedResponseError && e.response) return e.response;
    let requestId = "";
    try {
      requestId = generateRequestId(req);
    } catch {
      requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }

    const responseHeaders = { "x-request-id": requestId };

    const buildInfoSafe = (() => {
      try {
        return getBuildInfo();
      } catch {
        return { build_id: "unknown", build_id_source: "error", runtime: {} };
      }
    })();

    const handlerVersion = getImportStartHandlerVersion(buildInfoSafe);

    const env_present = {
      has_xai_key: Boolean(getXAIKey()),
      has_xai_base_url: Boolean(getXAIEndpoint()),
      has_import_start_proxy_base: false,
    };

    const defaultModel = "grok-4-0709";
    let resolved_upstream_url_redacted = null;
    try {
      const xaiEndpointRaw = getXAIEndpoint();
      const xaiUrl = resolveXaiEndpointForModel(xaiEndpointRaw, defaultModel);
      resolved_upstream_url_redacted = redactUrlQueryAndHash(xaiUrl) || null;
    } catch {
      resolved_upstream_url_redacted = null;
    }

    const anyErr = e && typeof e === "object" ? e : null;
    const stage = typeof anyErr?.stage === "string" && anyErr.stage.trim() ? anyErr.stage.trim() : "top_level_handler";

    const upstream_status = Number.isFinite(Number(anyErr?.upstream_status)) ? Number(anyErr.upstream_status) : null;

    const xai_request_id =
      typeof anyErr?.xai_request_id === "string" && anyErr.xai_request_id.trim()
        ? anyErr.xai_request_id.trim()
        : null;

    const error_message = toErrorString(e) || "Import start failed";

    const stackRaw = typeof anyErr?.stack === "string" ? anyErr.stack : "";
    const stackRedacted = stackRaw
      ? stackRaw
          .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
          .replace(/(xai[_-]?key|function[_-]?key|cosmos[_-]?key)\s*[:=]\s*[^\s]+/gi, "$1=[REDACTED]")
      : "";

    const error_stack_preview = toTextPreview(stackRedacted || "", 2000);

    const error_id = makeErrorId();
    const stage_beacon = typeof anyErr?.stage_beacon === "string" && anyErr.stage_beacon.trim() ? anyErr.stage_beacon.trim() : stage;

    logImportStartErrorLine({ error_id, stage_beacon, root_cause: "server_exception", err: e });

    console.error("[import-start] Top-level handler error:", error_message);

    return json(
      {
        ok: false,
        stage,
        stage_beacon,
        root_cause: "server_exception",
        retryable: true,
        http_status: 500,
        error_id,
        request_id: requestId,
        handler_version: handlerVersion,
        build_id: buildInfoSafe?.build_id || null,
        resolved_upstream_url_redacted,
        upstream_status,
        xai_request_id,
        error_message,
        error_stack_preview,
        env_present,
      },
      200,
      responseHeaders
    );
  }
};

// ── Extracted module: xAI smoke handler + safe handler wrapper ─────────────
const { xaiSmokeHandler, createSafeHandler } = require("./_importStartXaiSmoke");

app.http("xai-smoke", {
  route: "xai/smoke",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: xaiSmokeHandler,
});

const importStartSwaWrapper = require("../_importStartWrapper");

app.http("import-start", {
  route: "import/start",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => importStartSwaWrapper(req, context),
});

// Legacy alias: some clients still call /api/import-start.
app.http("import-start-legacy", {
  route: "import-start",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => importStartSwaWrapper(req, context),
});

const safeHandler = createSafeHandler(importStartHandler, { stage: "import_start" });

module.exports = {
  handler: safeHandler,
  safeHandler,
  _test: {
    readJsonBody,
    readQueryParam,
    importStartHandler,
    buildReviewsUpstreamPayloadForImportStart,
    createSafeHandler,
  },
};
