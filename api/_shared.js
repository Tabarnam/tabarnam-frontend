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

  const m = String(model || '').toLowerCase();
  const wantsResponses = m.includes('vision') || m.includes('image') || m.includes('audio');
  const desiredSuffix = wantsResponses ? '/v1/responses' : '/v1/chat/completions';

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
 * Tries multiple env vars for backwards compatibility
 */
function getXAIKey() {
  // Prefer the consolidated key vars first.
  // IMPORTANT: if an external key is present, legacy vars must NOT override it.
  const primary = (process.env.XAI_API_KEY || process.env.XAI_EXTERNAL_KEY || process.env.FUNCTION_KEY || "").trim();
  if (primary) return primary;

  // Legacy fallback (only used when consolidated vars are missing).
  return (process.env.XAI_KEY || "").trim();
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

module.exports = {
  getXAIEndpoint,
  getXAIKey,
  getResolvedUpstreamMeta,
  getProxyBase,
  resolveXaiEndpointForModel,
  json,
};
