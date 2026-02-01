/**
 * Get XAI Search Endpoint
 * Consolidated approach: XAI_EXTERNAL_BASE is primary, FUNCTION_URL is fallback (deprecated)
 * Avoids loops where FUNCTION_URL points to /api/xai (diagnostic endpoint)
 */
function normalizeXaiBaseUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";

  const u = tryParseUrl(s);
  if (!u) return s;

  const hostLower = String(u.hostname || "").toLowerCase();
  const pathLower = String(u.pathname || "").toLowerCase().replace(/\/+$/, "");

  // Note: some deployments expose OpenAI-compatible routes under /api/v1/chat/completions.
  // Do not automatically rewrite "/api" to "/api/xai"; that breaks those deployments.

  return s;
}

function getXAIEndpoint() {
  const candidates = [
    process.env.XAI_EXTERNAL_BASE,
    process.env.XAI_INTERNAL_BASE, // alias
    process.env.XAI_UPSTREAM_BASE,
    process.env.XAI_BASE,
  ];

  for (const c of candidates) {
    const raw = String(c || "").trim();
    const normalized = normalizeXaiBaseUrl(raw);
    if (normalized) return normalized;
  }

  const fnUrl = (process.env.FUNCTION_URL || "").trim();
  if (fnUrl) {
    const lower = fnUrl.toLowerCase();
    const isLikelyLocal = !/^https?:\/\//i.test(fnUrl) || lower.includes("localhost") || lower.includes("127.0.0.1");

    // Avoid loops where FUNCTION_URL points back at this app's own diagnostic endpoint.
    if (isLikelyLocal && lower.includes("/api/xai")) return "";

    return normalizeXaiBaseUrl(fnUrl);
  }

  return "";
}

function tryParseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    return new URL(s);
  } catch {
    try {
      return new URL(`https://${s}`);
    } catch {
      return null;
    }
  }
}

function joinUrlPath(basePath, suffixPath) {
  const a = String(basePath || '').trim();
  const b = String(suffixPath || '').trim();
  if (!a) return b.startsWith('/') ? b : `/${b}`;
  if (!b) return a;

  const left = a.endsWith('/') ? a.slice(0, -1) : a;
  const right = b.startsWith('/') ? b : `/${b}`;

  return `${left}${right}`.replace(/\/{2,}/g, '/');
}

function resolveXaiEndpointForModel(rawEndpoint, model) {
  let raw = String(rawEndpoint || '').trim();

  // Normalize missing scheme so diagnostics always show a full URL.
  // Only apply when the value looks like a hostname (avoid breaking proxies/relative paths).
  if (raw && !/^https?:\/\//i.test(raw) && /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(\/.*)?$/i.test(raw)) {
    raw = `https://${raw}`;
  }

  const u = tryParseUrl(raw);
  if (!u) return raw;

  const pathLower = String(u.pathname || '').toLowerCase();

  // If a full endpoint is already configured, leave it alone.
  if (pathLower.includes('/proxy-xai') || pathLower.includes('/api/xai')) return u.toString();

  const alreadyChat = /\/v1\/chat\/completions\/?$/i.test(u.pathname || '');
  const alreadyResponses = /\/v1\/responses\/?$/i.test(u.pathname || '');
  if (alreadyChat || alreadyResponses) return u.toString();

  // xAI deprecated /chat/completions (returns 410 Gone). Use /responses for all models.
  const desiredSuffix = '/v1/responses';

  let basePath = String(u.pathname || '').replace(/\/+$/, '');

  // Prevent common misconfiguration: https://api.x.ai/api (xAI does not use /api).
  // Only apply this normalization to the real xAI hostname so we don't break custom proxies.
  if (String(u.hostname || '').toLowerCase() === 'api.x.ai') {
    const lower = basePath.toLowerCase();
    if (lower === '/api') basePath = '';
    else if (lower.endsWith('/api')) basePath = basePath.slice(0, -4);
    else if (lower.endsWith('/api/v1')) basePath = basePath.slice(0, -7);
  }

  if (basePath.toLowerCase().endsWith('/v1')) basePath = basePath.slice(0, -3);
  u.pathname = joinUrlPath(basePath || '', desiredSuffix);

  return u.toString();
}

/**
 * Get XAI API Key
 * Hardened version: ONLY returns explicit xAI env vars.
 * NEVER falls back to FUNCTION_KEY or internal auth secrets.
 * Detects and refuses common "wrong key" patterns (Azure host keys, URLs).
 */
function getXAIKey() {
  // Only allow explicit xAI env vars. Never use FUNCTION_KEY (Azure host key) as an API credential.
  const raw =
    (process.env.XAI_API_KEY || process.env.XAI_EXTERNAL_KEY || "").trim();

  if (!raw) return "";

  // Hard guardrails:
  // 1) Azure Functions host keys often start with "xm" and end with "=="
  // 2) Many internal tokens are long base64-ish strings ending with "=="
  // We refuse anything that looks like a Functions host key or accidental internal secret.
  const looksLikeAzureFunctionKey =
    /^xm[A-Za-z0-9+/]{10,}={0,2}$/.test(raw) || /={2}$/.test(raw);

  // Additional heuristic: if user accidentally copied a URL or included whitespace/newlines
  const looksLikeUrl = /^https?:\/\//i.test(raw);

  if (looksLikeUrl || looksLikeAzureFunctionKey) {
    // Do not leak the key. Only log shape and length.
    console.error("[config] getXAIKey(): Refusing suspicious XAI key value.", {
      reason: looksLikeUrl ? "looks_like_url" : "looks_like_azure_function_key",
      len: raw.length,
      startsWith: raw.slice(0, 2),
      endsWith: raw.slice(-2),
      hasWhitespace: /\s/.test(raw),
      env_present: {
        has_XAI_API_KEY: Boolean((process.env.XAI_API_KEY || "").trim()),
        has_XAI_EXTERNAL_KEY: Boolean((process.env.XAI_EXTERNAL_KEY || "").trim()),
        // This is only for diagnostics, NOT used for XAI.
        has_FUNCTION_KEY: Boolean((process.env.FUNCTION_KEY || "").trim()),
      },
    });

    return "";
  }

  return raw;
}

function getResolvedUpstreamMeta(rawUrl) {
  const raw = String(rawUrl || "").trim();
  if (!raw) return { resolved_upstream_host: null, resolved_upstream_path: null };
  try {
    const u = tryParseUrl(raw);
    if (!u) return { resolved_upstream_host: null, resolved_upstream_path: null };
    return {
      resolved_upstream_host: String(u.hostname || "") || null,
      resolved_upstream_path: String(u.pathname || "") || null,
    };
  } catch {
    return { resolved_upstream_host: null, resolved_upstream_path: null };
  }
}

/**
 * Get Proxy Base (external API base URL)
 * Used for endpoints like logo-scrape
 */
function getProxyBase() {
  const primary = (process.env.XAI_PROXY_BASE || "").trim();
  if (primary) return primary;

  const candidates = [process.env.XAI_EXTERNAL_BASE, process.env.XAI_INTERNAL_BASE, process.env.XAI_BASE];
  for (const c of candidates) {
    const raw = String(c || "").trim();
    if (raw) return raw;
  }

  return "";
}

function json(context, status, obj, extraHeaders) {
  context.res = {
    status,
    headers: Object.assign(
      {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "content-type,x-functions-key",
      },
      extraHeaders || {}
    ),
    body: JSON.stringify(obj),
  };
  return context.res;
}

/**
 * Safe sharp loader - never throws
 * Returns { sharp, reason } where:
 * - sharp is the loaded module or null if unavailable
 * - reason is an error message if sharp failed to load, empty string if success
 */
function tryLoadSharp() {
  try {
    const sharp = require("sharp");
    return { sharp, reason: "" };
  } catch (e) {
    const msg = (e && (e.message || String(e))) || "unknown error";
    return { sharp: null, reason: msg };
  }
}

module.exports = {
  getXAIEndpoint,
  getXAIKey,
  getResolvedUpstreamMeta,
  getProxyBase,
  resolveXaiEndpointForModel,
  json,
  tryLoadSharp,
};
