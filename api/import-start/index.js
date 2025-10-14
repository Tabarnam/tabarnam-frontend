const { httpRequest } = require('../_http');
const { getProxyBase, json } = require('../_shared');

module.exports = async function (context, req) {
  const method = String(req.method || '').toUpperCase();
  if (method === 'OPTIONS') {
    context.res = {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'content-type,x-functions-key'
      }
    };
    return;
  }

  const base = getProxyBase();

  if (base) {
    try {
      const out = await httpRequest('POST', `${base}/import/start`, {
        headers: { 'content-type': 'application/json' },
        body: req.body || {}
      });
      let body = out.body;
      try { body = JSON.parse(out.body); } catch {}
      if (out.status >= 200 && out.status < 300) return json(context, out.status, body);
      return json(context, out.status || 502, { ok: false, error: body || 'Upstream error' });
    } catch (e) {
      return json(context, 502, { ok: false, error: `Proxy error: ${e.message || String(e)}` });
    }
  }

  // Stub
  const session_id = `stub_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return json(context, 200, { ok: true, session_id, note: 'XAI_PROXY_BASE not set; stub mode.' });
};
