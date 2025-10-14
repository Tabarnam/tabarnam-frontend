const { httpRequest } = require('../_http');
const { getProxyBase, json } = require('../_shared');

module.exports = async function (context, req) {
  const method = String(req.method || '').toUpperCase();
  if (method === 'OPTIONS') {
    return json(context, 204, {}, { 'Access-Control-Max-Age': '86400' });
  }

  const base = getProxyBase();
  const body = req.body || {};
  const domain = (body.domain || '').trim();
  if (!domain) return json(context, 400, { ok: false, error: 'Missing domain' });

  if (base) {
    try {
      const out = await httpRequest('POST', `${base}/logo-scrape`, { body: { domain } });
      let b = out.body; try { b = JSON.parse(out.body); } catch {}
      return json(context, out.status || 502, b);
    } catch (e) {
      return json(context, 502, { ok: false, error: `Proxy error: ${e.message || String(e)}` });
    }
  }

  // Stub
  return json(context, 200, {
    ok: true,
    domain,
    logo_url: `https://logo.clearbit.com/${encodeURIComponent(domain)}`
  });
};
