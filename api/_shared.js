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

module.exports = { getXAIEndpoint, getXAIKey, getProxyBase, json };
