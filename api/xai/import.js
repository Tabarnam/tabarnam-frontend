export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query } = req.body;

  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return res.status(400).json({ error: 'Missing or invalid search query' });
  }

  const promptBase = (keyword) => `
You are a professional research assistant.
Search real companies based on this input: "${keyword}".

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
- If any required field (name, url) is missing or unverifiable, set "red_flag": true.
- Only return verified or verifiable companies.
`;

  const fetchCompaniesFromOpenAI = async (keyword) => {
    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: 'POST',
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.2,
        stream: false,
        max_tokens: 3000,
        messages: [
          {
            role: "system",
            content: "You return verified companies only. You output strict JSON arrays. You never fake data."
          },
          {
            role: "user",
            content: promptBase(keyword)
          }
        ]
      })
    });

    const result = await openaiResponse.json();
    const rawContent = result.choices?.[0]?.message?.content;
    const finishReason = result.choices?.[0]?.finish_reason;

    console.log('🔍 OpenAI finish_reason:', finishReason);
    console.log('📝 Response length:', rawContent?.length || 0);

    if (!rawContent) {
      throw new Error('No content returned from OpenAI');
    }

    let jsonBlock;
    if (rawContent.trim().startsWith('[')) {
      jsonBlock = rawContent.trim();
    } else {
      const markdownMatch = rawContent.match(/```json\s*([\s\S]*?)```/i);
      const arrayMatch = rawContent.match(/\[\s*{[\s\S]+}\s*\]/);

      if (markdownMatch && markdownMatch[1]) {
        jsonBlock = markdownMatch[1];
      } else if (arrayMatch) {
        jsonBlock = arrayMatch[0];
      }
    }

    if (!jsonBlock) {
      throw new Error('Could not extract JSON array from OpenAI response');
    }

    let parsedCompanies;
    try {
      parsedCompanies = JSON.parse(jsonBlock);
    } catch (err) {
      throw new Error('Failed to parse JSON: ' + err.message);
    }

    return parsedCompanies.map(company => {
      const hasName = typeof company.company_name === 'string' && company.company_name.trim().length > 2;
      const hasURL = typeof company.url === 'string' && company.url.startsWith('http');
      const has20Keywords = company.product_keywords?.split(',').length >= 20;

      const isRedFlag = !hasName || !hasURL || !has20Keywords;

      return {
        ...company,
        red_flag: isRedFlag
      };
    });
  };

  try {
    let totalCompanies = [];
    const maxTries = 5;

    for (let i = 0; i < maxTries && totalCompanies.length < 50; i++) {
      console.log(`🔁 Fetch attempt ${i + 1}...`);
      const newBatch = await fetchCompaniesFromOpenAI(query);
      const newUnique = newBatch.filter(
        (incoming) => !totalCompanies.some(
          (existing) => existing.url === incoming.url || existing.company_name === incoming.company_name
        )
      );
      totalCompanies.push(...newUnique);
    }

    console.log('✅ Total companies returned:', totalCompanies.length);

    return res.status(200).json({
      total_returned: totalCompanies.length,
      companies: totalCompanies
    });

  } catch (error) {
    console.error('❌ IMPORT LOOP ERROR:', error);
    return res.status(500).json({ error: error.message });
  }
}
