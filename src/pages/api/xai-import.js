export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query } = req.body;

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid search query' });
  }

  try {
    const prompt = `Return a list of 20 real companies related to "${query}". 
For each company, include: name, working website URL, industry, and tagline. 
Only return real and verifiable companies.`;

    const xaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, // or XAI_API_KEY
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a helpful data extractor for real-world companies.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3
      }),
    });

    const data = await xaiResponse.json();

    if (!data || !data.choices || !data.choices[0]?.message?.content) {
      return res.status(500).json({ error: 'Invalid xAI response' });
    }

    const rawText = data.choices[0].message.content;

    // TODO: parse `rawText` into company objects
    return res.status(200).json({
      message: '✅ Raw company list received from xAI',
      rawText
    });

  } catch (error) {
    console.error('❌ xAI import error:', error);
    res.status(500).json({ error: 'Internal error calling xAI' });
  }
}
