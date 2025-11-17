export function getProxyBase() {
  const primary = (process.env.XAI_PROXY_BASE || '').trim();
  if (primary) return primary;

  const external = (process.env.XAI_EXTERNAL_BASE || '').trim();
  if (external) return external;

  return '';
}

export function json(context, status, obj, extraHeaders) {
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
