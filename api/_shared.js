function getProxyBase() {
  // Read from SWA app settings (you already set XAI_PROXY_BASE)
  const v = process.env.XAI_PROXY_BASE || '';
  return v.trim() || '';
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

module.exports = { getProxyBase, json };
