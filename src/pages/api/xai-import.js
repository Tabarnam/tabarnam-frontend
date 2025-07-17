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
