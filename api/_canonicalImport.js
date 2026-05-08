// _canonicalImport.js
// Single-call canonical xAI import — Phase 2 of the single-call import plan.
//
// Replaces the multi-stage runDirectEnrichment pipeline with one
// /v1/responses call that asks for all fields at once, modelled on the
// grok.com prompt admin uses for manual cleanup.
//
// Activated by XAI_SINGLE_CALL_MODE=on in the Function App config. Default
// is off; the legacy multi-stage path stays the production behavior until
// production-parity testing confirms the single-call output quality.
//
// Output contract MIRRORS runDirectEnrichment so the handler doesn't need
// to special-case the result downstream. applyEnrichmentToCompany,
// markFieldSuccess, terminalize*, etc. all keep working unchanged.

"use strict";

const {
  buildCanonicalImportPrompt,
  CANONICAL_IMPORT_JSON_SCHEMA,
  parseCanonicalJson,
  DEFAULT_CANONICAL_FIELDS,
  PROMPT_GUIDANCE_VERSION,
} = require("./_xaiPromptGuidance");

const { xaiLiveSearch, xaiLiveSearchStreaming, extractTextFromXaiResponse } = require("./_xaiLiveSearch");
const { buildSearchParameters } = require("./_buildSearchParameters");

const DEFAULT_TIMEOUT_MS = 150_000;
const DEFAULT_MAX_TOOL_CALLS = 5;
const MIN_TIMEOUT_MS = 30_000;

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function isComplete(field, value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "boolean") return true;
  return value != null;
}

function extractWebsiteHost(websiteUrl) {
  const raw = asString(websiteUrl).trim();
  if (!raw) return "";
  try {
    return new URL(raw.startsWith("http") ? raw : `https://${raw}`).hostname || "";
  } catch {
    return "";
  }
}

/**
 * Build the response_format declaration for the canonical schema.
 * Pulled out so tests can assert the exact shape we send to xAI.
 */
function buildResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "company_research",
      schema: CANONICAL_IMPORT_JSON_SCHEMA,
      strict: true,
    },
  };
}

/**
 * Map a parsed canonical JSON object (already conforming to
 * CANONICAL_IMPORT_JSON_SCHEMA) into the enriched-result shape that
 * applyEnrichmentToCompany expects. Defensive — the schema guarantees
 * structural validity, but the parser can return null on transport
 * failures.
 */
function shapeEnrichedFromParsed(parsed) {
  return {
    tagline: asString(parsed?.tagline),
    headquarters_location: asString(parsed?.headquarters_location),
    manufacturing_locations: Array.isArray(parsed?.manufacturing_locations) ? parsed.manufacturing_locations : [],
    industries: Array.isArray(parsed?.industries) ? parsed.industries : [],
    product_keywords: asString(parsed?.product_keywords),
    reviews: Array.isArray(parsed?.reviews) ? parsed.reviews : [],
    location_source_urls:
      parsed?.location_source_urls && typeof parsed.location_source_urls === "object"
        ? {
            hq_source_urls: Array.isArray(parsed.location_source_urls.hq_source_urls)
              ? parsed.location_source_urls.hq_source_urls
              : [],
            mfg_source_urls: Array.isArray(parsed.location_source_urls.mfg_source_urls)
              ? parsed.location_source_urls.mfg_source_urls
              : [],
          }
        : { hq_source_urls: [], mfg_source_urls: [] },
    red_flag: Boolean(parsed?.red_flag),
    social: parsed?.social && typeof parsed.social === "object" ? parsed.social : {},
  };
}

/**
 * Decide per-field success from the enriched output. A field is "completed"
 * if the model returned a non-empty value (string non-blank, array non-empty,
 * boolean considered always complete). Empty values are treated as
 * "not_found" — the canonical prompt explicitly instructs the model to
 * return empty rather than hallucinate, so empty IS the verified signal.
 */
function classifyFields(fieldsToEnrich, enriched) {
  const fields_completed = [];
  const fields_failed = [];
  const errors = {};
  for (const f of fieldsToEnrich) {
    const v = enriched[f];
    if (isComplete(f, v)) {
      fields_completed.push(f);
    } else {
      fields_failed.push(f);
      errors[f] = "not_found";
    }
  }
  return { fields_completed, fields_failed, errors };
}

function buildFailureResult({ fieldsToEnrich, errorCode, elapsedMs, diagnostics }) {
  const fields = Array.isArray(fieldsToEnrich) && fieldsToEnrich.length ? fieldsToEnrich : DEFAULT_CANONICAL_FIELDS;
  const errors = Object.fromEntries(fields.map((f) => [f, errorCode]));
  return {
    ok: false,
    fields_completed: [],
    fields_failed: [...fields],
    errors,
    enriched: {},
    elapsed_ms: elapsedMs,
    diagnostics: {
      canonical_call: true,
      guidance_version: PROMPT_GUIDANCE_VERSION,
      ...(diagnostics || {}),
    },
  };
}

/**
 * Single-call replacement for runDirectEnrichment. Returns the same shape
 * so resume-worker handler.js can consume the result without branching
 * downstream.
 *
 * @param {Object} opts
 * @param {Object} opts.company - The company doc (provides company_name,
 *        url, website_url, normalized_domain).
 * @param {string} opts.sessionId - Session id; reused as conversation_id
 *        for prefix caching across companies in the same batch.
 * @param {number} opts.budgetMs - Remaining wall-clock budget. Timeout is
 *        clamped to [MIN_TIMEOUT_MS, DEFAULT_TIMEOUT_MS].
 * @param {string[]} [opts.fieldsToEnrich] - Fields to populate (JSON-key
 *        names). Defaults to DEFAULT_CANONICAL_FIELDS.
 * @param {AbortSignal} [opts.signal] - Worker orphan-detection signal.
 * @param {Function} [opts.onIntermediateSave] - Optional callback to flush
 *        verified fields to Cosmos before the function returns. Mirrors
 *        runDirectEnrichment's intermediate-save behavior.
 * @param {Object} [opts.modelOverride] - Optional override of the model
 *        used (mostly for testing).
 * @returns {Promise<Object>} { ok, fields_completed, fields_failed, errors,
 *        enriched, elapsed_ms, diagnostics }
 */
async function runCanonicalImportCall({
  company,
  sessionId,
  budgetMs,
  fieldsToEnrich,
  signal,
  onIntermediateSave,
  modelOverride,
} = {}) {
  const startedAt = Date.now();

  const companyName = asString(company?.company_name);
  const websiteUrl = asString(company?.url) || asString(company?.website_url);
  const websiteHost = extractWebsiteHost(websiteUrl);

  const requested = Array.isArray(fieldsToEnrich) && fieldsToEnrich.length ? fieldsToEnrich : [...DEFAULT_CANONICAL_FIELDS];

  // Clamp timeout to budget but never below 30s (a tighter cap risks killing
  // calls before any tool work completes).
  const fromBudget = Number.isFinite(Number(budgetMs)) ? Number(budgetMs) - 5_000 : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, Math.min(DEFAULT_TIMEOUT_MS, fromBudget));

  const sp = buildSearchParameters({ companyWebsiteHost: websiteHost });
  const prompt = buildCanonicalImportPrompt({
    companyName,
    websiteUrl,
    fields: requested,
    includeSourceUrls: true,
  });
  const promptBody = `${prompt}${sp.prompt_exclusion_text || ""}`;

  const model = asString(modelOverride).trim() || asString(process.env.XAI_MODEL).trim() || "grok-4-latest";
  const response_format = buildResponseFormat();

  // Streaming first (preferred — partial-flush handler salvages tool-budget aborts).
  let res;
  try {
    res = await xaiLiveSearchStreaming({
      prompt: promptBody,
      timeoutMs,
      model,
      search_parameters: sp.search_parameters,
      enableImageUnderstanding: false,
      maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
      conversationId: sessionId,
      signal,
      response_format,
    });
  } catch (err) {
    return buildFailureResult({
      fieldsToEnrich: requested,
      errorCode: "upstream_unreachable",
      elapsedMs: Date.now() - startedAt,
      diagnostics: { stream_threw: String(err?.message || err) },
    });
  }

  // xaiLiveSearchStreaming returns null when the configured endpoint is
  // /chat/completions instead of /responses. Fall back to the non-streaming
  // call so the canonical path works regardless of endpoint config.
  if (res === null) {
    try {
      res = await xaiLiveSearch({
        prompt: promptBody,
        maxTokens: 4000,
        timeoutMs,
        model,
        search_parameters: sp.search_parameters,
        useTools: true,
        conversationId: sessionId,
        signal,
        response_format,
      });
    } catch (err) {
      return buildFailureResult({
        fieldsToEnrich: requested,
        errorCode: "upstream_unreachable",
        elapsedMs: Date.now() - startedAt,
        diagnostics: { non_stream_threw: String(err?.message || err) },
      });
    }
  }

  const elapsedMs = Date.now() - startedAt;

  if (!res || !res.ok) {
    return buildFailureResult({
      fieldsToEnrich: requested,
      errorCode: res?.error_code || "upstream_unreachable",
      elapsedMs,
      diagnostics: {
        upstream_status: res?.diagnostics?.upstream_http_status ?? null,
        tool_calls_counted: res?.diagnostics?.tool_calls_counted ?? null,
        upstream_error: res?.error || null,
      },
    });
  }

  const text = extractTextFromXaiResponse(res.resp);
  const parsed = parseCanonicalJson(text);

  if (!parsed) {
    return buildFailureResult({
      fieldsToEnrich: requested,
      errorCode: "unparseable_json",
      elapsedMs,
      diagnostics: {
        upstream_status: res.diagnostics?.upstream_http_status ?? null,
        tool_calls_counted: res.diagnostics?.tool_calls_counted ?? null,
        unparseable_text_preview: asString(text).slice(0, 200),
      },
    });
  }

  const enriched = shapeEnrichedFromParsed(parsed);
  const { fields_completed, fields_failed, errors } = classifyFields(requested, enriched);

  // Fire the intermediate save callback for parity with runDirectEnrichment.
  // The handler's existing callback persists verified fields immediately,
  // so a worker killed before the function returns still preserves work.
  if (typeof onIntermediateSave === "function" && fields_completed.length > 0) {
    const verified = {};
    for (const f of fields_completed) {
      verified[f] = enriched[f];
    }
    // Always include source URLs and red_flag when we have verified fields,
    // so audit data lands in Cosmos alongside the values.
    if (enriched.location_source_urls) verified.location_source_urls = enriched.location_source_urls;
    verified.red_flag = enriched.red_flag;
    try {
      await onIntermediateSave(verified);
    } catch {
      // Non-fatal; the handler's logger will catch save failures separately.
    }
  }

  return {
    ok: fields_completed.length > 0,
    fields_completed,
    fields_failed,
    errors,
    enriched,
    elapsed_ms: elapsedMs,
    diagnostics: {
      canonical_call: true,
      guidance_version: PROMPT_GUIDANCE_VERSION,
      tool_calls_counted: res.diagnostics?.tool_calls_counted ?? null,
      upstream_status: res.diagnostics?.upstream_http_status ?? null,
      model,
    },
  };
}

module.exports = {
  runCanonicalImportCall,
  // Exported for tests.
  shapeEnrichedFromParsed,
  classifyFields,
  buildResponseFormat,
};
