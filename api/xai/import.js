export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  try {
    const { query } = await req.json();

    if (!query || typeof query !== 'string' || query.trim().length < 2) {
      return new Response(JSON.stringify({ error: 'Missing or invalid search query' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Missing XAI_API_KEY' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const fullPrompt = `
You are a professional research assistant.
Search real companies based on this input: "${query}".

Return companies in this JSON format (as a single array):
[
  {
    "company_name": "",
    "company_tagline": "",
    "industries": [],
    "product_keywords": "",
    "url": "",
    "email_address": "",
    "headquarters_location": "",
    "manufacturing_locations": [],
    "amazon_url": "",
    "red_flag": false
  }
]

Guidelines:
- All companies must be real and verifiable.
- Website must be live (not parked or broken).
- Industries must be an array of 1–3 words each.
- Keywords must be at least 20 comma-separated values.
- Do not include placeholder text.
- If email or manufacturing location is missing, that’s OK.
- If any required field (name, url) is missing or unverifiable, set "red_flag" to true.
- Only return verified or verifiable companies.
`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4',
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: 'You return verified companies only. You output strict JSON arrays. You never fake data.',
          },
          {
            role: 'user',
            content: fullPrompt,
          },
        ],
      }),
    });

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content;

    if (!raw) {
      return new Response(JSON.stringify({ error: 'No content returned from xAI' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const match = raw.match(/\[\s*{[\s\S]+?}\s*]/);
    const jsonBlock = match ? match[0] : null;

    if (!jsonBlock) {
      return new Response(JSON.stringify({ error: 'Could not parse company list from xAI response' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let parsed = [];
    try {
      parsed = JSON.parse(jsonBlock);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'JSON parse failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const validated = parsed.map((company) => {
      const hasName = typeof company.company_name === 'string' && company.company_name.trim().length > 2;
      const hasURL = typeof company.url === 'string' && company.url.startsWith('http');
      const has20Keywords = company.product_keywords?.split(',').length >= 20;
      return {
        ...company,
        red_flag: !hasName || !hasURL || !has20Keywords,
      };
    });

    return new Response(
      JSON.stringify({
        total_returned: validated.length,
        companies: validated,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Internal error: ' + err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
