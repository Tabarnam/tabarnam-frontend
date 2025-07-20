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

Always return an arra
