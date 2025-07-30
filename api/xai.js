// api/xai.js
import axios from 'axios';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid query' });
  }

  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    const startTime = Date.now();
    console.log(`Processing query: ${query} at ${new Date(startTime).toISOString()}`);
    const prompt = buildPrompt(query, 1);
    const response = await axios.post('https://api.x.ai/v1/chat/completions', {
      model: 'grok-4-latest',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }, {
      headers: { 'Authorization': `Bearer ${process.env.XAI_API_KEY}` },
      timeout: 290000, // 290 seconds, just under 300s max
    });

    const content = response.data.choices[0].message.content;
    console.log('--- RAW xAI RESPONSE ---');
    console.log(content);

    if (!content || !content.startsWith('[')) {
      console.warn('No valid company data - stopping.');
      return res.status(200).json({ companies: [] });
    }

    let companies;
    try {
      companies = JSON.parse(content);
    } catch (e) {
      console.warn('Parsing error:', e.message);
      return res.status(500).json({ error: 'Invalid response format' });
    }

    // Append Amazon affiliate tag
    companies = companies.map(company => {
      if (company.amazon_url) {
        company.amazon_url = `${company.amazon_url}?tag=tabarnam-20`;
      }
      return company;
    });

    console.log(`Companies Count: ${companies.length}`);
    const totalDuration = Date.now() - startTime;
    console.log(`✅ IMPORT SUCCESS: ${companies.length} companies, total duration: ${totalDuration}ms`);
    return res.status(200).json({ companies });
  } catch (error) {
    console.error('IMPORT ERROR:', error.message);
    if (error.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'Request timed out, consider queuing' });
    }
    return res.status(500).json({ error: error.message });
  }
}

function buildPrompt(query, page) {
  return `Provide exactly 3 unique companies that make products related to (${query}) for page ${page}, with no fewer, in this exact structured JSON format, where each object represents one company. Include detailed research and evaluate customer reviews from multiple sources (e.g., Google, industry reports) to assess quality and reliability, adding a 'reviews' array with up to 5 entries per company (source, URL, abstract). Be maximally truthful and avoid hallucinations. Each field must match the key names below exactly for successful import. Always include the Amazon store URL if the company has one (search for it, format as "https://www.amazon.com/stores/BrandName/page/ID"). If fewer than 3 are available, return what you have with a warning:

[
  {
    "company_name": "Example Co",
    "company_tagline": "Making great examples since 2023",
    "industries": ["Technology", "Software"],
    "product_keywords": "saas, development, tools, innovation, cloud, devops, enterprise, b2b, productivity, digital, mobile, frontend, backend, software, webapp, user interface, APIs, UX, SaaS, deployment",
    "url": "https://example.com",
    "email_address": "contact@example.com",
    "headquarters_location": "123 Example St, Exampleville, EX 12345",
    "manufacturing_locations": ["456 Factory Rd, Manutown, MF 67890"],
    "amazon_url": "https://www.amazon.com/stores/ExampleCo/page/12345678-ABCD-EFGH-IJKL-MNOPQRSTUV",
    "reviews": [
      {"source": "Google", "url": "https://www.google.com/review", "abstract": "Great service, 4 stars."}
    ]
  }
]

Always return an array of company objects.
Format must be strictly valid JSON.
industries and manufacturing_locations must be arrays.
Give at least 10 keywords.
product_keywords is a single string with comma-separated keywords.
If there is a manufacturing location, do not list the street address of the headquarters.
If there’s no manufacturing location, include the full street address in headquarters_location.
Whenever I say Gimme ___, give all this info on whatever I say for page ${page}.`;
}