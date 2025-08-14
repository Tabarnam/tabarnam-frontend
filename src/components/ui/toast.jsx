// api/xai.js
import { z } from 'zod';
import axios from 'axios';

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
  return `Provide exactly 20 unique companies that make products related to (${query}), with no fewer, in this exact structured JSON format, where each object represents one company. Be maximally truthful and avoid hallucinations. Each field must match the key names below exactly for successful import. Always include the Amazon store URL if the company has one (search for it if needed, format as "https://www.amazon.com/stores/BrandName/page/ID" or similar seller/store link). If fewer than 20 are available, return what you have with a warning:

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

Always return an array of company companies.
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
  const maxPages = 10; // Up to 200 companies
  while (page <= maxPages) {
    try {
      const response = await axios.post('https://api.x.ai/v1/chat/completions', {
        model: 'grok-4-latest',
        messages: [{ role: 'user', content: prompt + ` Return page ${page} of results.` }],
        temperature: 0.2,
      }, {
        headers: { 'Authorization': `Bearer ${xaiApiKey}` },
        timeout: 290000, // 290 seconds, just under 300s max
      });

      const content = response.data.choices[0].message.content;
      console.log('--- RAW xAI RESPONSE Page', page, '---');
      console.log('Content:', content);

      if (!content || !content.startsWith('[')) {
        console.warn('No valid company data on page', page, '- stopping.');
        break;
      }

      let pageCompanies;
      try {
        pageCompanies = JSON.parse(content);
      } catch (e) {
        console.warn('Parsing error on page', page, ':', e.message, '- skipping.');
        page++;
        continue;
      }

      // Apply affiliate tag to each company in the page
      const taggedCompanies = pageCompanies.map(company => {
        if (company.amazon_url) {
          try {
            const url = new URL(company.amazon_url.startsWith('http') ? company.amazon_url : `https://${company.amazon_url}`);
            if (url.hostname === 'www.amazon.com') {
              url.searchParams.set('tag', 'tabarnam-20');
              company.amazon_url = url.toString();
            }
          } catch (urlError) {
            console.warn('Invalid Amazon URL, skipping tag append:', company.amazon_url);
          }
        }
        return company;
      });

      console.log('Page', page, 'Companies Count:', taggedCompanies.length);
      allCompanies = [...allCompanies, ...taggedCompanies.filter(c => 
        !allCompanies.some(existing => existing.company_name === c.company_name)
      )];
      if (taggedCompanies.length < 5 || allCompanies.length >= 200) {
        console.log('Stopping: Page length < 5 or total >= 200. Total companies:', allCompanies.length);
        break;
      }
      page++;
    } catch (error) {
      console.error('Fetch error on page', page, ':', error.message);
      break;
    }
  }

  try {
    const validated = schema.parse(allCompanies);
    return validated;
  } catch (e) {
    console.error('VALIDATION ERROR:', e.errors);
    throw new Error('Failed to parse or validate xAI response');
  }
}

export default async function handler(req, res) {
  // Set CORS headers for all requests
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400'); // Cache preflight for 24 hours

  if (req.method === 'OPTIONS') {
    return res.status(204).end(); // Respond to preflight
  }

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
    console.log(`✅ IMPORT SUCCESS: ${companies.length} unique companies via xAI`);
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60'); // 5 min cache, 1 min stale
    return res.status(200).json({ companies });
  } catch (error) {
    console.error('IMPORT ERROR:', error.message);
    return res.status(500).json({ error: error.message || 'Unknown error' });
  }
}