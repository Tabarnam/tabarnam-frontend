export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { keyword } = req.body;

  if (!keyword || typeof keyword !== 'string') {
    return res.status(400).json({ error: 'Invalid or missing keyword' });
  }

  try {
    console.log(`Triggering xAI import for: ${keyword}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    return res.status(200).json({ success: true, message: `xAI import triggered for '${keyword}'` });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}
