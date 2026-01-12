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

const { createHash, randomUUID } = require("node:crypto");

const { getXAIEndpoint, getXAIKey, resolveXaiEndpointForModel } = require("./_shared");
const { getBuildInfo } = require("./_buildInfo");
const { loadCompanyById, toNormalizedDomain } = require("./_adminRefreshCompany");
const { normalizeUrl, validateCuratedReviewCandidate } = require("./_reviewQuality");

const BUILD_INFO = getBuildInfo();
const HANDLER_ID = "refresh-reviews";
const VERSION_TAG = `ded-${HANDLER_ID}-${String(BUILD_INFO.build_id || "unknown").slice(0, 12)}`;

const API_STAGE = "reviews_refresh";

function logOneLineError({
  company_id,
  company_domain,
  attempt,
  timeout_ms,
  upstream_status,
  upstream_url,
  root_cause,
  err,
}) {
  try {
    const out = {
      stage: API_STAGE,
      company_id: company_id || null,
      company_domain: company_domain || null,
      attempt: Number.isFinite(Number(attempt)) ? Number(attempt) : null,
      timeout_ms: Number.isFinite(Number(timeout_ms)) ? Number(timeout_ms) : null,
      upstream_status: Number.isFinite(Number(upstream_status)) ? Number(upstream_status) : null,
      upstream_url: upstream_url || null,
      root_cause: root_cause || null,
      err: {
        name: asString(err?.name).trim() || "Error",
        message: asString(err?.message).trim() || asString(err).trim() || "Unknown error",
      },
    };

    console.error(JSON.stringify(out));
  } catch {
    // ignore
  }
}

function errorResponse(
  {
    httpStatus,
    root_cause,
    message,
    upstream_status,
    upstream_url,
    step,
    company_id,
    company_domain,
    attempt,
    timeout_ms,
    extra,
    err,
  },
  jsonFn
) {
  const redactedUrl = upstream_url ? redactUrlQueryAndHash(upstream_url) : "";

  logOneLineError({
    company_id,
    company_domain,
    attempt,
    timeout_ms,
    upstream_status,
    upstream_url: redactedUrl,
    root_cause,
    err: err || new Error(message || "Request failed"),
  });

  return jsonFn(
    {
      ok: false,
      stage: API_STAGE,
      handler_id: HANDLER_ID,
      version_tag: VERSION_TAG,
      step: step || null,
      root_cause: root_cause || null,
      upstream_status: upstream_status ?? null,
      upstream_url: redactedUrl || null,
      message: asString(message).trim() || "Request failed",
      error: asString(message).trim() || "Request failed",
      build_id: BUILD_INFO?.build_id || null,
      ...(extra && typeof extra === "object" ? extra : {}),
    },
    httpStatus
  );
}

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
      "X-Api-Handler": HANDLER_ID,
      "X-Api-Build-Id": String(BUILD_INFO.build_id || ""),
      "X-Api-Build-Source": String(BUILD_INFO.build_id_source || ""),
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

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readTimeoutMs(value, fallback) {
  const raw = asString(value).trim();
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.max(5000, Math.min(300000, Math.floor(num)));
}

function resolveAbsoluteUrl(maybeRelativeUrl, reqUrl) {
  const raw = asString(maybeRelativeUrl).trim();
  if (!raw) return "";

  // Allow callers to configure relative endpoints like "/api/xai".
  // Axios in Node requires an absolute URL, so resolve against the incoming request URL.
  if (raw.startsWith("/")) {
    const base = asString(reqUrl).trim();
    if (base) {
      try {
        return new URL(raw, base).toString();
      } catch {
        // fall through
      }
    }
  }

  return raw;
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
    return s;
  }
}

function isUpstreamTimeoutError(err) {
  const code = asString(err?.code).trim();
  if (code === "ECONNABORTED" || code === "ERR_CANCELED") return true;
  const msg = asString(err?.message).toLowerCase();
  return msg.includes("timeout") || msg.includes("timed out") || msg.includes("aborted");
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

function readTake(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(200, Math.trunc(n)));
}

function getCompaniesContainer() {
  const endpoint = asString(process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_ENDPOINT).trim();
  const key = asString(process.env.COSMOS_DB_KEY || process.env.COSMOS_KEY).trim();
  const database = asString(process.env.COSMOS_DB_DATABASE || process.env.COSMOS_DB || "tabarnam-db").trim();
  const containerName = asString(process.env.COSMOS_DB_COMPANIES_CONTAINER || process.env.COSMOS_CONTAINER || "companies").trim();
  if (!endpoint || !key) return null;
  if (!CosmosClient) return null;

  try {
    const client = new CosmosClient({ endpoint, key });
    return client.database(database).container(containerName);
  } catch {
    return null;
  }
}

function parseJsonArrayFromText(text) {
  const raw = asString(text);
  if (!raw.trim()) return { items: [], parse_error: "Empty response" };

  try {
    const parsed = safeJsonParse(raw);
    if (Array.isArray(parsed)) return { items: parsed, parse_error: null };
  } catch {}

  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return { items: [], parse_error: "No JSON array found" };
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return { items: [], parse_error: "Parsed value is not an array" };
    return { items: parsed, parse_error: null };
  } catch (e) {
    return { items: [], parse_error: e?.message || String(e) };
  }
}

function normalizeWhitespace(s) {
  return asString(s).replace(/\s+/g, " ").trim();
}

function normalizeForHash(s) {
  return normalizeWhitespace(s)
    .toLowerCase()
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeUrlForCompare(s) {
  const raw = asString(s).trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.hash = "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    const search = u.searchParams.toString();
    return `${u.protocol}//${host}${path}${search ? `?${search}` : ""}`;
  } catch {
    return raw.toLowerCase();
  }
}

function computeReviewHash(r) {
  const title = normalizeForHash(r?.title);
  const excerpt = normalizeForHash(r?.excerpt);
  const author = normalizeForHash(r?.author);
  const date = normalizeForHash(r?.date);
  const blob = [title, excerpt, author, date].filter(Boolean).join("|");
  if (!blob) return "";
  return createHash("sha256").update(blob).digest("hex");
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

function normalizeReviewCandidate(value) {
  const r = value && typeof value === "object" ? value : {};

  const source_url = normalizeWhitespace(r.source_url || r.url);
  const excerpt = normalizeWhitespace(r.excerpt || r.text || r.abstract || r.summary);
  const source_name = normalizeWhitespace(r.source_name || r.source || r.platform || r.site);
  const date = normalizeWhitespace(r.date);

  // New rules: url + excerpt are mandatory.
  if (!source_url || !excerpt) return null;

  const normalizedUrl = normalizeUrl(source_url);
  if (!normalizedUrl || isDisallowedReviewSourceUrl(normalizedUrl)) return null;

  return {
    id: `proposed_${Date.now()}_${randomUUID()}`,

    // Canonical
    source_name,
    source_url: normalizedUrl,
    excerpt,
    date: date || null,

    // Back-compat fields used by parts of the UI/admin tools
    source: source_name || "Unknown Source",
    title: "",
    author: "",
    rating: null,

    // Filled after validation
    link_status: null,
    final_url: null,
    match_confidence: null,
    last_checked_at: null,
    reason_if_rejected: null,
  };
}

function buildReviewsPrompt({ companyName, websiteUrl, industries, take, existingContext }) {
  const hints = [
    companyName ? `Company: ${companyName}` : null,
    websiteUrl ? `Website: ${websiteUrl}` : null,
    industries ? `Industries: ${industries}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const existingBlock = existingContext
    ? `\n\nALREADY IMPORTED REVIEWS (avoid duplicates):\n${existingContext}`
    : "";

  return `Find independent reviews about this company (or its products/services).

${hints || "(no company hints provided)"}

SOURCE RULES:
- Reviews MUST NOT be sourced from Amazon or Google.
  - Exclude amazon.* domains, amzn.to
  - Exclude google.* domains, g.co, goo.gl
  - YouTube is allowed.
- Magazines, blogs, news sites, YouTube, X (Twitter), and Facebook posts/pages are all acceptable.

Return a JSON array of review objects. Each review object MUST be:
{
  "source_name": "Name of publication/channel/account (optional)",
  "source_url": "https://example.com/article-or-post" (REQUIRED),
  "date": "YYYY-MM-DD" (optional; omit if unknown),
  "excerpt": "Short excerpt/quote (1-2 sentences)" (REQUIRED)
}

IMPORTANT LINK RULES:
- "source_url" must be a DIRECT link to the specific article/video/post.
- Do NOT return homepages, category pages, or search pages.
- If you are not confident the exact URL is correct, omit that item.

Return ONLY the JSON array and no other text.${existingBlock}`;
}

function buildReviewsPromptFallback({ companyName, websiteUrl, industries, take, existingContext }) {
  const hints = [
    companyName ? `Company: ${companyName}` : null,
    websiteUrl ? `Website: ${websiteUrl}` : null,
    industries ? `Industries: ${industries}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const existingBlock = existingContext
    ? `\n\nALREADY IMPORTED REVIEWS (avoid duplicates):\n${existingContext}`
    : "";

  return `Find independent reviews about this company (or its products/services).

${hints || "(no company hints provided)"}

RULES:
- Reviews MUST NOT be sourced from Amazon or Google.
  - Exclude amazon.* domains, amzn.to
  - Exclude google.* domains, g.co, goo.gl
  - YouTube is allowed.
- If the company has little coverage, include credible third-party mentions from blogs, news, YouTube, X (Twitter), and Facebook.

Return a JSON array of objects:
{
  "source_name": "Name of publication/channel/account (optional)",
  "source_url": "https://example.com/article-or-post" (REQUIRED),
  "date": "YYYY-MM-DD" (optional; omit if unknown),
  "excerpt": "Short excerpt/quote (1-2 sentences)" (REQUIRED)
}

IMPORTANT LINK RULES:
- "source_url" must be a DIRECT link to the specific article/video/post.
- Do NOT return homepages, category pages, or search pages.
- If you are not confident the exact URL is correct, omit that item.

Return ONLY the JSON array and no other text.${existingBlock}`;
}

async function adminRefreshReviewsHandler(req, context, deps = {}) {
  if (req?.method === "OPTIONS") {
    return json({ ok: true }, 200);
  }

  const startedAt = Date.now();
  let stage = "start";

  const logCtx = {
    company_id: "",
    company_domain: "",
  };

  const xaiTimeoutMs = readTimeoutMs(
    deps.xaiTimeoutMs ?? process.env.XAI_TIMEOUT_MS ?? process.env.XAI_REQUEST_TIMEOUT_MS,
    60000
  );

  let requestDeadlineMs = readTimeoutMs(
    deps.deadlineMs ?? process.env.ADMIN_REFRESH_REVIEWS_DEADLINE_MS,
    Math.min(120000, xaiTimeoutMs + 5000)
  );

  const elapsedMs = () => Date.now() - startedAt;
  const timeRemainingMs = () => requestDeadlineMs - elapsedMs();

  const config = {
    COSMOS_DB_ENDPOINT_SET: Boolean(asString(process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_ENDPOINT).trim()),
    COSMOS_DB_KEY_SET: Boolean(asString(process.env.COSMOS_DB_KEY || process.env.COSMOS_KEY).trim()),
    COSMOS_DB_DATABASE_SET: Boolean(asString(process.env.COSMOS_DB_DATABASE || process.env.COSMOS_DB).trim()),
    COSMOS_DB_COMPANIES_CONTAINER_SET: Boolean(
      asString(process.env.COSMOS_DB_COMPANIES_CONTAINER || process.env.COSMOS_CONTAINER).trim()
    ),
    XAI_EXTERNAL_BASE_SET: Boolean(asString(process.env.XAI_EXTERNAL_BASE || process.env.FUNCTION_URL).trim()),
    XAI_EXTERNAL_KEY_SET: Boolean(
      asString(process.env.XAI_EXTERNAL_KEY || process.env.FUNCTION_KEY || process.env.XAI_API_KEY).trim()
    ),
    XAI_TIMEOUT_MS: xaiTimeoutMs,
    DEADLINE_MS: requestDeadlineMs,
  };

  try {
    stage = "parse_request";

    const method = asString(req?.method).toUpperCase();
    const body = method === "POST" ? await readJsonBody(req) : {};

    const query = req?.query && typeof req.query === "object" ? req.query : {};

    requestDeadlineMs = readTimeoutMs(
      deps.deadlineMs ?? body.deadline_ms ?? query.deadline_ms ?? process.env.ADMIN_REFRESH_REVIEWS_DEADLINE_MS,
      requestDeadlineMs
    );

    config.DEADLINE_MS = requestDeadlineMs;

    const companyId = asString(body.company_id || body.id || query.company_id || query.id).trim();
    const take = readTake(body.take ?? query.take, 10);
    const includeExistingInContext =
      body.include_existing_in_context === undefined && body.include_existing === undefined && body.includeExistingInContext === undefined
        ? true
        : Boolean(body.include_existing_in_context ?? body.include_existing ?? body.includeExistingInContext);

    if (!companyId) {
      return errorResponse(
        {
          httpStatus: 400,
          root_cause: "parse_error",
          message: "company_id required",
          step: stage,
          extra: {
            config,
            elapsed_ms: Date.now() - startedAt,
          },
          err: new Error("company_id required"),
        },
        json
      );
    }

    logCtx.company_id = companyId;

    stage = "init_cosmos";
    const container = deps.companiesContainer || getCompaniesContainer();
    if (!container) {
      return errorResponse(
        {
          httpStatus: 500,
          root_cause: "missing_env",
          message: "Cosmos not configured",
          step: stage,
          company_id: logCtx.company_id,
          company_domain: logCtx.company_domain,
          extra: {
            details: { message: "Set COSMOS_DB_ENDPOINT and COSMOS_DB_KEY" },
            config,
            elapsed_ms: Date.now() - startedAt,
          },
          err: new Error("Cosmos not configured"),
        },
        json
      );
    }

    stage = "load_company";
    const loadFn = deps.loadCompanyById || loadCompanyById;
    const company = await loadFn(container, companyId);
    if (!company) {
      return errorResponse(
        {
          httpStatus: 404,
          root_cause: "parse_error",
          message: "Company not found",
          step: stage,
          company_id: logCtx.company_id,
          company_domain: logCtx.company_domain,
          extra: {
            company_id: companyId,
            elapsed_ms: Date.now() - startedAt,
          },
          err: new Error("Company not found"),
        },
        json
      );
    }

    const existingCurated = Array.isArray(company.curated_reviews) ? company.curated_reviews : [];

    logCtx.company_domain = asString(company.normalized_domain).trim() || toNormalizedDomain(asString(company.website_url || company.canonical_url || company.url).trim());
    const existingUrlSet = new Set(
      existingCurated
        .map((r) => normalizeUrlForCompare(r?.source_url || r?.url))
        .filter(Boolean)
    );
    const existingHashSet = new Set(existingCurated.map(computeReviewHash).filter(Boolean));

    const companyName = asString(company.company_name || company.name).trim();
    const websiteUrl = asString(company.website_url || company.canonical_url || company.url).trim();
    const industries = Array.isArray(company.industries) ? company.industries.join(", ") : asString(company.industries).trim();

    const existingContext = includeExistingInContext
      ? existingCurated
          .slice(0, 50)
          .map((r) => {
            const url = normalizeWhitespace(r?.source_url || r?.url);
            const title = normalizeWhitespace(r?.title);
            return url && title ? `- ${title} (${url})` : url ? `- ${url}` : title ? `- ${title}` : null;
          })
          .filter(Boolean)
          .join("\n")
      : "";

    stage = "init_xai";
    const xaiEndpointRaw = asString(deps.xaiUrl || getXAIEndpoint()).trim();
    const xaiModel = "grok-4-latest";

    const resolvedUpstreamUrl = resolveXaiEndpointForModel(xaiEndpointRaw, xaiModel);
    const xaiUrl = resolveAbsoluteUrl(resolvedUpstreamUrl, req?.url);

    const defaultKey = asString(deps.xaiKey || getXAIKey()).trim();

    // When calling an Azure Function proxy host, we typically need its function key
    // (FUNCTION_KEY / XAI_EXTERNAL_KEY), not the direct XAI_API_KEY.
    const functionKey = asString(process.env.FUNCTION_KEY).trim();
    const externalKey = asString(process.env.XAI_EXTERNAL_KEY).trim();
    const useFunctionsKey = isAzureWebsitesUrl(xaiUrl);
    const xaiKey = useFunctionsKey ? functionKey || externalKey || defaultKey : defaultKey;

    if (!xaiUrl || !xaiKey) {
      return errorResponse(
        {
          httpStatus: 500,
          root_cause: "missing_env",
          message: "XAI not configured",
          step: stage,
          company_id: logCtx.company_id,
          company_domain: logCtx.company_domain,
          extra: {
            details: { message: "Set XAI_EXTERNAL_BASE and XAI_EXTERNAL_KEY" },
            config,
            elapsed_ms: Date.now() - startedAt,
          },
          err: new Error("XAI not configured"),
        },
        json
      );
    }

    stage = "build_prompt";
    const prompt = buildReviewsPrompt({
      companyName,
      websiteUrl,
      industries,
      take,
      existingContext,
    });

    const companyHost = (() => {
      try {
        const u = new URL(websiteUrl);
        return String(u.hostname || "").toLowerCase().replace(/^www\./, "");
      } catch {
        return "";
      }
    })();

    const excludedWebsites = [
      "amazon.com",
      "www.amazon.com",
      "amzn.to",
      "google.com",
      "www.google.com",
      "g.co",
      "goo.gl",
      "yelp.com",
      "www.yelp.com",
      ...(companyHost ? [companyHost, `www.${companyHost}`] : []),
    ];

    const payload = {
      messages: [{ role: "user", content: prompt }],
      model: xaiModel,
      search_parameters: {
        mode: "on",
        sources: [
          { type: "web", excluded_websites: excludedWebsites },
          { type: "news", excluded_websites: excludedWebsites },
          { type: "x" },
        ],
      },
      temperature: 0.2,
      stream: false,
    };

    stage = "call_xai";
    const axiosPost = deps.axiosPost || (axios ? axios.post.bind(axios) : null);
    if (!axiosPost) {
      return errorResponse(
        {
          httpStatus: 500,
          root_cause: "missing_env",
          message: "Axios not available",
          step: stage,
          company_id: logCtx.company_id,
          company_domain: logCtx.company_domain,
          extra: {
            config,
            elapsed_ms: elapsedMs(),
          },
          err: new Error("Axios not available"),
        },
        json
      );
    }

    const timeBudgetBeforeXai = timeRemainingMs();
    if (timeBudgetBeforeXai < 6500) {
      return errorResponse(
        {
          httpStatus: 504,
          root_cause: "timeout",
          message: "Deadline exceeded before upstream call",
          step: stage,
          company_id: logCtx.company_id,
          company_domain: logCtx.company_domain,
          timeout_ms: requestDeadlineMs,
          extra: {
            code: "DEADLINE_EXCEEDED",
            details: {
              deadline_ms: requestDeadlineMs,
              elapsed_ms: elapsedMs(),
            },
            config,
            elapsed_ms: elapsedMs(),
          },
          err: new Error("Deadline exceeded before upstream call"),
        },
        json
      );
    }

    const xaiRequestTimeoutMs = Math.max(5000, Math.min(xaiTimeoutMs, Math.floor(timeBudgetBeforeXai - 1500)));

    const headers = {
      "Content-Type": "application/json",
    };

    if (useFunctionsKey) {
      headers["x-functions-key"] = xaiKey;

      // Avoid sending the Azure Function key as an Authorization bearer token.
      // Many proxies forward Authorization to the upstream model provider.
    } else {
      headers.Authorization = `Bearer ${xaiKey}`;
    }

    let resp;

    try {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timeoutId =
        controller && Number.isFinite(xaiRequestTimeoutMs) ? setTimeout(() => controller.abort(), xaiRequestTimeoutMs) : null;

      try {
        resp = await axiosPost(xaiUrl, payload, {
          headers,
          timeout: xaiRequestTimeoutMs,
          ...(controller ? { signal: controller.signal } : {}),
          validateStatus: () => true,
        });
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    } catch (e) {
      if (isUpstreamTimeoutError(e)) {
        return errorResponse(
          {
            httpStatus: 504,
            root_cause: "timeout",
            message: "Upstream timeout",
            step: stage,
            company_id: logCtx.company_id,
            company_domain: logCtx.company_domain,
            attempt: 1,
            timeout_ms: xaiRequestTimeoutMs,
            upstream_status: 0,
            upstream_url: xaiUrl,
            extra: {
              code: "UPSTREAM_TIMEOUT",
              details: {
                message: "The reviews provider did not respond before the timeout.",
                timeout_ms: xaiRequestTimeoutMs,
                resolved_upstream_url_redacted: redactUrlQueryAndHash(xaiUrl) || null,
              },
              config,
              elapsed_ms: Date.now() - startedAt,
            },
            err: e,
          },
          json
        );
      }

      return errorResponse(
        {
          httpStatus: 502,
          root_cause: "upstream_5xx",
          message: "Upstream request failed",
          step: stage,
          company_id: logCtx.company_id,
          company_domain: logCtx.company_domain,
          attempt: 1,
          timeout_ms: xaiRequestTimeoutMs,
          upstream_status: 0,
          upstream_url: xaiUrl,
          extra: {
            code: "UPSTREAM_REQUEST_FAILED",
            details: {
              message: asString(e?.message).trim() || "Request failed",
              resolved_upstream_url_redacted: redactUrlQueryAndHash(xaiUrl) || null,
            },
            config,
            elapsed_ms: Date.now() - startedAt,
          },
          err: e,
        },
        json
      );
    }

    stage = "parse_xai";
    const responseText =
      resp?.data?.choices?.[0]?.message?.content ||
      (typeof resp?.data === "string" ? resp.data : JSON.stringify(resp.data || {}));

    if (resp.status < 200 || resp.status >= 300) {
      const upstreamStatus = Number(resp.status) || 0;
      const rootCause = upstreamStatus >= 400 && upstreamStatus < 500 ? "upstream_4xx" : "upstream_5xx";

      return errorResponse(
        {
          httpStatus: 502,
          root_cause: rootCause,
          message: `Upstream reviews fetch failed (HTTP ${upstreamStatus || "?"})`,
          step: stage,
          company_id: logCtx.company_id,
          company_domain: logCtx.company_domain,
          attempt: 1,
          timeout_ms: xaiRequestTimeoutMs,
          upstream_status: upstreamStatus,
          upstream_url: xaiUrl,
          extra: {
            status: upstreamStatus,
            details: {
              upstream_preview: asString(responseText).slice(0, 8000),
              xai_model: xaiModel,
              resolved_upstream_url: redactUrlQueryAndHash(xaiUrl),
              endpoint_source: xaiEndpointRaw ? "configured" : "missing",
            },
            config,
            elapsed_ms: Date.now() - startedAt,
          },
          err: new Error(`Upstream returned ${upstreamStatus}`),
        },
        json
      );
    }

    let { items, parse_error } = parseJsonArrayFromText(responseText);

    let proposed = (Array.isArray(items) ? items : [])
      .map(normalizeReviewCandidate)
      .filter(Boolean)
      .slice(0, take);

    const attemptsOut = [
      {
        kind: "primary",
        parse_error: parse_error || null,
        returned_count: proposed.length,
      },
    ];

    if (proposed.length === 0) {
      stage = "call_xai_fallback";
      const fallbackPrompt = buildReviewsPromptFallback({
        companyName,
        websiteUrl,
        industries,
        take,
        existingContext,
      });

      const fallbackBudget = timeRemainingMs();
      const fallbackTimeoutMs =
        fallbackBudget >= 6500
          ? Math.max(5000, Math.min(xaiTimeoutMs, Math.floor(fallbackBudget - 1500)))
          : 0;

      const fallbackPayload = {
        messages: [{ role: "user", content: fallbackPrompt }],
        model: xaiModel,
        temperature: 0.2,
        stream: false,
      };

      let fallbackResp;

      try {
        if (!fallbackTimeoutMs) {
          attemptsOut.push({
            kind: "fallback",
            parse_error: "Skipped due to deadline",
            returned_count: 0,
          });

          fallbackResp = null;
        } else {
          const controller = typeof AbortController === "function" ? new AbortController() : null;
          const timeoutId =
            controller && Number.isFinite(fallbackTimeoutMs) ? setTimeout(() => controller.abort(), fallbackTimeoutMs) : null;

          try {
            fallbackResp = await axiosPost(xaiUrl, fallbackPayload, {
              headers,
              timeout: fallbackTimeoutMs,
              ...(controller ? { signal: controller.signal } : {}),
              validateStatus: () => true,
            });
          } finally {
            if (timeoutId) clearTimeout(timeoutId);
          }
        }
      } catch (e) {
        attemptsOut.push({
          kind: "fallback",
          parse_error: isUpstreamTimeoutError(e) ? "Upstream timeout" : asString(e?.message).trim() || "Request failed",
          returned_count: 0,
        });

        fallbackResp = null;
      }

      if (fallbackResp) {
        stage = "parse_xai_fallback";
        const fallbackText =
          fallbackResp?.data?.choices?.[0]?.message?.content ||
          (typeof fallbackResp?.data === "string" ? fallbackResp.data : JSON.stringify(fallbackResp.data || {}));

        if (fallbackResp.status >= 200 && fallbackResp.status < 300) {
          const parsedFallback = parseJsonArrayFromText(fallbackText);
          items = parsedFallback.items;
          parse_error = parsedFallback.parse_error;

          proposed = (Array.isArray(items) ? items : [])
            .map(normalizeReviewCandidate)
            .filter(Boolean)
            .slice(0, take);

          attemptsOut.push({
            kind: "fallback",
            parse_error: parse_error || null,
            returned_count: proposed.length,
          });
        } else {
          attemptsOut.push({
            kind: "fallback",
            parse_error: `Upstream HTTP ${fallbackResp.status}`,
            returned_count: 0,
          });
        }
      }
    }

    async function mapWithConcurrency(items, concurrency, mapper) {
      const out = new Array(items.length);
      let next = 0;

      async function worker() {
        for (;;) {
          const idx = next;
          next += 1;
          if (idx >= items.length) return;
          out[idx] = await mapper(items[idx], idx);
        }
      }

      const workers = new Array(Math.max(1, Math.min(concurrency, items.length)))
        .fill(null)
        .map(() => worker());
      await Promise.all(workers);
      return out;
    }

    const normalizedDomainHint = asString(company.normalized_domain).trim() || toNormalizedDomain(websiteUrl);

    stage = "validate_candidates";
    const validationBudget = timeRemainingMs();

    const validated =
      validationBudget < 2500
        ? proposed.map((r) => {
            const normalizedCandidateUrl = normalizeUrl(r.source_url);
            const nowIso = new Date().toISOString();

            if (!normalizedCandidateUrl) {
              return {
                ...r,
                source_url: r.source_url,
                link_status: "invalid_url",
                final_url: null,
                match_confidence: 0,
                last_checked_at: nowIso,
                reason_if_rejected: "invalid url",
                is_valid: false,
              };
            }

            return {
              ...r,
              source_url: normalizedCandidateUrl,
              link_status: null,
              final_url: null,
              match_confidence: null,
              last_checked_at: nowIso,
              reason_if_rejected: "validation skipped due to deadline",
              is_valid: false,
            };
          })
        : await mapWithConcurrency(proposed, validationBudget < 7000 ? 2 : 3, async (r) => {
            const normalizedCandidateUrl = normalizeUrl(r.source_url);
            if (!normalizedCandidateUrl) {
              return {
                ...r,
                source_url: r.source_url,
                link_status: "invalid_url",
                final_url: null,
                match_confidence: 0,
                last_checked_at: new Date().toISOString(),
                reason_if_rejected: "invalid url",
                is_valid: false,
              };
            }

            const remaining = timeRemainingMs();
            const timeoutMs = Math.max(800, Math.min(2500, Math.floor((remaining - 800) / 2)));

            const v = await validateCuratedReviewCandidate(
              {
                companyName,
                websiteUrl,
                normalizedDomain: normalizedDomainHint,
                url: normalizedCandidateUrl,
                title: asString(r.title).trim(),
                excerpt: asString(r.excerpt).trim(),
              },
              { timeoutMs, maxBytes: 60000, maxSnippets: 2, minWords: 10, maxWords: 25 }
            ).catch((e) => ({
              is_valid: false,
              link_status: "blocked",
              final_url: null,
              matched_brand_terms: [],
              evidence_snippets: [],
              match_confidence: 0,
              last_checked_at: new Date().toISOString(),
              reason_if_rejected: asString(e?.message).trim() || "validation error",
            }));

            return {
              ...r,
              source_url: v?.final_url || normalizedCandidateUrl,
              link_status: asString(v?.link_status).trim() || "blocked",
              final_url: v?.final_url || null,
              match_confidence: typeof v?.match_confidence === "number" ? v.match_confidence : null,
              last_checked_at: v?.last_checked_at || new Date().toISOString(),
              reason_if_rejected: v?.reason_if_rejected || null,
              evidence_snippets: Array.isArray(v?.evidence_snippets) ? v.evidence_snippets : [],
              matched_brand_terms: Array.isArray(v?.matched_brand_terms) ? v.matched_brand_terms : [],
              is_valid: v?.is_valid === true,
            };
          });

    const proposed_reviews = validated.map((r) => {
      const urlKey = normalizeUrlForCompare(r.source_url);
      const hashKey = computeReviewHash(r);
      const duplicate = (urlKey && existingUrlSet.has(urlKey)) || (hashKey && existingHashSet.has(hashKey));
      return {
        ...r,
        duplicate,
        ...(duplicate ? { duplicate_key: urlKey || hashKey || "unknown" } : {}),
      };
    });

    stage = "done";
    return json({
      ok: true,
      stage: API_STAGE,
      handler_id: HANDLER_ID,
      version_tag: VERSION_TAG,
      build_id: BUILD_INFO?.build_id || null,
      company_id: companyId,
      requested_take: take,
      fetched_count: proposed_reviews.length,
      saved_count: 0,
      returned_count: proposed_reviews.length,
      reviews: proposed_reviews,
      proposed_reviews,
      attempts: attemptsOut,
      ...(parse_error ? { parse_error } : {}),
      elapsed_ms: Date.now() - startedAt,
      hints: {
        company_name: companyName,
        website_url: websiteUrl,
        normalized_domain: asString(company.normalized_domain).trim() || toNormalizedDomain(websiteUrl),
        include_existing_in_context: includeExistingInContext,
      },
    });
  } catch (e) {
    context?.log?.("[admin-refresh-reviews] error", {
      stage,
      message: e?.message || String(e),
      stack: e?.stack,
    });

    return errorResponse(
      {
        httpStatus: 500,
        root_cause: "parse_error",
        message: asString(e?.message).trim() || "Internal error",
        step: stage,
        company_id: logCtx.company_id,
        company_domain: logCtx.company_domain,
        extra: {
          config,
          elapsed_ms: Date.now() - startedAt,
        },
        err: e,
      },
      json
    );
  }
}

module.exports = {
  adminRefreshReviewsHandler,
  _test: {
    parseJsonArrayFromText,
    normalizeReviewCandidate,
    computeReviewHash,
    normalizeUrlForCompare,
  },
};
