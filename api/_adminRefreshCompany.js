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

const {
  getXAIEndpoint,
  getXAIKey,
  getResolvedUpstreamMeta,
  resolveXaiEndpointForModel,
} = require("./_shared");
const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
} = require("./_cosmosPartitionKey");
const { fetchConfirmedCompanyTagline } = require("./_taglineXai");
const { getBuildInfo } = require("./_buildInfo");

const BUILD_INFO = getBuildInfo();
const HANDLER_ID = "refresh-company";

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

function isAzureWebsitesUrl(rawUrl) {
  const raw = asString(rawUrl).trim().toLowerCase();
  if (!raw) return false;
  return raw.includes(".azurewebsites.net");
}

function buildXaiHeaders(xaiUrl, xaiKey) {
  const headers = {
    "Content-Type": "application/json",
  };

  if (isAzureWebsitesUrl(xaiUrl)) {
    headers["x-functions-key"] = asString(xaiKey).trim();
  } else {
    headers["Authorization"] = `Bearer ${asString(xaiKey).trim()}`;
  }

  return headers;
}

function readTimeoutMs(value, fallback) {
  const raw = asString(value).trim();
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  const clamped = Math.max(5000, Math.min(300000, Math.floor(num)));
  return clamped;
}

function toNormalizedDomain(s = "") {
  try {
    const u = s.startsWith("http") ? new URL(s) : new URL(`https://${s}`);
    let h = u.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h || "unknown";
  } catch {
    return "unknown";
  }
}

function normalizeStringList(input) {
  if (Array.isArray(input)) {
    return [...new Set(input.map((s) => asString(s).trim()).filter(Boolean))];
  }

  if (typeof input === "string") {
    return [
      ...new Set(
        input
          .split(/[,;|\n]/)
          .map((s) => s.trim())
          .filter(Boolean)
      ),
    ];
  }

  return [];
}

function normalizeLocationSources(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => v && typeof v === "object")
    .map((v) => {
      const location = asString(v.location).trim();
      const source_url = asString(v.source_url).trim();
      const source_type = asString(v.source_type).trim();
      const location_type = asString(v.location_type).trim();
      if (!location) return null;
      return {
        location,
        ...(source_url ? { source_url } : {}),
        ...(source_type ? { source_type } : {}),
        ...(location_type ? { location_type } : {}),
      };
    })
    .filter(Boolean);
}

function normalizeLocationConfidence(value) {
  const v = asString(value).trim().toLowerCase();
  if (v === "high" || v === "medium" || v === "low") return v;
  return "medium";
}

function normalizeManufacturingLocations(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => {
      if (typeof v === "string") {
        const s = v.trim();
        return s ? { location: s } : null;
      }
      if (v && typeof v === "object") {
        const formatted = asString(v.formatted).trim();
        const location = asString(v.location || v.address || v.full_address).trim();
        const city = asString(v.city).trim();
        const region = asString(v.region || v.state).trim();
        const country = asString(v.country).trim();
        const best = formatted || location || [city, region, country].filter(Boolean).join(", ");
        return best ? { location: best } : null;
      }
      return null;
    })
    .filter(Boolean);
}

function normalizeHeadquartersLocations(hqString) {
  const s = asString(hqString).trim();
  if (!s) return [];
  return [{ formatted: s, is_hq: true }];
}

function stripJsonCodeFences(text) {
  const raw = asString(text);
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match) return asString(match[1]).trim();
  return raw.trim();
}

function findBalancedJsonSubstring(raw, startIndex) {
  const open = raw[startIndex];
  if (open !== "{" && open !== "[") return "";

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIndex; i < raw.length; i++) {
    const ch = raw[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{" || ch === "[") depth += 1;
    if (ch === "}" || ch === "]") depth -= 1;

    if (depth === 0) {
      return raw.slice(startIndex, i + 1);
    }
  }

  return "";
}

function extractJsonFromText(text) {
  const raw0 = asString(text);
  if (!raw0.trim()) return { value: null, parse_error: "Empty response", json_text: "" };

  const raw = stripJsonCodeFences(raw0);
  const direct = safeJsonParse(raw);
  if (direct !== null && direct !== undefined) {
    return { value: direct, parse_error: null, json_text: raw };
  }

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== "{" && ch !== "[") continue;

    const candidate = findBalancedJsonSubstring(raw, i);
    if (!candidate) continue;

    try {
      const parsed = JSON.parse(candidate);
      return { value: parsed, parse_error: null, json_text: candidate };
    } catch {
      // keep scanning
    }
  }

  const match = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) return { value: null, parse_error: "No JSON found", json_text: "" };

  try {
    return { value: JSON.parse(match[0]), parse_error: null, json_text: match[0] };
  } catch (e) {
    return { value: null, parse_error: e?.message || String(e), json_text: match[0] };
  }
}

function normalizeXaiEnrichmentValue(value) {
  const v = value && typeof value === "object" ? value : null;
  if (!v) return { company: null, sources: [], confidence: null, error: null };

  if (!Array.isArray(v) && v.error && typeof v.error === "object") {
    return {
      company: null,
      sources: [],
      confidence: null,
      error: {
        code: v.error.code ?? v.error.status ?? v.error.http_status ?? null,
        message: asString(v.error.message || v.error.error || v.error.detail).trim(),
      },
    };
  }

  if (Array.isArray(v)) {
    const firstObj = v.find((item) => item && typeof item === "object") || null;
    return {
      company: firstObj,
      sources: normalizeLocationSources(firstObj?.location_sources),
      confidence: firstObj?.location_confidence
        ? { location_confidence: normalizeLocationConfidence(firstObj.location_confidence) }
        : null,
      error: null,
    };
  }

  const company = v.company && typeof v.company === "object" ? v.company : v;
  const sources = Array.isArray(v.sources)
    ? normalizeLocationSources(v.sources)
    : normalizeLocationSources(company?.location_sources);
  const confidence = v.confidence && typeof v.confidence === "object" ? v.confidence : null;

  return { company, sources, confidence, error: null };
}

function parseXaiCompaniesResponse(text) {
  const { value, parse_error } = extractJsonFromText(text);
  const normalized = normalizeXaiEnrichmentValue(value);

  if (normalized.error) {
    return { companies: [], parse_error: null, upstream_error: normalized.error };
  }

  if (normalized.company && typeof normalized.company === "object") {
    return { companies: [normalized.company], parse_error: parse_error || null };
  }

  if (Array.isArray(value)) {
    const list = value.filter((item) => item && typeof item === "object");
    return { companies: list, parse_error: parse_error || null };
  }

  return { companies: [], parse_error: parse_error || "No company object found" };
}

function buildPrompt({ companyName, websiteUrl, normalizedDomain }) {
  const hints = [
    companyName ? `Company name: ${companyName}` : null,
    websiteUrl ? `Website URL: ${websiteUrl}` : null,
    normalizedDomain ? `Domain: ${normalizedDomain}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `You are a business research assistant specializing in headquarters and manufacturing location extraction.

Your task: Enrich ONE specific company, matching the target company as closely as possible.
Do NOT return competitors or similarly named companies.

TARGET COMPANY HINTS:
${hints || "(no hints provided)"}

Return a SINGLE JSON OBJECT with this shape (and ONLY this JSON, no extra text):
{
  "company": {
    "company_name": "...",
    "website_url": "...",
    "industries": ["..."],
    "product_keywords": "...",
    "headquarters_location": "City, State/Region, Country",
    "manufacturing_locations": ["..."],
    "location_sources": [{"location":"...","source_url":"...","source_type":"...","location_type":"..."}],
    "red_flag": false,
    "red_flag_reason": "...",
    "tagline": "...",
    "social": {"linkedin":"","instagram":"","x":"","twitter":"","facebook":"","tiktok":"","youtube":""},
    "location_confidence": "high"
  },
  "sources": [{"location":"...","source_url":"...","source_type":"...","location_type":"..."}],
  "confidence": {"overall": "high", "locations": "high", "notes": "briefly explain why"}
}

Notes:
- Always include "company".
- "sources" may duplicate company.location_sources; include it anyway.
- If truly unknown, use empty strings/arrays but keep the keys.
- Return ONLY valid JSON (no markdown).`;
}

function getCompaniesContainer() {
  const endpoint = asString(process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_ENDPOINT).trim();
  const key = asString(process.env.COSMOS_DB_KEY || process.env.COSMOS_KEY).trim();
  const database = asString(process.env.COSMOS_DB_DATABASE || process.env.COSMOS_DB || "tabarnam-db").trim();
  const containerName = asString(process.env.COSMOS_DB_COMPANIES_CONTAINER || process.env.COSMOS_CONTAINER || "companies").trim();
  if (!endpoint || !key) return null;
  if (!CosmosClient) return null;
  const client = new CosmosClient({ endpoint, key });
  return client.database(database).container(containerName);
}

let companiesPkPathPromise;
async function getCompaniesPartitionKeyPath(container) {
  if (!container) return "/normalized_domain";
  companiesPkPathPromise ||= getContainerPartitionKeyPath(container, "/normalized_domain");
  try {
    return await companiesPkPathPromise;
  } catch {
    return "/normalized_domain";
  }
}

async function loadCompanyById(container, companyId) {
  const querySpec = {
    query: "SELECT * FROM c WHERE c.id = @id",
    parameters: [{ name: "@id", value: companyId }],
  };
  const { resources } = await container.items.query(querySpec, { enableCrossPartitionQuery: true }).fetchAll();
  const docs = Array.isArray(resources) ? resources : [];
  return docs[0] || null;
}

async function patchCompanyById(container, companyId, docForCandidates, patch) {
  const id = asString(companyId).trim();
  if (!id) throw new Error("Missing company id");
  if (!container) throw new Error("Cosmos not configured");

  const containerPkPath = await getCompaniesPartitionKeyPath(container);
  const candidates = buildPartitionKeyCandidates({
    doc: docForCandidates,
    containerPkPath,
    requestedId: id,
  });

  const ops = Object.keys(patch || {}).map((key) => ({ op: "set", path: `/${key}`, value: patch[key] }));
  let lastError;

  for (const pk of candidates) {
    try {
      const itemRef = pk !== undefined ? container.item(id, pk) : container.item(id);
      await itemRef.patch(ops);
      return { ok: true, pk };
    } catch (e) {
      lastError = e;
    }
  }

  return { ok: false, error: asString(lastError?.message || lastError || "patch_failed") };
}

function buildProposedCompanyFromXaiResult(xaiCompany) {
  const src = xaiCompany && typeof xaiCompany === "object" ? xaiCompany : {};

  const company_name = asString(src.company_name || src.name).trim();
  const website_url = asString(src.website_url || src.canonical_url || src.url || src.website).trim();
  const industries = normalizeStringList(src.industries);
  const keywords = normalizeStringList(src.product_keywords);

  const headquarters_locations = normalizeHeadquartersLocations(src.headquarters_location);
  const manufacturing_locations = normalizeManufacturingLocations(src.manufacturing_locations);

  const location_sources = normalizeLocationSources(src.location_sources);
  const red_flag = Boolean(src.red_flag);
  const red_flag_reason = asString(src.red_flag_reason).trim();
  const tagline = asString(src.tagline).trim();

  const normalized_domain = toNormalizedDomain(website_url || src.canonical_url || src.url || src.amazon_url || "");

  const proposed = {
    ...(company_name ? { company_name } : {}),
    ...(website_url ? { website_url } : {}),
    ...(tagline ? { tagline } : {}),
    ...(industries.length ? { industries } : {}),
    ...(keywords.length ? { keywords } : {}),
    ...(headquarters_locations.length ? { headquarters_locations } : {}),
    ...(manufacturing_locations.length ? { manufacturing_locations } : {}),
    ...(location_sources.length ? { location_sources } : {}),
    ...(asString(src.headquarters_location).trim() ? { headquarters_location: asString(src.headquarters_location).trim() } : {}),
    ...(Array.isArray(src.manufacturing_locations) ? { manufacturing_locations_raw: src.manufacturing_locations } : {}),
    ...(typeof src.red_flag === "boolean" ? { red_flag } : {}),
    ...(red_flag_reason ? { red_flag_reason } : {}),
    ...(src.location_confidence ? { location_confidence: normalizeLocationConfidence(src.location_confidence) } : {}),
    ...(normalized_domain ? { normalized_domain } : {}),
    ...(src.social && typeof src.social === "object" ? { social: src.social } : {}),
    ...(asString(src.amazon_url).trim() ? { amazon_url: asString(src.amazon_url).trim() } : {}),
  };

  for (const key of [
    "logo_url",
    "rating",
    "rating_icon_type",
    "notes_entries",
    "notes",
    "star_rating",
    "star_overrides",
    "admin_manual_extra",
    "star_notes",
    "star_explanation",
  ]) {
    delete proposed[key];
  }

  return proposed;
}

async function adminRefreshCompanyHandler(req, context, deps = {}) {
  if (req?.method === "OPTIONS") {
    return json({ ok: true }, 200);
  }

  const startedAt = Date.now();
  let stage = "start";

  const attempts = [];
  const breadcrumbs = [];
  const pushBreadcrumb = (step, extra) => {
    try {
      const entry = {
        at_ms: Date.now() - startedAt,
        step: asString(step).trim() || "(unknown)",
        ...(extra && typeof extra === "object" ? extra : {}),
      };
      breadcrumbs.push(entry);
      if (breadcrumbs.length > 20) breadcrumbs.splice(0, breadcrumbs.length - 20);
    } catch {
      // ignore
    }
  };

  let budgetMs = 20000;
  let deadlineAtMs = startedAt + budgetMs;
  const getRemainingBudgetMs = () => Math.max(0, deadlineAtMs - Date.now());

  // Derive per-call timeouts from the remaining total budget.
  const computeUpstreamTimeoutMs = () => Math.max(3500, Math.min(12000, getRemainingBudgetMs() - 1500));

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
    XAI_MODEL: asString(process.env.XAI_MODEL || process.env.XAI_CHAT_MODEL || "grok-4-latest").trim(),
  };

  try {
    stage = "parse_body";
    const body = await readJsonBody(req);

    budgetMs = Math.max(5000, Math.min(25000, Math.trunc(Number(body?.timeout_ms ?? body?.timeoutMs ?? 20000) || 20000)));
    deadlineAtMs = startedAt + budgetMs;

    const companyId = asString(body.company_id || body.id).trim();

    if (!companyId) {
      pushBreadcrumb("client_bad_request", { reason: "missing_company_id" });
      return json({
        ok: false,
        stage: "refresh_company",
        root_cause: "client_bad_request",
        retryable: false,
        error: "company_id required",
        attempts,
        breadcrumbs,
        diagnostics: {
          message: "company_id required",
        },
        config,
        build_id: String(BUILD_INFO.build_id || ""),
        elapsed_ms: Date.now() - startedAt,
        budget_ms: budgetMs,
        remaining_budget_ms: getRemainingBudgetMs(),
      });
    }

    stage = "init_cosmos";
    const container = deps.companiesContainer || getCompaniesContainer();
    if (!container) {
      pushBreadcrumb("missing_env", { env: "cosmos" });
      return json({
        ok: false,
        stage: "refresh_company",
        root_cause: "missing_env",
        retryable: true,
        error: "Cosmos not configured",
        attempts,
        breadcrumbs,
        diagnostics: { message: "Set COSMOS_DB_ENDPOINT and COSMOS_DB_KEY" },
        config,
        build_id: String(BUILD_INFO.build_id || ""),
        elapsed_ms: Date.now() - startedAt,
        budget_ms: budgetMs,
        remaining_budget_ms: getRemainingBudgetMs(),
      });
    }

    stage = "load_company";
    const loadFn = deps.loadCompanyById || loadCompanyById;
    const existing = await loadFn(container, companyId);
    if (!existing) {
      pushBreadcrumb("not_found", { company_id: companyId });
      return json({
        ok: false,
        stage: "refresh_company",
        root_cause: "not_found",
        retryable: false,
        error: "Company not found",
        company_id: companyId,
        attempts,
        breadcrumbs,
        diagnostics: { message: "Company not found" },
        build_id: String(BUILD_INFO.build_id || ""),
        elapsed_ms: Date.now() - startedAt,
        budget_ms: budgetMs,
        remaining_budget_ms: getRemainingBudgetMs(),
      });
    }

    // Best-effort per-company lock so repeated clicks don't overlap.
    stage = "lock_check";
    const nowMs = Date.now();
    const lockUntilExisting = Number(existing.company_refresh_lock_until || 0) || 0;
    if (lockUntilExisting > nowMs) {
      const retryAfterMs = Math.max(0, lockUntilExisting - nowMs);
      pushBreadcrumb("locked", { company_id: companyId, retry_after_ms: retryAfterMs });
      return json({
        ok: false,
        stage: "refresh_company",
        root_cause: "locked",
        retryable: true,
        company_id: companyId,
        lock_until_ms: lockUntilExisting,
        retry_after_ms: retryAfterMs,
        attempts,
        breadcrumbs,
        diagnostics: { message: "Refresh already in progress" },
        build_id: String(BUILD_INFO.build_id || ""),
        elapsed_ms: Date.now() - startedAt,
        budget_ms: budgetMs,
        remaining_budget_ms: getRemainingBudgetMs(),
      });
    }

    stage = "budget_guard";
    if (getRemainingBudgetMs() < 4500) {
      pushBreadcrumb("time_budget_exhausted", { company_id: companyId });
      return json({
        ok: false,
        stage: "refresh_company",
        root_cause: "time_budget_exhausted",
        retryable: true,
        company_id: companyId,
        attempts,
        breadcrumbs,
        diagnostics: {
          message: "Total execution budget exhausted before calling upstream",
        },
        build_id: String(BUILD_INFO.build_id || ""),
        elapsed_ms: Date.now() - startedAt,
        budget_ms: budgetMs,
        remaining_budget_ms: getRemainingBudgetMs(),
      });
    }

    try {
      const lockWindowMs = Math.max(8000, Math.min(25000, budgetMs + 2000));
      const lockUntil = nowMs + lockWindowMs;
      await patchCompanyById(container, companyId, existing, {
        company_refresh_lock_key: `company_refresh_lock::${companyId}`,
        company_refresh_lock_until: lockUntil,
        company_refresh_last_attempt_at: new Date().toISOString(),
      });
    } catch {
      // ignore
    }

    const releaseRefreshLockBestEffort = async () => {
      try {
        await patchCompanyById(container, companyId, existing, {
          company_refresh_lock_until: 0,
        });
      } catch {
        // ignore
      }
    };

    stage = "prepare_prompt";
    const companyName = asString(existing.company_name || existing.name).trim();
    const websiteUrl = asString(existing.website_url || existing.canonical_url || existing.url).trim();
    const normalizedDomain = asString(existing.normalized_domain).trim() || toNormalizedDomain(websiteUrl);

    stage = "init_xai";
    const externalBase = asString(getXAIEndpoint()).trim();
    const legacyBase = asString(process.env.XAI_BASE_URL).trim();

    const xaiEndpointRaw = asString(deps.xaiUrl || externalBase || legacyBase).trim();
    const xaiKey = asString(deps.xaiKey || getXAIKey()).trim();
    const xaiModel = asString(deps.xaiModel || process.env.XAI_MODEL || process.env.XAI_CHAT_MODEL || "grok-4-latest").trim();
    const xaiUrl = asString(deps.resolvedXaiUrl || resolveXaiEndpointForModel(xaiEndpointRaw, xaiModel)).trim();

    const xai_config_source = externalBase ? "external" : legacyBase ? "legacy" : "external";
    const upstreamMeta = getResolvedUpstreamMeta(xaiUrl);

    try {
      console.log(
        JSON.stringify({
          stage: "refresh_company",
          route: "xadmin-api-refresh-company",
          kind: "xai_config",
          company_id: companyId,
          xai_config_source,
          resolved_upstream_host: upstreamMeta.resolved_upstream_host,
          resolved_upstream_path: upstreamMeta.resolved_upstream_path,
          build_id: BUILD_INFO.build_id || null,
        })
      );
    } catch {
      // ignore
    }

    const missing_env = [];
    if (!xaiEndpointRaw) missing_env.push("XAI_EXTERNAL_BASE");
    if (!xaiKey) missing_env.push("XAI_API_KEY");

    let bad_base_url = false;
    let endpoint_kind = "unknown";

    try {
      const u = new URL(xaiUrl);
      const path = asString(u.pathname).toLowerCase();

      endpoint_kind = path.includes("/proxy-xai") || path.includes("/api/xai") ? "proxy" : "direct";

      const looksLikeChat = /\/v1\/chat\/completions\/?$/i.test(u.pathname || "");
      const looksLikeResponses = /\/v1\/responses\/?$/i.test(u.pathname || "");
      const looksLikeProxy = path.includes("/proxy-xai") || path.includes("/api/xai");

      bad_base_url = !(looksLikeChat || looksLikeResponses || looksLikeProxy);
    } catch {
      bad_base_url = true;
    }

    if (missing_env.length || bad_base_url) {
      stage = "config_error";
      const hints = [
        missing_env.includes("XAI_EXTERNAL_BASE") ? "Set XAI_EXTERNAL_BASE (or FUNCTION_URL) to a chat/completions endpoint." : null,
        missing_env.includes("XAI_API_KEY") ? "Set XAI_API_KEY (or XAI_EXTERNAL_KEY / FUNCTION_KEY) to a valid key." : null,
        bad_base_url ? "Ensure the xAI URL points to /v1/chat/completions (or a compatible proxy endpoint)." : null,
        !xaiModel ? "Set XAI_MODEL to a valid model name (example: grok-4-latest)." : null,
      ].filter(Boolean);

      await releaseRefreshLockBestEffort();
      pushBreadcrumb("xai_config_error", { missing_env_count: missing_env.length, bad_base_url: Boolean(bad_base_url) });
      return json({
        ok: false,
        stage: "refresh_company",
        root_cause: "xai_config_error",
        retryable: false,
        error: "xAI configuration error",
        missing_env: missing_env.length ? missing_env : undefined,
        bad_base_url: bad_base_url || undefined,
        attempts,
        breadcrumbs,
        diagnostics: {
          hints,
          xai_endpoint: xaiEndpointRaw || null,
          resolved_xai_endpoint: xaiUrl || null,
          xai_model: xaiModel || null,
          endpoint_kind,
        },
        config,
        build_id: String(BUILD_INFO.build_id || ""),
        elapsed_ms: Date.now() - startedAt,
        budget_ms: budgetMs,
        remaining_budget_ms: getRemainingBudgetMs(),
      });
    }

    const prompt = buildPrompt({ companyName, websiteUrl, normalizedDomain });
    const payload = {
      messages: [{ role: "user", content: prompt }],
      model: xaiModel,
      temperature: 0.1,
      stream: false,
    };

    stage = "call_xai";
    pushBreadcrumb(stage, { company_id: companyId });

    const axiosPost = deps.axiosPost || (axios ? axios.post.bind(axios) : null);
    if (!axiosPost) {
      await releaseRefreshLockBestEffort();
      return json({
        ok: false,
        stage: "refresh_company",
        root_cause: "missing_dependency",
        retryable: false,
        company_id: companyId,
        upstream_status: null,
        attempts,
        breadcrumbs,
        diagnostics: {
          message: "Axios not available",
          config,
        },
        build_id: String(BUILD_INFO.build_id || ""),
        elapsed_ms: Date.now() - startedAt,
        budget_ms: budgetMs,
        remaining_budget_ms: getRemainingBudgetMs(),
      });
    }

    let resp = null;

    // Single retry (budget-aware): only for unreachable upstream or 5xx.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const timeoutMsUsed = computeUpstreamTimeoutMs();
      const attemptEntry = {
        attempt,
        timeout_ms: timeoutMsUsed,
        ok: false,
        root_cause: "",
        upstream_status: null,
      };
      attempts.push(attemptEntry);

      if (timeoutMsUsed < 3500) {
        attemptEntry.root_cause = "upstream_timeout_budget_exhausted";
        attemptEntry.message = "Total budget exhausted before calling upstream";
        break;
      }

      pushBreadcrumb(`call_xai_attempt_${attempt}`, { timeout_ms: timeoutMsUsed });

      try {
        const r = await axiosPost(xaiUrl, payload, {
          headers: buildXaiHeaders(xaiUrl, xaiKey),
          timeout: timeoutMsUsed,
          validateStatus: () => true,
        });

        const status = Number(r?.status) || 0;
        attemptEntry.upstream_status = status;

        // Treat 5xx as retryable once if we still have budget.
        if (status >= 500 && attempt === 1 && getRemainingBudgetMs() > 6500) {
          attemptEntry.root_cause = `upstream_http_${status}`;
          attemptEntry.message = `Upstream returned HTTP ${status}`;
          continue;
        }

        attemptEntry.ok = status >= 200 && status < 300;
        attemptEntry.root_cause = attemptEntry.ok ? "" : `upstream_http_${status || 0}`;

        resp = r;
        break;
      } catch (e) {
        attemptEntry.root_cause = asString(e?.root_cause).trim() || "upstream_unreachable";
        attemptEntry.message = asString(e?.message || e).trim() || "Upstream request failed";

        // Retry once for unreachable upstream if we still have time budget.
        if (attempt === 1 && getRemainingBudgetMs() > 6500) {
          continue;
        }

        break;
      }
    }

    if (!resp) {
      stage = "upstream_error";
      pushBreadcrumb(stage);

      try {
        await patchCompanyById(container, companyId, existing, {
          company_refresh_lock_until: 0,
        });
      } catch {
        // ignore
      }

      const lastAttempt = attempts.length ? attempts[attempts.length - 1] : null;

      return json({
        ok: false,
        stage: "refresh_company",
        root_cause: asString(lastAttempt?.root_cause).trim() || "upstream_unreachable",
        retryable: true,
        company_id: companyId,
        upstream_status: 0,
        xai_config_source,
        resolved_upstream_host: upstreamMeta.resolved_upstream_host,
        resolved_upstream_path: upstreamMeta.resolved_upstream_path,
        attempts,
        breadcrumbs,
        diagnostics: {
          message: asString(lastAttempt?.message).trim() || "Request failed",
          resolved_xai_endpoint: xaiUrl || null,
          budget_ms: budgetMs,
          remaining_budget_ms: getRemainingBudgetMs(),
        },
        config,
        build_id: String(BUILD_INFO.build_id || ""),
        elapsed_ms: Date.now() - startedAt,
        budget_ms: budgetMs,
        remaining_budget_ms: getRemainingBudgetMs(),
      });
    }

    const getAxiosHeader = (headers, name) => {
      if (!headers || typeof headers !== "object") return "";
      const target = asString(name).toLowerCase();
      const key = Object.keys(headers).find((k) => asString(k).toLowerCase() === target);
      return key ? asString(headers[key]).trim() : "";
    };

    const request_id =
      getAxiosHeader(resp.headers, "x-request-id") ||
      getAxiosHeader(resp.headers, "x-requestid") ||
      getAxiosHeader(resp.headers, "request-id") ||
      getAxiosHeader(resp.headers, "x-correlation-id") ||
      "";

    stage = "parse_xai";
    const responseText =
      resp?.data?.choices?.[0]?.message?.content ||
      (typeof resp?.data === "string" ? resp.data : JSON.stringify(resp.data || {}));

    const upstream_preview = asString(responseText).slice(0, 8000);

    const { value: extractedValue, parse_error } = extractJsonFromText(responseText);
    const normalized = normalizeXaiEnrichmentValue(extractedValue);

    if (normalized.error) {
      stage = "upstream_error";
      await releaseRefreshLockBestEffort();
      pushBreadcrumb(stage, { upstream_status: Number(resp.status) || 0 });
      return json({
        ok: false,
        stage: "refresh_company",
        root_cause: "upstream_error_object",
        retryable: false,
        error: "Upstream returned error",
        upstream_status: Number(resp.status) || 0,
        request_id: request_id || null,
        attempts,
        breadcrumbs,
        diagnostics: {
          upstream_code: normalized.error.code ?? null,
          upstream_message: normalized.error.message || null,
          upstream_preview,
        },
        config,
        build_id: String(BUILD_INFO.build_id || ""),
        elapsed_ms: Date.now() - startedAt,
        budget_ms: budgetMs,
        remaining_budget_ms: getRemainingBudgetMs(),
      });
    }

    if (resp.status < 200 || resp.status >= 300) {
      stage = "upstream_error";
      await releaseRefreshLockBestEffort();
      pushBreadcrumb(stage, { upstream_status: Number(resp.status) || 0 });
      return json({
        ok: false,
        stage: "refresh_company",
        root_cause: `upstream_http_${Number(resp.status) || 0}`,
        retryable: Number(resp.status) >= 500,
        error: `Upstream enrichment failed (HTTP ${Number(resp.status) || "?"})`,
        upstream_status: Number(resp.status) || 0,
        request_id: request_id || null,
        attempts,
        breadcrumbs,
        diagnostics: {
          parse_error: parse_error || null,
          upstream_preview,
        },
        config,
        build_id: String(BUILD_INFO.build_id || ""),
        elapsed_ms: Date.now() - startedAt,
        budget_ms: budgetMs,
        remaining_budget_ms: getRemainingBudgetMs(),
      });
    }

    if (!normalized.company || typeof normalized.company !== "object") {
      stage = "parse_xai";
      await releaseRefreshLockBestEffort();
      pushBreadcrumb(stage, { upstream_status: Number(resp.status) || 0 });
      return json({
        ok: false,
        stage: "refresh_company",
        root_cause: "upstream_bad_response",
        retryable: true,
        error: "No proposed company returned",
        upstream_status: Number(resp.status) || 0,
        request_id: request_id || null,
        attempts,
        breadcrumbs,
        diagnostics: {
          parse_error: parse_error || "No company object found",
          upstream_preview,
        },
        config,
        build_id: String(BUILD_INFO.build_id || ""),
        elapsed_ms: Date.now() - startedAt,
        budget_ms: budgetMs,
        remaining_budget_ms: getRemainingBudgetMs(),
      });
    }

    stage = "build_proposed";
    const proposed = buildProposedCompanyFromXaiResult(normalized.company);

    // Tagline acquisition fix:
    // 1) confirm company name, 2) fetch official tagline for that confirmed name.
    // This is best-effort and must not break the refresh flow.
    stage = "tagline_confirm";
    let tagline_meta = null;
    try {
      const remainingForTagline = getRemainingBudgetMs();
      const taglineTimeout = Math.min(12000, Math.max(4000, remainingForTagline - 1500));

      if (taglineTimeout < 4000) {
        tagline_meta = { status: "skipped_budget" };
      } else {
        const info = await fetchConfirmedCompanyTagline({
          axiosPost,
          xaiUrl,
          xaiKey,
          companyName,
          websiteUrl,
          timeoutMs: taglineTimeout,
        });

        tagline_meta = {
          confirmed_company_name: info.confirmed_company_name,
          confirm_confidence: info.confirm_confidence,
          confirm_reason: info.confirm_reason,
          tagline_confidence: info.tagline_confidence,
          tagline_reason: info.tagline_reason,
        };

        if (info.tagline) {
          proposed.tagline = info.tagline;
        }

        try {
          console.log(
            JSON.stringify({
              stage: "refresh_company_tagline",
              company_id: companyId,
              website_url: websiteUrl,
              input_company_name: companyName,
              confirmed_company_name: info.confirmed_company_name,
              tagline: info.tagline,
              confirm_confidence: info.confirm_confidence,
              tagline_confidence: info.tagline_confidence,
            })
          );
        } catch {
          // ignore
        }
      }
    } catch (e) {
      tagline_meta = {
        error: asString(e?.message || e),
      };
    }

    stage = "done";

    try {
      await patchCompanyById(container, companyId, existing, {
        company_refresh_lock_until: 0,
      });
    } catch {
      // ignore
    }

    pushBreadcrumb("done", { company_id: companyId });

    return json({
      ok: true,
      company_id: companyId,
      elapsed_ms: Date.now() - startedAt,
      budget_ms: budgetMs,
      remaining_budget_ms: getRemainingBudgetMs(),
      xai_config_source,
      resolved_upstream_host: upstreamMeta.resolved_upstream_host,
      resolved_upstream_path: upstreamMeta.resolved_upstream_path,
      proposed,
      upstream_status: Number(resp?.status) || 0,
      request_id: request_id || null,
      attempts,
      breadcrumbs,
      diagnostics: {},
      build_id: String(BUILD_INFO.build_id || ""),
      hints: {
        company_name: companyName,
        website_url: websiteUrl,
        normalized_domain: normalizedDomain,
      },
      enrichment: {
        sources: Array.isArray(normalized.sources) ? normalized.sources : [],
        confidence: normalized.confidence && typeof normalized.confidence === "object" ? normalized.confidence : null,
      },
      ...(tagline_meta ? { tagline_meta } : {}),
    });
  } catch (e) {
    context?.log?.("[admin-refresh-company] error", {
      stage,
      message: e?.message || String(e),
      stack: e?.stack,
    });

    pushBreadcrumb("unhandled_exception");

    return json({
      ok: false,
      stage: "refresh_company",
      root_cause: asString(e?.root_cause).trim() || "unhandled_exception",
      retryable: true,
      error: e?.message || "Internal error",
      attempts,
      breadcrumbs,
      diagnostics: {
        message: asString(e?.message || e).trim() || "Internal error",
      },
      config,
      build_id: String(BUILD_INFO.build_id || ""),
      elapsed_ms: Date.now() - startedAt,
      budget_ms: budgetMs,
      remaining_budget_ms: typeof getRemainingBudgetMs === "function" ? getRemainingBudgetMs() : null,
    });
  }
}

module.exports = {
  adminRefreshCompanyHandler,
  buildProposedCompanyFromXaiResult,
  buildPrompt,
  parseXaiCompaniesResponse,
  loadCompanyById,
  toNormalizedDomain,
};
