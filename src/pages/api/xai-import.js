export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query } = req.body;

  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return res.status(400).json({ error: 'Missing or invalid search query' });
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

  try {
    const xaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4',
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'You return verified companies only. You output strict JSON arrays. You never fake data.' },
          { role: 'user', content: fullPrompt }
        ]
      }),
    });

    const result = await xaiResponse.json();
    const rawContent = result.choices?.[0]?.message?.content;

    if (!rawContent) {
      return res.status(500).json({ error: 'No content returned from xAI' });
    }

    const match = rawContent.match(/\[\s*{[\s\S]+}\s*\]/);
    const jsonBlock = match ? match[0] : null;

    if (!jsonBlock) {
      return res.status(500).json({ error: 'Could not parse company list from xAI response' });
    }

    const parsedCompanies = JSON.parse(jsonBlock);

    const validatedCompanies = parsedCompanies.map(company => {
      const hasName = typeof company.company_name === 'string' && company.company_name.trim().length > 2;
      const hasURL = typeof company.url === 'string' && company.url.startsWith('http');
      const has20Keywords = company.product_keywords?.split(',').length >= 20;

      const isRedFlag = !hasName || !hasURL || !has20Keywords;

      return {
        ...company,
        red_flag: isRedFlag
      };
    });

    return res.status(200).json({
      total_returned: validatedCompanies.length,
      companies: validatedCompanies
    });

  } catch (error) {
    console.error('xAI error:', error);
    return res.status(500).json({ error: 'Failed to fetch company data from xAI' });
  }
}
