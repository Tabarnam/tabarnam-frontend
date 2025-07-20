// /api/xai/import.js

import { OpenAI } from 'openai';
import { z } from 'zod';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
    red_flag: z.boolean().optional(),
  })
);

function buildPrompt(query) {
  return `Give me 50 companies that make (${query}), provide data for each company in this exact structured JSON format, where each object represents one company. Each field must match the key names below exactly for successful import:
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
    ]
  }
]

Always return an array of company objects.
Format must be strictly valid JSON.
industries and manufacturing_locations must be arrays.
Give at least 20 Keywords
product_keywords is a single string with comma-separated keywords.
If there is a manufacturing location, Do not list the street address of the headquarters.
If there’s no manufacturing location, then include the full street address in headquarters_location.
Whenever I say Gimme ___, give all this info on whatever I say.`;
}

async function callOpenAI(prompt) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    response_format: 'json',
  });

  const raw = completion.choices?.[0]?.message?.content;
  const finishReason = completion.choices?.[0]?.finish_reason;
  console.log('--- RAW OPENAI RESPONSE ---');
  console.log(raw);
  console.log('--- FINISH REASON ---');
  console.log(finishReason);

  if (!raw || !raw.startsWith('[')) {
    throw new Error('Could not parse array from OpenAI');
  }

  try {
    const parsed = JSON.parse(raw);
    const validated = schema.parse(parsed);
    return validated;
  } catch (e) {
    console.error('VALIDATION OR PARSE ERROR:', e);
    throw new Error('Failed to parse or validate OpenAI response');
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
    const companies = await callOpenAI(prompt);

    console.log(`✅ IMPORT SUCCESS: ${companies.length} companies`);
    return res.status(200).json({ companies });
  } catch (error) {
    console.error('IMPORT ERROR:', error);
    return res.status(500).json({ error: error.message || 'Unknown error' });
  }
}
