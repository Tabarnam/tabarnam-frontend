// ── Extracted module: enrichment orchestration + editorial reviews ─────────────
// Pulled from index.js to reduce file size. Functions are copied verbatim.

const {
  validateCuratedReviewCandidate,
} = require("../_reviewQuality");

const { runDirectEnrichment, applyEnrichmentToCompany } = require("../_directEnrichment");
const { enqueueResumeRun } = require("../_enrichmentQueue");
const { upsertSession: upsertImportSession } = require("../_importSessionStore");
const { invokeResumeWorkerInProcess } = require("../import/resume-worker/handler");
const { buildInternalFetchRequest } = require("../_internalJobAuth");

// ── From extracted sibling modules ────────────────────────────────────────────
const {
  XAI_SYSTEM_PROMPT,
  extractXaiResponseText,
  AcceptedResponseError,
  postJsonWithTimeout,
  isAzureWebsitesUrl,
  toHostPathOnlyForLog,
} = require("./_importStartRequestUtils");

const {
  getCompaniesCosmosContainer,
  readItemWithPkCandidates,
  upsertItemWithPkCandidates,
  buildImportControlDocBase,
  upsertResumeDoc,
  logInfo,
  upsertCosmosImportSessionDoc,
} = require("./_importStartCosmos");

// Non-negotiable: every fresh seed must attempt these fields via xAI (resume-worker is authoritative).
const MANDATORY_ENRICH_FIELDS = [
  "tagline",
  "headquarters_location",
  "manufacturing_locations",
  "industries",
  "product_keywords",
  "reviews",
];

function buildReviewsUpstreamPayloadForImportStart({ reviewMessage, companyWebsiteHost } = {}) {
  const { buildSearchParameters } = require("../_buildSearchParameters");

  const searchBuild = buildSearchParameters({
    companyWebsiteHost,
    additionalExcludedHosts: [],
  });

  const role = typeof reviewMessage?.role === "string" ? reviewMessage.role.trim() : "";
  const contentRaw =
    typeof reviewMessage?.content === "string" ? reviewMessage.content : reviewMessage?.content == null ? "" : String(reviewMessage.content);

  const messageWithSpill = {
    ...(reviewMessage && typeof reviewMessage === "object" ? reviewMessage : { role: "user" }),
    role: role || "user",
    content: `${contentRaw.trim()}${searchBuild.prompt_exclusion_text || ""}`,
  };

  const reviewPayload = {
    model: "grok-4-latest",
    messages: [
      { role: "system", content: XAI_SYSTEM_PROMPT },
      messageWithSpill,
    ],
    search_parameters: searchBuild.search_parameters,
    temperature: 0.2,
    stream: false,
  };

  return { reviewPayload, searchBuild };
}

// Fetch editorial reviews for a company using XAI
async function fetchEditorialReviews(company, xaiUrl, xaiKey, timeout, debugCollector, stageCtx, warn) {
  const { extractJsonFromText, normalizeUpstreamReviewsResult } = require("../_curatedReviewsXai");
  const {
    normalizeHttpStatus,
    extractUpstreamRequestId,
    safeBodyPreview,
    redactReviewsUpstreamPayloadForLog,
    classifyUpstreamFailure,
    bumpUpstreamFailureBucket,
  } = require("../_upstreamReviewsDiagnostics");

  const companyName = String(company?.company_name || company?.name || "").trim();
  const websiteUrl = String(company?.website_url || company?.url || "").trim();

  const normalizeHttpUrlOrNull = (input) => {
    const raw = typeof input === "string" ? input.trim() : input == null ? "" : String(input).trim();
    if (!raw) return null;

    try {
      const u = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      u.hash = "";
      return u.toString();
    } catch {
      return null;
    }
  };

  const isDisallowedReviewSourceUrl = (url) => {
    const raw = typeof url === "string" ? url.trim() : "";
    if (!raw) return true;

    try {
      const u = new URL(raw);
      const host = String(u.hostname || "").toLowerCase().replace(/^www\./, "");

      // Amazon (disallowed)
      if (host === "amzn.to" || host.endsWith(".amzn.to")) return true;
      if (host === "amazon.com" || host.endsWith(".amazon.com")) return true;
      if (host.endsWith(".amazon") || host.includes("amazon.")) return true;

      // Google (disallowed) — but allow YouTube
      if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") return false;
      if (host === "g.co" || host.endsWith(".g.co") || host === "goo.gl" || host.endsWith(".goo.gl")) return true;
      if (host === "google.com" || host.endsWith(".google.com") || host.endsWith(".google")) return true;

      return false;
    } catch {
      return true;
    }
  };

  const inferSourceNameFromUrl = (url) => {
    const raw = typeof url === "string" ? url.trim() : "";
    if (!raw) return "";
    try {
      const u = new URL(raw);
      return String(u.hostname || "").replace(/^www\./i, "");
    } catch {
      return "";
    }
  };

  const getRemainingMs =
    stageCtx && typeof stageCtx.getRemainingMs === "function" ? stageCtx.getRemainingMs : null;
  const deadlineSafetyBufferMs =
    stageCtx && Number.isFinite(Number(stageCtx.deadlineSafetyBufferMs)) ? Number(stageCtx.deadlineSafetyBufferMs) : 0;
  const minValidationWindowMs = 9000;

  if (!companyName || !websiteUrl) {
    if (debugCollector) {
      debugCollector.push({
        company_name: companyName,
        website_url: websiteUrl,
        candidates: [],
        kept: 0,
        reason: "missing company_name or website_url",
      });
    }

    if (typeof warn === "function") {
      warn({
        stage: "reviews",
        root_cause: "client_bad_request",
        retryable: false,
        upstream_status: null,
        company_name: companyName,
        website_url: websiteUrl,
        message: "Missing company_name or website_url",
      });
    }

    const out = [];
    out._fetch_ok = false;
    out._fetch_error = "missing company_name or website_url";
    out._fetch_error_code = "MISSING_COMPANY_INPUT";
    out._stage_status = "client_bad_request";
    out._fetch_error_detail = {
      root_cause: "client_bad_request",
      message: "Missing company_name or website_url",
    };
    return out;
  }

  const debug = {
    company_name: companyName,
    website_url: websiteUrl,
    candidates: [],
    kept: 0,
  };

  const telemetry = {
    stage_status: "unknown",
    review_candidates_fetched_count: 0,
    review_candidates_considered_count: 0,
    review_candidates_rejected_count: 0,
    review_candidates_rejected_reasons: {
      disallowed_source: 0,
      self_domain: 0,
      duplicate_host_deferred: 0,
      link_not_found: 0,
      validation_timeout: 0,
      validation_brand_mismatch: 0,
      validation_fetch_blocked: 0,
      validation_error_other: 0,
      missing_fields: 0,
    },
    upstream_failure_buckets: {
      upstream_4xx: 0,
      upstream_5xx: 0,
      upstream_rate_limited: 0,
      upstream_unreachable: 0,
    },
    review_validated_count: 0,
    review_saved_count: 0,
    duplicate_host_used_as_fallback: false,
    time_budget_exhausted: false,
    upstream_status: null,
    upstream_error_code: null,
    upstream_error_message: null,
  };

  const incReason = (key) => {
    const k = String(key || "").trim();
    if (!k) return;
    if (!telemetry.review_candidates_rejected_reasons[k]) {
      telemetry.review_candidates_rejected_reasons[k] = 0;
    }
    telemetry.review_candidates_rejected_reasons[k] += 1;
    telemetry.review_candidates_rejected_count += 1;
  };

  const classifyValidationRejection = (v, errMessage) => {
    const linkStatus = String(v?.link_status || "").trim();
    const fetchStatus = Number.isFinite(Number(v?.fetch_status)) ? Number(v.fetch_status) : null;
    const reason = String(v?.reason_if_rejected || errMessage || "").toLowerCase();

    if (linkStatus === "not_found") return "link_not_found";
    if (fetchStatus === 403 || fetchStatus === 429) return "validation_fetch_blocked";

    if (reason.includes("timeout") || reason.includes("timed out") || reason.includes("abort")) return "validation_timeout";
    if (reason.includes("brand/company not mentioned") || reason.includes("not mentioned")) return "validation_brand_mismatch";

    // Many blocked cases don't include a fetch status; keep these separate from brand mismatches.
    if (linkStatus === "blocked" && (reason.includes("not accessible") || reason.includes("blocked"))) {
      return "validation_fetch_blocked";
    }

    return "validation_error_other";
  };

  const looksLikeReviewUrl = (u) => {
    const s = String(u || "").toLowerCase();
    return (
      s.includes("/review") ||
      s.includes("/reviews") ||
      s.includes("hands-on") ||
      s.includes("tested") ||
      s.includes("verdict")
    );
  };

  const isSameDomain = (a, b) => {
    const ah = String(a || "").toLowerCase().replace(/^www\./, "");
    const bh = String(b || "").toLowerCase().replace(/^www\./, "");
    if (!ah || !bh) return false;
    return ah === bh || ah.endsWith(`.${bh}`) || bh.endsWith(`.${ah}`);
  };

  try {
    const reviewMessage = {
      role: "user",
      content: `Find independent reviews about this company (or its products/services).

Company: ${companyName}
Website: ${websiteUrl}
Industries: ${Array.isArray(company.industries) ? company.industries.join(", ") : ""}

Return EXACTLY a single JSON object with this shape:
{
  "reviews": [ ... ],
  "next_offset": number,
  "exhausted": boolean
}

Rules:
- Return up to 10 review objects in "reviews".
  - We will validate and keep at most 2.
  - Provide extra candidates in case some links are broken (404/page not found) or disallowed.
  - Prefer different source domains (avoid duplicates when possible).
- Use offset=0.
- If there are no results, set exhausted=true and return reviews: [].
- Reviews MUST be independent (do NOT use the company website domain).
- Reviews MUST NOT be sourced from Amazon or Google.
  - Exclude amazon.* domains, amzn.to
  - Exclude google.* domains, g.co, goo.gl
  - YouTube is allowed.
- Strongly prefer magazines, YouTube, blogs, and X (Twitter) as review sources. Other sources (news sites, Facebook) are acceptable fallbacks only.
- Each review must be an object with keys:
  - source_name (string, optional)
  - source_url (string, REQUIRED) \u2014 direct link to the specific article/video/post
  - date (string, optional; prefer YYYY-MM-DD if known)
  - excerpt (string, REQUIRED) \u2014 short excerpt/quote (1-2 sentences)
- Output JSON only (no markdown).`,
    };

    const companyHostForSearch = inferSourceNameFromUrl(websiteUrl).toLowerCase().replace(/^www\./, "");

    const websiteHostForValidation = (() => {
      try {
        const u = new URL(websiteUrl);
        return String(u.hostname || "").trim();
      } catch {
        return "";
      }
    })();

    if (!websiteHostForValidation) {
      telemetry.upstream_error_code = "CLIENT_BAD_REQUEST";
      telemetry.upstream_error_message = "Invalid website_url (must be a valid URL with a hostname)";
      telemetry.stage_status = "client_bad_request";

      if (typeof warn === "function") {
        warn({
          stage: "reviews",
          root_cause: "client_bad_request",
          retryable: false,
          upstream_status: null,
          company_name: companyName,
          website_url: websiteUrl,
          message: telemetry.upstream_error_message,
        });
      }

      const out = [];
      out._fetch_ok = false;
      out._fetch_error = telemetry.upstream_error_message;
      out._fetch_error_code = telemetry.upstream_error_code;
      out._stage_status = telemetry.stage_status;
      out._telemetry = telemetry;
      out._fetch_error_detail = {
        root_cause: telemetry.stage_status,
        retryable: false,
        upstream_status: null,
      };
      return out;
    }

    const { reviewPayload, searchBuild } = buildReviewsUpstreamPayloadForImportStart({
      reviewMessage,
      companyWebsiteHost: companyHostForSearch,
    });

    if (searchBuild?.telemetry && typeof searchBuild.telemetry === "object") {
      telemetry.excluded_websites_original_count = searchBuild.telemetry.excluded_websites_original_count;
      telemetry.excluded_websites_used_count = searchBuild.telemetry.excluded_websites_used_count;
      telemetry.excluded_websites_truncated = searchBuild.telemetry.excluded_websites_truncated;
      telemetry.excluded_hosts_spilled_to_prompt_count = searchBuild.telemetry.excluded_hosts_spilled_to_prompt_count;
    }

    const payload_shape_for_log = redactReviewsUpstreamPayloadForLog(reviewPayload, searchBuild.telemetry);
    try {
      console.log(
        "[import-start][reviews_upstream_request] " +
          JSON.stringify({
            stage: "reviews",
            route: "import-start",
            upstream: toHostPathOnlyForLog(xaiUrl),
            payload_shape: payload_shape_for_log,
          })
      );
    } catch {
      // ignore
    }

    console.log(
      `[import-start] Fetching editorial reviews for ${companyName} (upstream=${toHostPathOnlyForLog(xaiUrl)})`
    );

    const response =
      stageCtx && typeof stageCtx.postXaiJsonWithBudget === "function"
        ? await stageCtx.postXaiJsonWithBudget({
            stageKey: "reviews",
            stageBeacon: "xai_reviews_fetch_start",
            body: JSON.stringify(reviewPayload),
            stageCapMsOverride: timeout,
          })
        : await postJsonWithTimeout(xaiUrl, {
            headers: (() => {
              const headers = {
                "Content-Type": "application/json",
              };

              if (isAzureWebsitesUrl(xaiUrl)) {
                headers["x-functions-key"] = xaiKey;
              } else {
                headers["Authorization"] = `Bearer ${xaiKey}`;
              }

              return headers;
            })(),
            body: JSON.stringify(reviewPayload),
            timeoutMs: timeout,
          });

    if (!(response.status >= 200 && response.status < 300)) {
      const upstream_status = normalizeHttpStatus(response.status);
      telemetry.upstream_status = upstream_status;
      telemetry.upstream_error_code = "UPSTREAM_HTTP_ERROR";
      telemetry.upstream_error_message = `Upstream HTTP ${response.status}`;

      const classification = classifyUpstreamFailure({ upstream_status });
      telemetry.stage_status = classification.stage_status;
      bumpUpstreamFailureBucket(telemetry, telemetry.stage_status);

      const xai_request_id = extractUpstreamRequestId(response.headers);
      const upstream_error_body = safeBodyPreview(response.data, { maxLen: 6000 });
      const payload_shape = redactReviewsUpstreamPayloadForLog(reviewPayload, searchBuild.telemetry);

      try {
        console.error(
          "[import-start][reviews_upstream_error] " +
            JSON.stringify({
              stage: "reviews",
              route: "import-start",
              root_cause: telemetry.stage_status,
              retryable: classification.retryable,
              upstream_status,
              xai_request_id,
              upstream_error_body,
              payload_shape,
            })
        );
      } catch {
        // ignore
      }

      console.warn(`[import-start] Failed to fetch reviews for ${companyName}: status ${response.status}`);
      if (debugCollector) debugCollector.push({ ...debug, reason: `xai_status_${response.status}` });

      if (typeof warn === "function") {
        warn({
          stage: "reviews",
          root_cause: telemetry.stage_status,
          retryable: classification.retryable,
          upstream_status,
          company_name: companyName,
          website_url: websiteUrl,
          message: `Upstream HTTP ${response.status}`,
          upstream_error_body,
          xai_request_id,
          payload_shape,
        });
      }

      const out = [];
      out._fetch_ok = false;
      out._fetch_error = `Upstream HTTP ${response.status}`;
      out._fetch_error_code = "REVIEWS_UPSTREAM_HTTP";
      out._stage_status = telemetry.stage_status;
      out._telemetry = telemetry;
      out._fetch_error_detail = {
        root_cause: telemetry.stage_status,
        retryable: classification.retryable,
        upstream_status,
        xai_request_id,
        upstream_error_body,
        payload_shape,
      };
      return out;
    }

    const responseText =
      extractXaiResponseText(response.data) ||
      response.data?.choices?.[0]?.text ||
      response.data?.output_text ||
      response.data?.text ||
      (typeof response.data === "string" ? response.data : response.data ? JSON.stringify(response.data) : "");

    console.log(`[import-start] Review response preview for ${companyName}: ${String(responseText).substring(0, 80)}...`);

    const parsedAny = extractJsonFromText(responseText);
    const normalized = normalizeUpstreamReviewsResult(parsedAny, { fallbackOffset: 0 });

    const parseError = normalized.parse_error;
    const upstreamReviews = Array.isArray(normalized.reviews) ? normalized.reviews : [];

    if (parseError) {
      console.warn(`[import-start] Failed to parse reviews for ${companyName}: ${parseError}`);

      if (typeof warn === "function") {
        warn({
          stage: "reviews",
          root_cause: "parse_error",
          retryable: true,
          upstream_status: null,
          company_name: companyName,
          website_url: websiteUrl,
          message: `Parse error: ${parseError}`,
        });
      }
    }

    const candidatesUpstream = upstreamReviews.filter((r) => r && typeof r === "object");
    const candidates = candidatesUpstream.slice(0, 10);
    const upstreamCandidateCount = candidatesUpstream.length;

    telemetry.review_candidates_fetched_count = upstreamCandidateCount;
    telemetry.review_candidates_considered_count = candidates.length;
    telemetry.stage_status = parseError ? "upstream_unreachable" : "ok";

    const nowIso = new Date().toISOString();
    const curated = [];
    const keptHosts = new Set();
    const deferredDuplicates = [];
    const companyHost = inferSourceNameFromUrl(websiteUrl).toLowerCase().replace(/^www\./, "");

    let rejectedCount = 0;

    const loopStart = Date.now();

    for (const r of candidates) {
      // Stay inside the overall handler budget; better to return 0–2 than time out.
      if (getRemainingMs && getRemainingMs() < deadlineSafetyBufferMs + minValidationWindowMs) {
        telemetry.time_budget_exhausted = true;
        telemetry.stage_status = "timed_out";
        break;
      }

      // Secondary guard for cases where we don't have a shared remaining-time tracker.
      if (!getRemainingMs && Date.now() - loopStart > Math.max(5000, timeout - 2000)) {
        telemetry.time_budget_exhausted = true;
        telemetry.stage_status = "timed_out";
        break;
      }
      const sourceUrlRaw = String(r?.source_url || r?.url || "").trim();
      const excerptRaw = String(r?.excerpt || r?.text || r?.abstract || r?.summary || "").trim();
      const titleRaw = String(r?.title || r?.headline || r?.headline_text || r?.name || "").trim();
      const sourceNameRaw = String(r?.source_name || r?.source || "").trim();
      const dateRaw = String(r?.date || "").trim();

      if (!sourceUrlRaw || !excerptRaw) {
        rejectedCount += 1;
        incReason("missing_fields");
        debug.candidates.push({
          url: sourceUrlRaw,
          title_raw: titleRaw,
          excerpt_preview: excerptRaw ? excerptRaw.slice(0, 200) : "",
          rejection_bucket: "missing_fields",
          link_status: "missing_fields",
          fetch_status: null,
          final_url: null,
          is_valid: false,
          matched_brand_terms: [],
          match_confidence: 0,
          evidence_snippets_count: 0,
          reason_if_rejected: "Missing source_url or excerpt",
        });
        continue;
      }

      const normalizedCandidateUrl = normalizeHttpUrlOrNull(sourceUrlRaw);
      if (!normalizedCandidateUrl || isDisallowedReviewSourceUrl(normalizedCandidateUrl)) {
        rejectedCount += 1;
        incReason("disallowed_source");
        debug.candidates.push({
          url: sourceUrlRaw,
          title_raw: titleRaw,
          excerpt_preview: excerptRaw ? excerptRaw.slice(0, 200) : "",
          rejection_bucket: "disallowed_source",
          link_status: "disallowed_url",
          fetch_status: null,
          final_url: null,
          is_valid: false,
          matched_brand_terms: [],
          match_confidence: 0,
          evidence_snippets_count: 0,
          reason_if_rejected: "Disallowed or invalid source_url",
        });
        continue;
      }

      if (stageCtx?.setStage) {
        stageCtx.setStage("validateReviews", {
          company_name: companyName,
          website_url: websiteUrl,
          normalized_domain: String(company?.normalized_domain || ""),
          review_url: normalizedCandidateUrl,
        });
      }

      const v = await validateCuratedReviewCandidate(
        {
          companyName,
          websiteUrl,
          normalizedDomain: company.normalized_domain || "",
          url: normalizedCandidateUrl,
          title: titleRaw,
          excerpt: excerptRaw,
        },
        { timeoutMs: 8000, maxBytes: 60000, maxSnippets: 2, minWords: 10, maxWords: 25 }
      ).catch((e) => ({
        is_valid: false,
        link_status: "blocked",
        final_url: null,
        matched_brand_terms: [],
        evidence_snippets: [],
        match_confidence: 0,
        last_checked_at: nowIso,
        reason_if_rejected: e?.message || "validation error",
      }));

      const evidenceCount = Array.isArray(v?.evidence_snippets) ? v.evidence_snippets.length : 0;
      const rejectionBucket = v?.is_valid === true ? null : classifyValidationRejection(v);

      debug.candidates.push({
        url: normalizedCandidateUrl,
        title_raw: titleRaw,
        excerpt_preview: excerptRaw ? excerptRaw.slice(0, 200) : "",
        rejection_bucket: rejectionBucket,
        link_status: v?.link_status,
        fetch_status: Number.isFinite(Number(v?.fetch_status)) ? Number(v.fetch_status) : null,
        final_url: v?.final_url,
        is_valid: Boolean(v?.is_valid),
        matched_brand_terms: v?.matched_brand_terms || [],
        match_confidence: v?.match_confidence,
        evidence_snippets_count: evidenceCount,
        reason_if_rejected: v?.reason_if_rejected,
      });

      // Only persist validated reviews.
      if (v?.is_valid !== true) {
        rejectedCount += 1;
        incReason(rejectionBucket || "validation_error_other");
        continue;
      }

      telemetry.review_validated_count += 1;

      const finalUrl = normalizeHttpUrlOrNull(v?.final_url || normalizedCandidateUrl) || normalizedCandidateUrl;
      if (isDisallowedReviewSourceUrl(finalUrl)) {
        rejectedCount += 1;
        incReason("disallowed_source");
        continue;
      }

      const reviewHost = inferSourceNameFromUrl(finalUrl).toLowerCase().replace(/^www\./, "");
      if (companyHost && reviewHost && isSameDomain(reviewHost, companyHost)) {
        rejectedCount += 1;
        incReason("self_domain");
        continue;
      }

      if (reviewHost && keptHosts.has(reviewHost)) {
        // Prefer unique sources, but don't fail the import if a company only has
        // one credible source with multiple relevant mentions.
        if (curated.length >= 1) {
          const sourceName = sourceNameRaw || inferSourceNameFromUrl(finalUrl) || "Unknown Source";
          rejectedCount += 1;
          incReason("duplicate_host_deferred");
          deferredDuplicates.push({
            id: `xai_auto_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.trunc(Math.random() * 1e6)}`,
            source_name: sourceName,
            source: sourceName,
            source_url: finalUrl,
            excerpt: excerptRaw,
            title_raw: titleRaw,
            date: dateRaw || null,
            created_at: nowIso,
            last_updated_at: nowIso,
            imported_via: "xai_import",
            show_to_users: true,
            is_public: true,
            _match_confidence: typeof v?.match_confidence === "number" ? v.match_confidence : null,
            _looks_like_review_url: looksLikeReviewUrl(finalUrl),
          });
          continue;
        }
      }

      const sourceName = sourceNameRaw || inferSourceNameFromUrl(finalUrl) || "Unknown Source";

      curated.push({
        id: `xai_auto_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.trunc(Math.random() * 1e6)}`,
        source_name: sourceName,
        source: sourceName,
        source_url: finalUrl,
        excerpt: excerptRaw,
        date: dateRaw || null,
        created_at: nowIso,
        last_updated_at: nowIso,
        imported_via: "xai_import",
        show_to_users: true,
        is_public: true,
      });

      if (reviewHost) keptHosts.add(reviewHost);
      if (curated.length >= 2) break;
    }

    if (curated.length < 2 && deferredDuplicates.length > 0) {
      const sorted = deferredDuplicates
        .slice()
        .sort((a, b) => {
          const aReview = a?._looks_like_review_url ? 1 : 0;
          const bReview = b?._looks_like_review_url ? 1 : 0;
          if (aReview !== bReview) return bReview - aReview;

          const aScore = typeof a?._match_confidence === "number" ? a._match_confidence : 0;
          const bScore = typeof b?._match_confidence === "number" ? b._match_confidence : 0;
          if (aScore !== bScore) return bScore - aScore;

          return 0;
        });

      const best = sorted[0];
      if (best) {
        const { _match_confidence, _looks_like_review_url, ...clean } = best;
        curated.push(clean);
        telemetry.duplicate_host_used_as_fallback = true;
      }
    }

    debug.kept = curated.length;

    telemetry.review_saved_count = curated.length;

    if (telemetry.stage_status === "unknown" || telemetry.stage_status === "ok") {
      telemetry.stage_status =
        curated.length === 0 && upstreamCandidateCount > 0 ? "no_valid_reviews_found" : "ok";
    }

    // Keep rejectedCount as the canonical, cheap-to-read number (telemetry holds the breakdown).
    telemetry.review_candidates_rejected_count = rejectedCount;

    console.log(
      "[import-start][reviews_telemetry] " +
        JSON.stringify({
          company_name: companyName,
          website_url: websiteUrl,
          stage_status: telemetry.stage_status,
          fetched: telemetry.review_candidates_fetched_count,
          considered: telemetry.review_candidates_considered_count,
          validated: telemetry.review_validated_count,
          saved: telemetry.review_saved_count,
          rejected: telemetry.review_candidates_rejected_count,
          rejected_reasons: telemetry.review_candidates_rejected_reasons,
          duplicate_host_used_as_fallback: telemetry.duplicate_host_used_as_fallback,
          time_budget_exhausted: telemetry.time_budget_exhausted,
          upstream_status: telemetry.upstream_status,

          excluded_websites_original_count: telemetry.excluded_websites_original_count,
          excluded_websites_used_count: telemetry.excluded_websites_used_count,
          excluded_websites_truncated: telemetry.excluded_websites_truncated,
          excluded_hosts_spilled_to_prompt_count: telemetry.excluded_hosts_spilled_to_prompt_count,
        })
    );

    console.log(
      `[import-start][reviews] company=${companyName} upstream_candidates=${upstreamCandidateCount} considered=${candidates.length} kept=${curated.length} rejected=${rejectedCount} parse_error=${parseError || ""}`
    );

    if (debugCollector) {
      debugCollector.push({ ...debug, telemetry });
    }

    curated._candidate_count = upstreamCandidateCount;
    curated._candidate_count_considered = candidates.length;
    curated._rejected_count = rejectedCount;

    curated._fetch_ok = !parseError;
    curated._fetch_error = parseError ? String(parseError) : null;
    curated._fetch_error_code = parseError ? "REVIEWS_PARSE_ERROR" : null;
    curated._stage_status = telemetry.stage_status;
    curated._telemetry = telemetry;

    // Keep per-candidate debug lightweight; mostly useful when saved_count=0.
    curated._candidates_debug = Array.isArray(debug.candidates) ? debug.candidates.slice(0, 10) : [];

    return curated;
  } catch (e) {
    if (e instanceof AcceptedResponseError) throw e;

    const upstream_status = normalizeHttpStatus(e?.status || e?.response?.status || null);
    const code = typeof e?.code === "string" && e.code.trim() ? e.code.trim() : "REVIEWS_EXCEPTION";

    telemetry.upstream_status = upstream_status;
    telemetry.upstream_error_code = code;
    telemetry.upstream_error_message = e?.message || String(e);

    const classification = classifyUpstreamFailure({ upstream_status, err_code: code });
    telemetry.stage_status = classification.stage_status;
    bumpUpstreamFailureBucket(telemetry, telemetry.stage_status);

    const xai_request_id = extractUpstreamRequestId(e?.response?.headers);
    const upstream_error_body = safeBodyPreview(e?.response?.data, { maxLen: 6000 });

    console.warn(`[import-start] Error fetching reviews for ${companyName}: ${telemetry.upstream_error_message}`);
    if (debugCollector) debugCollector.push({ ...debug, reason: e?.message || String(e) });

    if (typeof warn === "function") {
      warn({
        stage: "reviews",
        root_cause: telemetry.stage_status,
        retryable: classification.retryable,
        upstream_status,
        company_name: companyName,
        website_url: websiteUrl,
        message: telemetry.upstream_error_message,
        upstream_error_body,
        xai_request_id,
      });
    }

    const out = [];
    out._fetch_ok = false;
    out._fetch_error = telemetry.upstream_error_message;
    out._fetch_error_code = code;
    out._stage_status = telemetry.stage_status;
    out._telemetry = telemetry;
    out._fetch_error_detail = {
      root_cause: telemetry.stage_status,
      retryable: classification.retryable,
      upstream_status,
      xai_request_id,
      upstream_error_body,
    };
    return out;
  }
}


async function maybeQueueAndInvokeMandatoryEnrichment({
  sessionId,
  requestId,
  context,
  companyIds,
  companyDomainMap,
  reason,
  cosmosEnabled,
  fieldsToEnrich,
}) {
  if (!cosmosEnabled) return { queued: false, invoked: false, invocation_mode: null };

  const ids = Array.from(
    new Set(
      (Array.isArray(companyIds) ? companyIds : [])
        .map((v) => String(v || "").trim())
        .filter(Boolean)
        .slice(0, 50)
    )
  );
  if (ids.length === 0) return { queued: false, invoked: false, invocation_mode: null };

  const now = new Date().toISOString();

  // ── Queue-only enrichment (no inline xAI calls) ──
  // All enrichment is delegated to the resume-worker, which is triggered by
  // import-status polling or the safety-net queue enqueue.  This eliminates
  // the duplicate xAI calls that occurred when inline enrichment and the
  // resume-worker raced each other (2-3× cost per company).

  // Filter enrichment fields to user selection (if provided)
  const effectiveEnrichFields = Array.isArray(fieldsToEnrich)
    ? MANDATORY_ENRICH_FIELDS.filter((f) => fieldsToEnrich.includes(f))
    : [...MANDATORY_ENRICH_FIELDS];

  const missing_by_company = ids.map((company_id) => ({
    company_id,
    missing_fields: effectiveEnrichFields,
  }));

  // Write resume doc so the resume-worker knows what to process.
  // cycle_count intentionally omitted — upsertResumeDoc preserves the existing
  // value (defaults to 0 when no doc exists).
  console.log(`[import-start] upsertResumeDoc for session=${sessionId}: queued for resume-worker, fields_to_enrich=${fieldsToEnrich ? JSON.stringify(fieldsToEnrich) : "all"}`);
  await upsertResumeDoc({
    session_id: sessionId,
    status: "queued",
    missing_by_company,
    fields_to_enrich: fieldsToEnrich,  // persisted so resume-worker respects user selection
    created_at: now,
    updated_at: now,
    next_allowed_run_at: now,
    last_backoff_reason: null,
    last_backoff_ms: null,
    resume_error: null,
    blocked_at: null,
    lock_expires_at: null,
    invocation_mode: null,
  }).catch(() => null);

  // Update session doc + in-memory store so import-status polling triggers resume-worker.
  try {
    await upsertCosmosImportSessionDoc({ sessionId, requestId, patch: {
      stage_beacon: "enrichment_queued",
      enrichment_mode: "queued",
      resume_needed: true,
      resume_updated_at: now,
      saved: ids.length, saved_count: ids.length, saved_verified_count: ids.length,
      saved_company_ids_verified: [...ids], saved_company_ids: [...ids], saved_ids: [...ids],
      updated_at: now,
    }});
  } catch {}
  try {
    upsertImportSession({
      session_id: sessionId,
      request_id: requestId,
      status: "running",
      stage_beacon: "enrichment_queued",
      saved: ids.length, saved_count: ids.length, saved_verified_count: ids.length,
      saved_company_ids_verified: [...ids],
      resume_needed: true,
    });
  } catch {}

  // Enqueue resume-worker via Azure Storage Queue (short delay).
  // The primary trigger is import-status polling, but the queue message
  // acts as a backup in case polling is delayed.
  let queued = false;
  try {
    await enqueueResumeRun({
      session_id: sessionId,
      company_ids: ids,
      reason: reason || "enrichment_queued",
      requested_by: "import_start",
      run_after_ms: 5000, // 5-second delay
    });
    queued = true;
    console.log(`[import-start] session=${sessionId} resume-worker enqueued (5s delay, ${ids.length} companies)`);
  } catch (qErr) {
    console.warn(`[import-start] session=${sessionId} resume-worker enqueue failed: ${qErr?.message || qErr}`);
  }

  logInfo(context, {
    event: "enrichment_queued_for_resume_worker",
    session_id: sessionId,
    company_count: ids.length,
    queued,
    invocation_mode: "queued",
  });

  return {
    queued,
    enqueued: queued,
    invoked: false,
    invocation_mode: "queued",
  };
}

module.exports = {
  MANDATORY_ENRICH_FIELDS,
  buildReviewsUpstreamPayloadForImportStart,
  fetchEditorialReviews,
  maybeQueueAndInvokeMandatoryEnrichment,
};
