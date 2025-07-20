// /api/xai/import.js

import { OpenAI } from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const systemPrompt = `
You are a research assistant. Return ONLY a JSON array of companies that make the requested product.
Each company must have the following schema exactly:

{
  "company_name": "Company Name",
  "company_tagline": "One sentence tagline",
  "industries": ["Industry1", "Industry2"],
  "product_keywords": "comma,separated,list,of,at,least,20,keywords",
  "url": "https://example.com",
  "email_address": "contact@example.com",
  "headquarters_location": "City, ST",
  "manufacturing_locations": ["City, ST", "Country"],
  "red_flag": false
}

If you are not sure about a value, still return the field with a placeholder and set red_flag to true.
Always return an array of at least 20 companies if possible.
`;

const MAX_BATCHES = 5;
const MIN_COMPANIES = 50;

async function callOpenAI(query) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Give me 20+ companies that make ${query}` },
  ];

  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages,
    temperature: 0.2,
    max_tokens: 3500,
  });

  const finishReason = completion.choices?.[0]?.finish_reason;
  const rawText = completion.choices?.[0]?.message?.content?.trim();

  console.log(`RAW OpenAI text (truncated): ${rawText?.slice(0, 300)}...`);
  console.log(`Finish reason: ${finishReason}`);

  if (!rawText) throw new Error('No content returned from OpenAI');

  try {
    // Try direct JSON.parse
    const parsed = JSON.parse(rawText);
    if (!Array.isArray(parsed)) throw new Error('Not an array');
    return parsed;
  } catch (err) {
    console.warn('Initial JSON parse failed, attempting fallback…');

    const match = rawText.match(/\[\s*{[\s\S]+}\s*\]/);
    if (match) {
      try {
        const fallbackParsed = JSON.parse(match[0]);
        return fallbackParsed;
      } catch (fallbackError) {
        throw new Error('Fallback JSON parse failed');
      }
    }

    console.error('OpenAI returned malformed JSON:', rawText);
    throw new Error('Could not parse array from OpenAI');
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid query' });
  }

  try {
    const allCompanies = [];
    const seenNames = new Set();

    for (let i = 0; i < MAX_BATCHES && allCompanies.length < MIN_COMPANIES; i++) {
      const batch = await callOpenAI(query);
      const unique = batch.filter(
        (c) => c?.company_name && !seenNames.has(c.company_name)
      );
      unique.forEach((c) => seenNames.add(c.company_name));
      allCompanies.push(...unique);

      console.log(`✅ Batch ${i + 1}: got ${unique.length} unique companies`);
    }

    console.log(`🎯 Total companies returned: ${allCompanies.length}`);
    return res.status(200).json({ companies: allCompanies });
  } catch (err) {
    console.error('IMPORT ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
