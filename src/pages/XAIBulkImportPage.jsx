// File: /api/xai/import.js

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  try {
    const { query } = await req.json();

    if (!query || query.trim() === '') {
      return new Response(JSON.stringify({ error: 'No query provided' }), {
        status: 400,
      });
    }

    const apiKey = process.env.XAI_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Missing XAI_KEY' }), {
        status: 500,
      });
    }

    const prompt = `List 50 real companies that manufacture or sell ${query}. For each company, provide:
- Name
- Tagline
- Industries (array)
- Product keywords (comma-separated)
- Website URL
- Email
- Headquarters location (city, state, country)
- Manufacturing location(s) (array of countries or cities)

Only include real and verifiable companies. Reply in raw JSON format as an array of objects using these exact keys:
company_name, company_tagline, industries, product_keywords, url, email_address, headquarters_location, manufacturing_locations`;

    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'xai-knowledge',
        messages: [
          { role: 'system', content: 'You are a business research assistant.' },
          { role: 'user', content: prompt },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('xAI ERROR:', data);
      return new Response(JSON.stringify({ error: data.error || 'xAI request failed' }), {
        status: 500,
      });
    }

    const content = data.choices?.[0]?.message?.content;

    if (!content || !content.includes('{') && !content.includes('[')) {
      return new Response(JSON.stringify({ error: 'No content returned from xAI' }), {
        status: 500,
      });
    }

    // Attempt to parse the JSON blob returned by xAI
    let companies;
    try {
      companies = JSON.parse(content.trim());
    } catch (parseErr) {
      console.error('JSON PARSE ERROR:', parseErr, content);
      return new Response(JSON.stringify({ error: 'Failed to parse xAI JSON' }), {
        status: 500,
      });
    }

    if (!Array.isArray(companies) || companies.length === 0) {
      return new Response(JSON.stringify({ error: 'Parsed content is not a company array' }), {
        status: 500,
      });
    }

    // TODO: Save companies to Supabase here (or return them to frontend for review)

    return new Response(JSON.stringify({ success: true, companies }), {
      status: 200,
    });

  } catch (err) {
    console.error('IMPORT CATCH ERROR:', err);
    return new Response(JSON.stringify({ error: err.message || 'Unhandled error' }), {
      status: 500,
    });
  }
}
