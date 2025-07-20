export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query } = req.body;

  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return res.status(400).json({ error: 'Missing or invalid search query' });
  }

  const buildPrompt = (keyword) => `
You are a professional business data researcher.

Search real companies based on this input: "${keyword}"

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
- Industries must be 1–3 words each.
- product_keywords must contain 20+ comma-separated values.
- Do not use placeholder data.
- If name or URL is missing, set "red_flag": true.
- If email or manufacturing location is missing, that’s OK.
- Only return verified or verifiable companies.
- Return at least 20 companies per batch.
`;

  const callOpenAI = async (keyword) => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        temperature: 0.2,
        max_tokens: 3000,
        messages: [
          {
            role: 'system',
            content: 'You only return strict JSON. You never fake data. You return companies only.',
          },
          {
            role: 'user',
            content: buildPrompt(keyword),
          },
        ],
      }),
    });

    const result = await res.json();
    const content = result.choices?.[0]?.message?.content;
    const finish = result.choices?.[0]?.finish_reason;

    console.log('🔁 OpenAI finish_reason:', finish);
    console.log('📝 Raw content length:', content?.length || 0);

    let jsonBlock;

    // Extract markdown JSON block if present
    const markdownMatch = content?.match(/```json\s*([\s\S]*?)```/i);
    if (markdownMatch?.[1]) {
      jsonBlock = markdownMatch[1];
    }

    // Fallback: extract any JSON array manually
    if (!jsonBlock) {
      const arrayMatch = content?.match(/\[\s*{[\s\S]*?}\s*\]/);
      if (arrayMatch) {
        jsonBlock = arrayMatch[0];
      }
    }

    // Still nothing? throw
    if (!jsonBlock) {
      console.error('❌ No JSON array found in content:', content?.slice(0, 500));
      throw new Error('Could not parse array from OpenAI');
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonBlock);
    } catch (err) {
      console.error('❌ Failed JSON parse:', err.message);
      console.error('🧩 Problem snippet:', jsonBlock.slice(0, 500));
      throw new Error('OpenAI returned invalid JSON: ' + err.message);
    }

    const cleaned = parsed.map((c) => {
      const hasName = typeof c.company_name === 'string' && c.company_name.length > 2;
      const hasUrl = typeof c.url === 'string' && c.url.startsWith('http');
      const hasKeywords = typeof c.product_keywords === 'string' && c.product_keywords.split(',').length >= 20;

      return {
        ...c,
        red_flag: !hasName || !hasUrl || !hasKeywords,
      };
    });

    console.log(`✅ OpenAI returned ${cleaned.length} companies`);
    return cleaned;
  };

  try {
    let all = [];
    cons
