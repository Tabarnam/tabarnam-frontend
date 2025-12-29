/**
 * Get XAI Search Endpoint
 * Consolidated approach: XAI_EXTERNAL_BASE is primary, FUNCTION_URL is fallback (deprecated)
 * Avoids loops where FUNCTION_URL points to /api/xai (diagnostic endpoint)
 */
function getXAIEndpoint() {
  const external = (process.env.XAI_EXTERNAL_BASE || '').trim();
  if (external) return external;

  const fnUrl = (process.env.FUNCTION_URL || '').trim();
  // Avoid using /api/xai - it's a diagnostic endpoint, not a real XAI search
  if (fnUrl && !fnUrl.includes('/api/xai')) return fnUrl;

  return '';
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
  // Prefer XAI_API_KEY to match direct upstream calls (PowerShell sanity tests),
  // but keep backwards-compat with older variable names.
  return (process.env.XAI_API_KEY || process.env.XAI_EXTERNAL_KEY || process.env.FUNCTION_KEY || '').trim();
}

/**
 * Get Proxy Base (external API base URL)
 * Used for endpoints like logo-scrape
 */
function getProxyBase() {
  const primary = (process.env.XAI_PROXY_BASE || '').trim();
  if (primary) return primary;

  const external = (process.env.XAI_EXTERNAL_BASE || '').trim();
  if (external) return external;

  return '';
}

function json(context, status, obj, extraHeaders) {
  context.res = {
    status,
    headers: Object.assign(
      {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'content-type,x-functions-key'
      },
      extraHeaders || {}
    ),
    body: JSON.stringify(obj)
  };
  return context.res;
}

module.exports = { getXAIEndpoint, getXAIKey, getProxyBase, resolveXaiEndpointForModel, json };
