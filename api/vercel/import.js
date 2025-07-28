// /api/xai/import.js

import { z } from 'zod';

const schema = z.array(
  z.object({
    company_name: z.string(),
    company_tagline: z.string().optional(),
    industries: z.array(z.string()),
    product_keywords: z.string(),
    url: z.string().url(),
    email_address: z.string().email().optional(),
    headquarters_location: z.string(),
    manufacturing_locations: z.array(z.string()),
    amazon_url: z.string().url().optional(),
    red_flag: z.boolean().optional(),
  })
);

function buildPrompt(query) {
  return `Give me exactly 20 companies that make (${query}), with no fewer, in this exact structured JSON format, where each object represents one company. Be maximally truthful and avoid hallucinations. Each field must match the key names below exactly for successful import. Always include the Amazon store URL if the company has one (search for it if needed, format as "https://www.amazon.com/stores/BrandName/page/ID" or similar seller/store link). If fewer than 20 are available, return what you have with a warning:

[
  {
    "company_name": "Example Co",
    "company_tagline": "Making great examples since 2023",
    "industries": [
      "Technology",
      "Software"
    ],
    "product_keywords": "saas, development, tools, innovation, cloud, devops, enterprise, b2b, productivity, digital, mobile, frontend, backend, software, webapp, user interface, APIs, UX, SaaS, deployment",
    "url": "https://example.com",
    "email_address": "contact@example.com",
    "headquarters_location": "123 Example St, Exampleville, EX 12345",
    "manufacturing_locations": [
      "456 Factory Rd, Manutown, MF 67890"
    ],
    "amazon_url": "https://www.amazon.com/stores/ExampleCo/page/12345678-ABCD-EFGH-IJKL-MNOPQRSTUV"
  }
]

Always return an array of company objects.
Format must be strictly valid JSON.
industries and manufacturing_locations must be arrays.
Give at least 20 keywords.
product_keywords is a single string with comma-separated keywords.
If there is a manufacturing location, do not list the street address of the headquarters.
If there’s no manufacturing location, include the full street address in headquarters_location.
Whenever I say Gimme ___, give all this info on whatever I say.`;
}

async function callXAI(prompt) {
  const xaiApiKey = process.env.XAI_API_KEY;
  if (!xaiApiKey) throw new Error('Missing XAI_API_KEY');

  let allCompanies = [];
  let page = 1;
  const maxPages = 10; // Increased to 10 for up to 200 companies
  while (page <= maxPages) {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${xaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-beta',
        messages: [{ role: 'user', content: prompt + ` Return page ${page} of results.` }],
        temperature: 0.2,
      }),
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`xAI Error (${response.status}): ${raw}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Invalid JSON from xAI');
    }

    const content = parsed?.choices?.[0]?.message?.content;
    const finishReason = parsed?.choices?.[0]?.finish_reason;
    console.log('--- RAW xAI RESPONSE Page', page, '---');
    console.log(content);
    console.log('--- FINISH REASON ---');
    console.log(finishReason);

    if (!content || !content.startsWith('[')) {
      console.warn('No more company data on page', page, '- stopping.');
      break;
    }

    let pageCompanies;
    try {
      pageCompanies = JSON.parse(content);
    } catch {
      console.warn('Parsing error on page', page, '- skipping.');
      page++;
      continue;
    }

    allCompanies = [...allCompanies, ...pageCompanies];
    if (pageCompanies.length < 5) break; // Stop if fewer than 5 per page to avoid empty loops
    page++;
  }

  try {
    const validated = schema.parse(allCompanies);
    return validated;
  } catch (e) {
    console.error('VALIDATION OR PARSE ERROR:', e);
    throw new Error('Failed to parse or validate xAI response');
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid query' });
  }

  try {
    const prompt = buildPrompt(query);
    const companies = await callXAI(prompt);
    console.log(`✅ IMPORT SUCCESS: ${companies.length} companies via xAI`);
    return res.status(200).json({ companies });
  } catch (error) {
    console.error('IMPORT ERROR:', error);
    return res.status(500).json({ error: error.message || 'Unknown error' });
  }
}