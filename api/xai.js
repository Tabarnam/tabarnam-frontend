// api/xai.js
import { z } from 'zod';
import axios from 'axios';
import { app } from '@azure/functions';

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

app.http('xaiImport', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    context.log(`Http function processed request for URL "${request.url}"`);
    const body = await request.text();
    const parsedData = schema.safeParse(JSON.parse(body));

    if (!parsedData.success) {
      return { status: 400, body: parsedData.error.message };
    }

    try {
      const response = await axios.post('https://your-cosmos-api-endpoint', parsedData.data, {
        headers: { 'Content-Type': 'application/json' },
      });
      return { status: 200, body: response.data };
    } catch (error) {
      context.log.error('Error importing data:', error);
      return { status: 500, body: 'Internal server error' };
    }
  },
});

export default app;