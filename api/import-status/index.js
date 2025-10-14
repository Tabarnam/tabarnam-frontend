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
  const q = req.query || {};
  const session_id = (q.session_id || '').trim();
  const take = Number(q.take || 10) || 10;

  if (!session_id) return json(context, 400, { ok: false, error: 'Missing session_id' });

  if (base) {
    try {
      const url = `${base}/import/status?session_id=${encodeURIComponent(session_id)}&take=${encodeURIComponent(take)}`;
      const out = await httpRequest('GET', url);
      let body = out.body;
      try { body = JSON.parse(out.body); } catch {}
      if (out.status >= 200 && out.status < 300) return json(context, out.status, body);
      return json(context, out.status || 502, { ok: false, error: body || 'Upstream error' });
    } catch (e) {
      return json(context, 502, { ok: false, error: `Proxy error: ${e.message || String(e)}` });
    }
  }

  // Stub
  return json(context, 200, {
    ok: true,
    session_id,
    items: [
      {
        id: `c_${Math.random().toString(36).slice(2)}`,
        company_name: 'Stub Candle Co.',
        url: 'https://example.com',
        industries: ['Consumer Goods'],
        product_keywords: 'candles, aromatherapy',
        confidence_score: 0.82
      }
    ],
    complete: false
  });
};
