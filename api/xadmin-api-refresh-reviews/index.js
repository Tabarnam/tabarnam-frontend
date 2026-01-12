const { app, hasRoute } = require("../_app");
const { getBuildInfo } = require("../_buildInfo");
const {
  getValueAtPath,
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
} = require("../_cosmosPartitionKey");
const { getXAIEndpoint, getXAIKey, resolveXaiEndpointForModel } = require("../_shared");
const { checkUrlHealthAndFetchText } = require("../_reviewQuality");
const {
  extractUpstreamRequestId,
  extractContentType,
  buildUpstreamBodyDiagnostics,
  safeBodyPreview,
  redactReviewsUpstreamPayloadForLog,
  classifyUpstreamFailure,
} = require("../_upstreamReviewsDiagnostics");
const { buildSearchParameters } = require("../_buildSearchParameters");

let axios;
try {
  axios = require("axios");
} catch {
  axios = null;
}

let CosmosClient;
try {
  ({ CosmosClient } = require("@azure/cosmos"));
} catch {
  CosmosClient = null;
}

const crypto = require("crypto");

const BUILD_INFO = getBuildInfo();
const HANDLER_ID = "xadmin-api-refresh-reviews";
const VERSION_TAG = `ded-${HANDLER_ID}-${String(BUILD_INFO.build_id || "unknown").slice(0, 12)}`;

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeHttpStatus(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const code = Math.trunc(n);
  if (code >= 100 && code <= 599) return code;
  return null;
}

function jsonBody(obj) {
  return {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
      "X-Api-Handler": HANDLER_ID,
      "X-Api-Build-Id": String(BUILD_INFO.build_id || ""),
      "X-Api-Build-Source": String(BUILD_INFO.build_id_source || ""),
      "X-Api-Version": VERSION_TAG,
    },
    body: JSON.stringify(obj),
  };
}

function safeJsonParse(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readJsonBody(req) {
  if (!req) return {};

  if (typeof req.json === "function") {
    try {
      const val = await req.json();
      if (val && typeof val === "object") return val;
    } catch {}
  }

  if (req.body && typeof req.body === "object") return req.body;

  if (typeof req.body === "string" && req.body.trim()) {
    const parsed = safeJsonParse(req.body);
    if (parsed && typeof parsed === "object") return parsed;
  }

  const rawBody = req.rawBody;
  if (typeof rawBody === "string" && rawBody.trim()) {
    const parsed = safeJsonParse(rawBody);
    if (parsed && typeof parsed === "object") return parsed;
  }

  if (rawBody && (Buffer.isBuffer(rawBody) || rawBody instanceof Uint8Array)) {
    const parsed = safeJsonParse(Buffer.from(rawBody).toString("utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  }

  return {};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAzureWebsitesUrl(rawUrl) {
  const raw = asString(rawUrl).trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return /\.azurewebsites\.net$/i.test(String(u.hostname || ""));
  } catch {
    return false;
  }
}

function redactUrlQueryAndHash(rawUrl) {
  const s = asString(rawUrl).trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return s.split("?")[0].split("#")[0];
  }
}

function retryableForRootCause(root_cause) {
  const rc = asString(root_cause).trim();
  if (!rc) return true;

  // Per spec: upstream 4xx (except 429) should not be retryable by default.
  if (rc === "upstream_4xx") return false;
  if (rc === "client_bad_request") return false;

  return true;
}

function classifyError(err, { xai_base_url, xai_key } = {}) {
  if (err && typeof err === "object" && asString(err.root_cause).trim()) {
    return asString(err.root_cause).trim();
  }

  const msg = String(err?.message || err || "");
  const statusRaw = err?.status || err?.response?.status || 0;

  const base = asString(xai_base_url).trim();
  const key = asString(xai_key).trim();

  if (!base || !key) return "missing_env";

  const status = normalizeHttpStatus(statusRaw);

  const lower = msg.toLowerCase();
  if (lower.includes("parse")) return "parse_error";

  const failure = classifyUpstreamFailure({ upstream_status: status, err_code: err?.code });
  return failure.stage_status;
}

function reviewKey(r) {
  const base = [
    asString(r?.source_url || r?.url || ""),
    asString(r?.author || r?.reviewer || ""),
    r?.rating == null ? "" : String(r.rating),
    asString(r?.date || r?.created_at || ""),
    asString(r?.text || r?.body || r?.excerpt || r?.abstract || "").slice(0, 128),
  ].join("|");

  return crypto.createHash("sha1").update(base).digest("hex");
}

function dedupe(existing = [], incoming = []) {
  const seen = new Set(
    existing
      .filter((x) => x && typeof x === "object")
      .map((x) => asString(x._dedupe_key).trim() || reviewKey(x))
  );

  const out = [];
  for (const r of incoming) {
    if (!r || typeof r !== "object") continue;
    const k = asString(r._dedupe_key).trim() || reviewKey(r);
    if (seen.has(k)) continue;
    seen.add(k);

    const withIds = {
      ...r,
      id: asString(r.id).trim() || `xai_reviews_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`,
      _dedupe_key: k,
    };

    out.push(withIds);
  }

  return out;
}

function normalizeHttpUrlOrNull(input) {
  const raw = asString(input).trim();
  if (!raw) return null;

  try {
    const u = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function isDisallowedReviewSourceUrl(url) {
  const raw = asString(url).trim();
  if (!raw) return true;

  try {
    const u = new URL(raw);
    const host = asString(u.hostname).toLowerCase().replace(/^www\./, "");

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
}

function inferSourceNameFromUrl(url) {
  const raw = asString(url).trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return asString(u.hostname).replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function normalizeIncomingReview(r) {
  const obj = r && typeof r === "object" ? r : {};

  const urlRaw = asString(obj.source_url || obj.url).trim();
  const excerptRaw = asString(obj.excerpt || obj.text || obj.abstract || obj.summary).trim();
  const dateRaw = asString(obj.date).trim();
  const sourceNameRaw = asString(obj.source_name || obj.source).trim();

  // New rules: url + excerpt are mandatory.
  if (!urlRaw || !excerptRaw) return null;

  const source_url = normalizeHttpUrlOrNull(urlRaw);
  if (!source_url || isDisallowedReviewSourceUrl(source_url)) return null;

  const now = nowIso();
  const source_name = sourceNameRaw || inferSourceNameFromUrl(source_url) || "Unknown Source";

  return {
    source_name,
    source: source_name,
    source_url,
    url: source_url,
    excerpt: excerptRaw,
    abstract: excerptRaw,
    text: excerptRaw,
    date: dateRaw || null,
    created_at: now,
    last_updated_at: now,
    imported_via: "xai_reviews_refresh",
    show_to_users: true,
    is_public: true,
  };
}

function getCosmosEnv(k, fallback = "") {
  const v = process.env[k];
  return (v == null ? fallback : String(v)).trim();
}

function getCompaniesContainer() {
  const endpoint = getCosmosEnv("COSMOS_DB_ENDPOINT") || getCosmosEnv("COSMOS_ENDPOINT");
  const key = getCosmosEnv("COSMOS_DB_KEY") || getCosmosEnv("COSMOS_KEY");
  const database = getCosmosEnv("COSMOS_DB_DATABASE") || getCosmosEnv("COSMOS_DB") || "tabarnam-db";
  const containerName =
    getCosmosEnv("COSMOS_DB_COMPANIES_CONTAINER") || getCosmosEnv("COSMOS_CONTAINER") || "companies";

  if (!endpoint || !key) return null;
  if (!CosmosClient) return null;

  try {
    const client = new CosmosClient({ endpoint, key });
    return client.database(database).container(containerName);
  } catch {
    return null;
  }
}

let companiesPkPathPromise;
async function getCompaniesPartitionKeyPath(companiesContainer) {
  if (!companiesContainer) return "/normalized_domain";
  companiesPkPathPromise ||= getContainerPartitionKeyPath(companiesContainer, "/normalized_domain");
  try {
    return await companiesPkPathPromise;
  } catch {
    return "/normalized_domain";
  }
}

async function getCompanyById(companiesContainer, id) {
  const requestedId = asString(id).trim();
  if (!requestedId) throw new Error("Missing company_id");
  if (!companiesContainer) throw new Error("Cosmos not configured");

  const sql = `SELECT TOP 1 * FROM c WHERE (c.id = @id OR c.company_id = @id OR c.companyId = @id)\n               AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)\n               ORDER BY c._ts DESC`;

  const { resources } = await companiesContainer.items
    .query({ query: sql, parameters: [{ name: "@id", value: requestedId }] }, { enableCrossPartitionQuery: true })
    .fetchAll();

  const doc = Array.isArray(resources) && resources.length ? resources[0] : null;
  if (!doc) throw new Error(`Company not found (${requestedId})`);
  return doc;
}

async function patchCompanyById(companiesContainer, companyId, docForCandidates, patch) {
  const id = asString(companyId).trim();
  if (!id) throw new Error("Missing company id");
  if (!companiesContainer) throw new Error("Cosmos not configured");

  const containerPkPath = await getCompaniesPartitionKeyPath(companiesContainer);

  const candidates = buildPartitionKeyCandidates({
    doc: docForCandidates,
    containerPkPath,
    requestedId: id,
  });

  const ops = Object.keys(patch || {}).map((key) => ({ op: "set", path: `/${key}`, value: patch[key] }));

  let lastError;
  for (const pk of candidates) {
    try {
      const itemRef = companiesContainer.item(id, pk);
      await itemRef.patch(ops);
      return { ok: true, pk };
    } catch (e) {
      lastError = e;
    }
  }

  return { ok: false, error: asString(lastError?.message || lastError || "patch failed"), candidates };
}

function extractXaiConfig() {
  const model = "grok-4-latest";

  const rawBase = asString(process.env.XAI_BASE_URL).trim() || asString(getXAIEndpoint()).trim();
  const xai_key = asString(process.env.XAI_KEY).trim() || asString(getXAIKey()).trim();

  const xai_base_url = rawBase ? resolveXaiEndpointForModel(rawBase, model) : "";

  return { model, xai_base_url, xai_key };
}

function normalizeUpstreamResult(result) {
  const base = result && typeof result === "object" ? result : {};

  const reviews = Array.isArray(base.reviews) ? base.reviews : Array.isArray(base.items) ? base.items : [];

  const next_offset =
    typeof base.next_offset === "number"
      ? base.next_offset
      : typeof base.nextOffset === "number"
        ? base.nextOffset
        : null;

  const exhausted =
    typeof base.exhausted === "boolean"
      ? base.exhausted
      : typeof base.done === "boolean"
        ? base.done
        : null;

  return { reviews, next_offset, exhausted };
}

function extractJsonObjectFromText(text) {
  const { extractJsonFromText } = require("../_curatedReviewsXai");
  const parsed = extractJsonFromText(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  return null;
}

function buildReviewsUpstreamPayload({ company, offset, limit, model } = {}) {
  const companyName = asString(company?.company_name || company?.name).trim();
  const websiteUrl = asString(company?.website_url || company?.url).trim();

  const cappedLimit = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 3)));
  const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));

  const messages = [
    {
      role: "system",
      content:
        "You are a research assistant. Always respond with valid JSON only; no markdown, no prose. Do not wrap in backticks.",
    },
    {
      role: "user",
      content: `Find independent reviews about this company (or its products/services).\n\nCompany: ${companyName}\nWebsite: ${websiteUrl}\n\nReturn EXACTLY a single JSON object with this shape:\n{\n  \\\"reviews\\\": [ ... ],\n  \\\"next_offset\\\": number,\n  \\\"exhausted\\\": boolean\n}\n\nRules:\n- Return at most ${cappedLimit} review objects in \\\"reviews\\\".\n- Use \\\"offset\\\"=${safeOffset} to skip that many results from your internal ranking list so subsequent calls can page forward.\n- If there are no more results, set exhausted=true and return reviews: [].\n- Reviews MUST NOT be sourced from Amazon or Google.\n  - Exclude amazon.* domains, amzn.to\n  - Exclude google.* domains, g.co, goo.gl\n  - YouTube is allowed.\n- Prefer magazines, blogs, news sites, YouTube, X (Twitter), and Facebook posts/pages.\n- Each review must be an object with keys:\n  - source_name (string, optional)\n  - source_url (string, REQUIRED) — direct link to the specific article/video/post\n  - date (string, optional; prefer YYYY-MM-DD if known)\n  - excerpt (string, REQUIRED) — short excerpt/quote (1-2 sentences)\n- Output JSON only (no markdown).`,
    },
  ];

  const companyHost = (() => {
    try {
      const u = new URL(websiteUrl);
      return String(u.hostname || "").toLowerCase().replace(/^www\./, "");
    } catch {
      return "";
    }
  })();

  const searchBuild = buildSearchParameters({
    companyWebsiteHost: companyHost,
    additionalExcludedHosts: [],
  });

  const messagesWithSpill = messages.map((m, idx) => {
    if (idx !== 1) return m;
    return {
      ...m,
      content: `${asString(m?.content).trim()}${searchBuild.prompt_exclusion_text || ""}`,
    };
  });

  const payload = {
    model: asString(model).trim() || null,
    messages: messagesWithSpill,
    search_parameters: searchBuild.search_parameters,
    temperature: 0.2,
    stream: false,
  };

  return { payload, searchBuild };
}

async function fetchReviewsFromUpstream({ company, offset, limit, timeout_ms }) {
  const { model, xai_base_url, xai_key } = extractXaiConfig();

  if (!axios) {
    const err = new Error("Missing axios dependency");
    err.status = 0;
    throw err;
  }

  if (!xai_base_url || !xai_key) {
    const err = new Error("Missing XAI configuration");
    err.status = 0;
    throw err;
  }

  const companyName = asString(company?.company_name || company?.name).trim();
  const websiteUrl = asString(company?.website_url || company?.url).trim();

  if (!companyName) {
    const err = new Error("Missing company name");
    err.status = 0;
    err.root_cause = "client_bad_request";
    throw err;
  }

  const websiteHost = (() => {
    try {
      const u = new URL(websiteUrl);
      return asString(u.hostname).trim();
    } catch {
      return "";
    }
  })();

  if (!websiteHost) {
    const err = new Error("Invalid website_url (must be a valid URL with a hostname)");
    err.status = 0;
    err.root_cause = "client_bad_request";
    throw err;
  }

  const messages = [
    {
      role: "system",
      content:
        "You are a research assistant. Always respond with valid JSON only; no markdown, no prose. Do not wrap in backticks.",
    },
    {
      role: "user",
      content: `Find independent reviews about this company (or its products/services).\n\nCompany: ${companyName}\nWebsite: ${websiteUrl}\n\nReturn EXACTLY a single JSON object with this shape:\n{\n  \"reviews\": [ ... ],\n  \"next_offset\": number,\n  \"exhausted\": boolean\n}\n\nRules:\n- Return at most ${Math.max(1, Math.min(50, Math.trunc(Number(limit) || 3)))} review objects in \"reviews\".\n- Use \"offset\"=${Math.max(0, Math.trunc(Number(offset) || 0))} to skip that many results from your internal ranking list so subsequent calls can page forward.\n- If there are no more results, set exhausted=true and return reviews: [].\n- Reviews MUST NOT be sourced from Amazon or Google.\n  - Exclude amazon.* domains, amzn.to\n  - Exclude google.* domains, g.co, goo.gl\n  - YouTube is allowed.\n- Prefer magazines, blogs, news sites, YouTube, X (Twitter), and Facebook posts/pages.\n- Each review must be an object with keys:\n  - source_name (string, optional)\n  - source_url (string, REQUIRED) — direct link to the specific article/video/post\n  - date (string, optional; prefer YYYY-MM-DD if known)\n  - excerpt (string, REQUIRED) — short excerpt/quote (1-2 sentences)\n- Output JSON only (no markdown).`,
    },
  ];

  const companyHost = (() => {
    try {
      const u = new URL(websiteUrl);
      return String(u.hostname || "").toLowerCase().replace(/^www\./, "");
    } catch {
      return "";
    }
  })();

  const searchBuild = buildSearchParameters({
    companyWebsiteHost: companyHost,
    additionalExcludedHosts: [],
  });

  const messagesWithSpill = messages.map((m, idx) => {
    if (idx !== 1) return m;
    return {
      ...m,
      content: `${asString(m?.content).trim()}${searchBuild.prompt_exclusion_text || ""}`,
    };
  });

  const payload = {
    model,
    messages: messagesWithSpill,
    search_parameters: searchBuild.search_parameters,
    temperature: 0.2,
    stream: false,
  };

  const payload_shape_for_log = redactReviewsUpstreamPayloadForLog(payload, searchBuild.telemetry);
  try {
    console.log(
      JSON.stringify({
        stage: "reviews_refresh",
        route: "xadmin-api-refresh-reviews",
        kind: "upstream_request",
        upstream: xai_base_url,
        payload_shape: payload_shape_for_log,
      })
    );
  } catch {
    // ignore
  }

  const controller = new AbortController();
  const timeout = Math.max(5000, Math.min(120000, Math.trunc(Number(timeout_ms) || 65000)));
  const timeoutHandle = setTimeout(() => controller.abort(), timeout);

  try {
    const headers = {
      "Content-Type": "application/json",
    };

    if (isAzureWebsitesUrl(xai_base_url)) {
      headers["x-functions-key"] = xai_key;
    } else {
      headers["Authorization"] = `Bearer ${xai_key}`;
    }

    const resp = await axios.post(xai_base_url, payload, {
      headers,
      timeout,
      signal: controller.signal,
      validateStatus: () => true,
    });

    const status = Number(resp?.status) || 0;
    const upstream_url_redacted = redactUrlQueryAndHash(xai_base_url) || xai_base_url;
    const xai_request_id = extractUpstreamRequestId(resp?.headers);

    const diag = buildUpstreamBodyDiagnostics(resp?.data, resp?.headers, { maxLen: 4096 });
    const content_type = diag.content_type || extractContentType(resp?.headers);

    // When upstream is non-2xx, capture a safe preview of the body and surface it for diagnostics.
    if (!(status >= 200 && status < 300)) {
      const upstream_status = normalizeHttpStatus(status);

      const failure = classifyUpstreamFailure({ upstream_status });

      const err = new Error(`Upstream HTTP ${status}`);
      err.status = status;
      err.response = resp;
      err.root_cause = failure.stage_status;
      err.retryable = failure.retryable;
      err.xai_request_id = xai_request_id;
      err.upstream_url = upstream_url_redacted;
      err.auth_header_present = Boolean(xai_key);
      err.content_type = content_type;
      err.raw_body_kind = diag.raw_body_kind;
      err.raw_body_preview = diag.raw_body_preview;
      err.upstream_error_body = {
        content_type,
        raw_body_kind: diag.raw_body_kind,
        preview: diag.raw_body_preview,
      };
      err.payload_shape = payload_shape_for_log;
      err.exclusion_telemetry = searchBuild.telemetry;
      throw err;
    }

    const responseText =
      resp?.data?.choices?.[0]?.message?.content ||
      (typeof resp?.data === "string" ? resp.data : resp?.data ? JSON.stringify(resp.data) : "");

    const { normalizeUpstreamReviewsResult } = require("../_curatedReviewsXai");

    const parsed = extractJsonObjectFromText(responseText);
    const normalized = normalizeUpstreamReviewsResult(parsed, {
      fallbackOffset: Math.max(0, Math.trunc(Number(offset) || 0)),
    });

    if (normalized.parse_error) {
      // This is *not* a validation issue; upstream returned something we couldn't parse.
      // Capture a small raw preview so we can distinguish HTML error pages vs. JSON-ish junk.
      const retryable =
        status >= 500 ||
        diag.raw_body_kind === "empty" ||
        diag.raw_body_kind === "json_invalid" ||
        (diag.raw_body_kind === "html" && status >= 500);

      const err = new Error("Upstream returned non-JSON (or invalid JSON) response");
      err.status = status;
      err.response = resp;
      err.root_cause = "bad_response_not_json";
      err.retryable = retryable;
      err.xai_request_id = xai_request_id;
      err.upstream_url = upstream_url_redacted;
      err.auth_header_present = Boolean(xai_key);
      err.content_type = content_type;
      err.raw_body_kind = diag.raw_body_kind;
      err.raw_body_preview = diag.raw_body_preview;
      err.upstream_error_body = {
        content_type,
        raw_body_kind: diag.raw_body_kind,
        preview: diag.raw_body_preview,
      };
      err.payload_shape = payload_shape_for_log;
      err.exclusion_telemetry = searchBuild.telemetry;
      throw err;
    }

    return {
      reviews: Array.isArray(normalized.reviews) ? normalized.reviews : [],
      next_offset:
        typeof normalized.next_offset === "number" && Number.isFinite(normalized.next_offset)
          ? normalized.next_offset
          : Math.max(0, Math.trunc(Number(offset) || 0)) + (Array.isArray(normalized.reviews) ? normalized.reviews.length : 0),
      exhausted:
        typeof normalized.exhausted === "boolean"
          ? normalized.exhausted
          : Array.isArray(normalized.reviews)
            ? normalized.reviews.length === 0
            : true,
      _meta: {
        upstream_status: status,
        ...(searchBuild?.telemetry && typeof searchBuild.telemetry === "object" ? searchBuild.telemetry : {}),
      },
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function handler(req, context) {
  const method = String(req?.method || "GET").toUpperCase();

  const build_id = String(BUILD_INFO.build_id || "");

  function respond(payload) {
    const base = payload && typeof payload === "object" ? payload : {};

    const out = {
      stage: "reviews_refresh",
      warnings: [],
      build_id,
      version_tag: VERSION_TAG,
      ...base,
    };

    out.warnings = Array.isArray(out.warnings) ? out.warnings : [];

    out.fetched_count = Number(out.fetched_count ?? 0) || 0;
    out.saved_count = Number(out.saved_count ?? 0) || 0;

    const upstream_status_raw = out.upstream_status;
    out.upstream_status = normalizeHttpStatus(out.upstream_status);

    if (out.ok === true) {
      if (typeof out.retryable !== "boolean") out.retryable = false;
      if (out.root_cause == null) out.root_cause = "";
    } else {
      out.ok = false;
      out.root_cause = asString(out.root_cause).trim() || "unknown";
      if (typeof out.retryable !== "boolean") out.retryable = retryableForRootCause(out.root_cause);

      if (out.upstream_status == null && out.root_cause === "upstream_http_0") {
        out.root_cause = "upstream_unreachable";
      }
    }

    // Final contract enforcement (must be last)
    const noResults = Number(out.saved_count || 0) === 0 && Number(out.fetched_count || 0) === 0;

    const isHttp0 = upstream_status_raw === 0 || upstream_status_raw === "0" || upstream_status_raw === "HTTP 0";

    // Contract: it must be impossible to return ok:true with fetched_count=0 and saved_count=0.
    // (Exclude OPTIONS for CORS preflight.)
    if (method !== "OPTIONS" && out.ok === true && noResults) {
      out.ok = false;
      out.retryable = true;
      out.root_cause = "upstream_unreachable";
      out.upstream_status = null;
    }

    if (method !== "OPTIONS" && (isHttp0 || out.root_cause === "upstream_http_0")) {
      out.ok = false;
      out.retryable = true;
      out.root_cause = "upstream_unreachable";
      out.upstream_status = null;
    }

    // Never allow retryable:false when root_cause is upstream_unreachable.
    if (method !== "OPTIONS" && out.root_cause === "upstream_unreachable") {
      out.retryable = true;
    }

    // TEMP: one-line log of the final payload after enforcement.
    try {
      console.log(
        JSON.stringify({
          stage: "reviews_refresh",
          route: "xadmin-api-refresh-reviews",
          kind: "final_payload",
          payload: out,
        })
      );
    } catch {
      // ignore
    }

    return jsonBody(out);
  }

  if (method === "OPTIONS") {
    return respond({ ok: true, company_id: "" });
  }

  // One-line marker log for prod log search.
  try {
    console.log(
      JSON.stringify({
        stage: "reviews_refresh",
        route: "xadmin-api-refresh-reviews",
        kind: "request_start",
        method,
        build_id: BUILD_INFO.build_id || null,
        version_tag: VERSION_TAG,
      })
    );
  } catch {
    // ignore
  }


  try {
    const body = await readJsonBody(req);
    const company_id = asString(body?.company_id).trim();
    // New rule: we keep at most 2 curated reviews per company.
    const requestedTake = Math.max(1, Math.min(2, Math.trunc(Number(body?.take ?? body?.limit ?? 2) || 2)));

    if (!company_id) {
      return respond({
        ok: false,
        stage: "reviews_refresh",
        root_cause: "client_bad_request",
        upstream_status: null,
        retryable: false,
        message: "Missing company_id",
        build_id,
        version_tag: VERSION_TAG,
      });
    }

    const companiesContainer = getCompaniesContainer();
    if (!companiesContainer) {
      return respond({
        ok: false,
        stage: "reviews_refresh",
        root_cause: "missing_env",
        upstream_status: null,
        retryable: true,
        message: "Cosmos not configured",
        build_id,
        version_tag: VERSION_TAG,
      });
    }

    let company;
    try {
      company = await getCompanyById(companiesContainer, company_id);
    } catch (e) {
      return respond({
        ok: false,
        stage: "reviews_refresh",
        root_cause: "cosmos_read_error",
        upstream_status: null,
        retryable: true,
        message: asString(e?.message || e),
        build_id,
        version_tag: VERSION_TAG,
      });
    }

    const cursor =
      company.review_cursor && typeof company.review_cursor === "object"
        ? { ...company.review_cursor }
        : {
            source: "xai_reviews",
            last_offset: 0,
            total_fetched: 0,
            exhausted: false,
          };

    // If exhausted, return fast success (idempotent)
    if (cursor.exhausted) {
      return respond({
        ok: true,
        stage: "reviews_refresh",
        company_id,
        fetched_count: 0,
        saved_count: 0,
        exhausted: true,
        warnings: [],
        build_id,
        version_tag: VERSION_TAG,
      });
    }

    // Per-company serialized lock (best-effort)
    const nowMs = Date.now();
    const lockUntilExisting = Number(company.reviews_fetch_lock_until || 0) || 0;
    if (lockUntilExisting > nowMs) {
      return respond({
        ok: false,
        stage: "reviews_refresh",
        company_id,
        root_cause: "locked",
        upstream_status: null,
        retryable: true,
        message: "Reviews refresh already in progress",
        build_id,
        version_tag: VERSION_TAG,
      });
    }

    try {
      const lockUntil = nowMs + 60000;
      cursor.last_attempt_at = nowIso();

      await patchCompanyById(companiesContainer, company_id, company, {
        reviews_fetch_lock_key: `reviews_fetch_lock::${company_id}`,
        reviews_fetch_lock_until: lockUntil,
        review_cursor: cursor,
      });
    } catch {
      // Do not fail; just proceed.
    }

    const backoffs = [0, 2000, 5000, 10000];

    let saved_count_total = 0;
    let fetched_count_total = 0;
    const warnings = [];
    let lastErr = null;

    for (let i = 0; i < backoffs.length; i += 1) {
      if (backoffs[i]) await sleep(backoffs[i]);

      try {
        const offset = Math.max(0, Math.trunc(Number(cursor.last_offset) || 0));

        const upstream = await fetchReviewsFromUpstream({
          company,
          offset,
          limit: requestedTake,
          timeout_ms: 65000,
        });

        const incomingRaw = Array.isArray(upstream?.reviews) ? upstream.reviews : [];
        const incomingNormalized = incomingRaw.map(normalizeIncomingReview).filter(Boolean);

        // Filter out review URLs that are clearly dead (404/page not found).
        // Note: We allow "blocked" (403/429/etc) because those often work in a real browser.
        const incoming = [];
        for (const r of incomingNormalized) {
          try {
            const health = await checkUrlHealthAndFetchText(r.source_url, { timeoutMs: 4000, maxBytes: 30000 });
            if (health?.link_status === "not_found") {
              warnings.push({
                stage: "reviews_refresh",
                root_cause: "review_url_not_found",
                upstream_status: null,
                message: `Rejected review URL (page not found): ${asString(r.source_url).slice(0, 200)}`,
              });
              continue;
            }

            const finalUrl = normalizeHttpUrlOrNull(health?.final_url || r.source_url) || r.source_url;
            incoming.push({
              ...r,
              source_url: finalUrl,
              url: finalUrl,
            });
          } catch (e) {
            // If validation fails unexpectedly, keep the review rather than failing the refresh.
            incoming.push(r);
          }
        }

        fetched_count_total += incoming.length;

        const existing = Array.isArray(company.curated_reviews) ? company.curated_reviews : [];
        const toAdd = dedupe(existing, incoming);

        const updatedCurated = toAdd.length ? existing.concat(toAdd) : existing;

        saved_count_total += toAdd.length;

        const nextOffset =
          typeof upstream?.next_offset === "number" && Number.isFinite(upstream.next_offset)
            ? upstream.next_offset
            : offset + incomingNormalized.length;

        cursor.source = "xai_reviews";
        cursor.last_offset = nextOffset;

        // Keep cursor.total_fetched aligned with "saved reviews" (not just upstream candidates).
        cursor.total_fetched = Math.max(0, Math.trunc(Number(cursor.total_fetched) || 0)) + toAdd.length;

        // Only update last_success_at when we actually saved at least 1 new review.
        if (toAdd.length > 0) {
          cursor.last_success_at = nowIso();
        }

        cursor.last_attempt_at = nowIso();
        cursor.last_error = null;
        cursor.reviews_stage_status = "ok";

        const upstreamMeta = upstream?._meta && typeof upstream._meta === "object" ? upstream._meta : {};

        cursor.reviews_telemetry = {
          stage_status: "ok",
          upstream_status: normalizeHttpStatus(upstreamMeta?.upstream_status),
          upstream_failure_buckets: {
            upstream_4xx: 0,
            upstream_5xx: 0,
            upstream_rate_limited: 0,
            upstream_unreachable: 0,
          },

          excluded_websites_original_count:
            typeof upstreamMeta?.excluded_websites_original_count === "number" ? upstreamMeta.excluded_websites_original_count : null,
          excluded_websites_used_count:
            typeof upstreamMeta?.excluded_websites_used_count === "number" ? upstreamMeta.excluded_websites_used_count : null,
          excluded_websites_truncated:
            typeof upstreamMeta?.excluded_websites_truncated === "boolean" ? upstreamMeta.excluded_websites_truncated : null,
          excluded_hosts_spilled_to_prompt_count:
            typeof upstreamMeta?.excluded_hosts_spilled_to_prompt_count === "number" ? upstreamMeta.excluded_hosts_spilled_to_prompt_count : null,
        };
        cursor.exhausted = Boolean(upstream?.exhausted) || incoming.length === 0;

        const patchRes = await patchCompanyById(companiesContainer, company_id, company, {
          curated_reviews: updatedCurated,
          review_cursor: cursor,
          reviews_fetch_lock_until: 0,
        });

        if (!patchRes.ok) {
          const err = new Error(asString(patchRes.error) || "Cosmos patch failed");
          err.status = 0;
          throw err;
        }

        // Keep local model in sync for subsequent steps.
        company = {
          ...company,
          curated_reviews: updatedCurated,
          review_cursor: cursor,
          reviews_fetch_lock_until: 0,
        };

        return respond({
          ok: true,
          stage: "reviews_refresh",
          company_id,
          fetched_count: fetched_count_total,
          saved_count: saved_count_total,
          exhausted: Boolean(cursor.exhausted),
          warnings,
          reviews: toAdd,
          build_id,
          version_tag: VERSION_TAG,
        });
      } catch (err) {
        lastErr = err;

        const { xai_base_url, xai_key } = extractXaiConfig();
        const upstream_status_raw = err?.status || err?.response?.status || 0;
        const upstream_status = normalizeHttpStatus(upstream_status_raw);
        const root_cause = classifyError(err, { xai_base_url, xai_key });

        const normalized_root_cause = asString(root_cause).trim() || "unknown";
        const retryable = typeof err?.retryable === "boolean" ? err.retryable : retryableForRootCause(normalized_root_cause);

        const attempts_count = i + 1;
        const retry_exhausted = attempts_count >= backoffs.length;

        const xai_request_id = asString(err?.xai_request_id).trim() || extractUpstreamRequestId(err?.response?.headers);

        const bodyDiag =
          err?.raw_body_preview != null || err?.raw_body_kind != null || err?.content_type != null
            ? {
                content_type: asString(err?.content_type).trim() || null,
                raw_body_kind: asString(err?.raw_body_kind).trim() || null,
                raw_body_preview: asString(err?.raw_body_preview) || null,
              }
            : buildUpstreamBodyDiagnostics(err?.response?.data, err?.response?.headers, { maxLen: 4096 });

        const upstream_error_body =
          err?.upstream_error_body && typeof err.upstream_error_body === "object"
            ? err.upstream_error_body
            : bodyDiag.raw_body_preview
              ? {
                  content_type: bodyDiag.content_type,
                  raw_body_kind: bodyDiag.raw_body_kind,
                  preview: bodyDiag.raw_body_preview,
                }
              : safeBodyPreview(err?.response?.data, { maxLen: 6000 });

        const payload_shape = err?.payload_shape || null;
        const upstream_url = asString(err?.upstream_url).trim() || redactUrlQueryAndHash(xai_base_url) || null;
        const auth_header_present =
          typeof err?.auth_header_present === "boolean" ? err.auth_header_present : Boolean(asString(xai_key).trim());

        try {
          console.error(
            JSON.stringify({
              stage: "reviews_refresh",
              route: "xadmin-api-refresh-reviews",
              kind: "upstream_error",
              root_cause: normalized_root_cause,
              retryable,
              upstream_status,
              xai_request_id,
              upstream_url,
              auth_header_present,
              attempts_count,
              retry_exhausted,
              upstream_error_body,
              payload_shape,
              message: asString(err?.message || err),
            })
          );
        } catch {
          // ignore
        }

        warnings.push({
          stage: "reviews_refresh",
          root_cause: normalized_root_cause,
          upstream_status,
          retryable,
          xai_request_id: xai_request_id || null,
          upstream_url,
          auth_header_present,
          attempts_count,
          retry_exhausted,
          upstream_error_body,
          payload_shape,
          message: asString(err?.message || err),
        });

        // Persist cursor last_error telemetry (best-effort)
        try {
          cursor.last_attempt_at = nowIso();
          cursor.last_error = {
            root_cause: normalized_root_cause,
            upstream_status,
            retryable,
            attempts_count,
            retry_exhausted,
            upstream_url,
            auth_header_present,
            xai_request_id: xai_request_id || null,

            // Keep explicit non-JSON diagnostics small and stable for storage.
            content_type: bodyDiag.content_type || null,
            raw_body_kind: bodyDiag.raw_body_kind || null,
            raw_body_preview: bodyDiag.raw_body_preview || null,

            upstream_error_body,
            payload_shape,
            message: asString(err?.message || err),
          };
          cursor.reviews_stage_status = normalized_root_cause;

          const exclusionTelemetry =
            err?.exclusion_telemetry && typeof err.exclusion_telemetry === "object" ? err.exclusion_telemetry : {};

          cursor.reviews_telemetry = {
            stage_status: normalized_root_cause,
            upstream_status,
            upstream_failure_buckets: {
              upstream_4xx: normalized_root_cause === "upstream_4xx" ? 1 : 0,
              upstream_5xx: normalized_root_cause === "upstream_5xx" ? 1 : 0,
              upstream_rate_limited: normalized_root_cause === "upstream_rate_limited" ? 1 : 0,
              upstream_unreachable: normalized_root_cause === "upstream_unreachable" ? 1 : 0,
            },

            excluded_websites_original_count:
              typeof exclusionTelemetry?.excluded_websites_original_count === "number"
                ? exclusionTelemetry.excluded_websites_original_count
                : null,
            excluded_websites_used_count:
              typeof exclusionTelemetry?.excluded_websites_used_count === "number" ? exclusionTelemetry.excluded_websites_used_count : null,
            excluded_websites_truncated:
              typeof exclusionTelemetry?.excluded_websites_truncated === "boolean" ? exclusionTelemetry.excluded_websites_truncated : null,
            excluded_hosts_spilled_to_prompt_count:
              typeof exclusionTelemetry?.excluded_hosts_spilled_to_prompt_count === "number"
                ? exclusionTelemetry.excluded_hosts_spilled_to_prompt_count
                : null,
          };
          await patchCompanyById(companiesContainer, company_id, company, { review_cursor: cursor });
        } catch {
          // ignore
        }

        continue;
      }
    }

    // Final failure: still JSON, still 200
    const ok = saved_count_total > 0;

    try {
      await patchCompanyById(companiesContainer, company_id, company, {
        reviews_fetch_lock_until: 0,
      });
    } catch {
      // ignore
    }

    if (ok) {
      return respond({
        ok: true,
        stage: "reviews_refresh",
        company_id,
        fetched_count: fetched_count_total,
        saved_count: saved_count_total,
        warnings,
        message: "Saved with warnings",
        build_id,
        version_tag: VERSION_TAG,
      });
    }

    const { xai_base_url, xai_key } = extractXaiConfig();

    const upstream_status_raw = lastErr?.status || lastErr?.response?.status || 0;
    const upstream_status = normalizeHttpStatus(upstream_status_raw);
    const root_cause_raw = classifyError(lastErr, { xai_base_url, xai_key });
    const root_cause = asString(root_cause_raw).trim() || "unknown";

    return respond({
      ok: false,
      stage: "reviews_refresh",
      company_id,
      root_cause,
      upstream_status,
      retryable: retryableForRootCause(root_cause),
      message: asString(lastErr?.message || lastErr || "Backend call failure"),
      warnings,
      build_id,
      version_tag: VERSION_TAG,
    });
  } catch (e) {
    const message = asString(e?.message || e) || "Unhandled error";

    try {
      console.error(
        JSON.stringify({
          stage: "reviews_refresh",
          route: "xadmin-api-refresh-reviews",
          kind: "unhandled_exception",
          message,
          build_id: BUILD_INFO.build_id || null,
          version_tag: VERSION_TAG,
        })
      );
    } catch {
      // ignore
    }

    // Critical requirement: still JSON and still 200
    return respond({
      ok: false,
      stage: "reviews_refresh",
      root_cause: "unhandled_exception",
      upstream_status: null,
      retryable: true,
      message,
      build_id,
      version_tag: VERSION_TAG,
    });
  }
}

app.http("xadminApiRefreshReviews", {
  route: "xadmin-api-refresh-reviews",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler,
});

// Production safety: if a deployment accidentally omits admin-refresh-reviews,
// this alias keeps /api/admin-refresh-reviews available.
if (!hasRoute("admin-refresh-reviews")) {
  app.http("adminRefreshReviewsAlias", {
    route: "admin-refresh-reviews",
    methods: ["GET", "POST", "OPTIONS"],
    authLevel: "anonymous",
    handler,
  });
}

module.exports._test = {
  handler,
  _internals: {
    dedupe,
    reviewKey,
    classifyError,
    extractJsonObjectFromText,
    normalizeUpstreamResult,
    getValueAtPath,
    buildReviewsUpstreamPayload,
  },
};
