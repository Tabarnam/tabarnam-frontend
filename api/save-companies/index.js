const { httpRequest } = require('../_http');
const { getProxyBase, json } = require('../_shared');

module.exports = async function (context, req) {
  const method = String(req.method || '').toUpperCase();
  
  // CORS preflight
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

  if (method !== 'POST') {
    return json(context, 405, { ok: false, error: 'Method not allowed' });
  }

  const base = getProxyBase();

  if (base) {
    // If proxy available, use it
    try {
      const out = await httpRequest('POST', `${base}/save-companies`, {
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

  // Direct Cosmos DB write
  try {
    const { CosmosClient } = require('@azure/cosmos');
    
    const endpoint = (process.env.COSMOS_DB_ENDPOINT || "").trim();
    const key = (process.env.COSMOS_DB_KEY || "").trim();
    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = (process.env.COSMOS_DB_CONTAINER || "companies").trim();

    if (!endpoint || !key) {
      return json(context, 500, { ok: false, error: 'Cosmos DB not configured' });
    }

    const companies = req.body?.companies || [];
    if (!Array.isArray(companies) || companies.length === 0) {
      return json(context, 400, { ok: false, error: 'companies array required' });
    }

    const client = new CosmosClient({ endpoint, key });
    const database = client.database(databaseId);
    const container = database.container(containerId);

    let saved = 0;
    let failed = 0;
    const errors = [];
    const sessionId = `manual_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    for (const company of companies) {
      try {
        const doc = {
          id: `company_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          company_name: company.company_name || company.name || '',
          name: company.name || company.company_name || '',
          url: company.url || '',
          website_url: company.url || '',
          industries: company.industries || [],
          product_keywords: company.product_keywords || '',
          source: 'manual_import',
          session_id: sessionId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        if (!doc.company_name && !doc.url) {
          failed++;
          errors.push(`Skipped entry: no company_name or url`);
          continue;
        }

        await container.items.create(doc);
        saved++;
      } catch (e) {
        failed++;
        errors.push(`Failed to save "${company.company_name || company.name}": ${e.message}`);
      }
    }

    return json(context, 200, {
      ok: true,
      saved,
      failed,
      total: companies.length,
      session_id: sessionId,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (e) {
    return json(context, 500, { ok: false, error: `Database error: ${e.message || String(e)}` });
  }
};
