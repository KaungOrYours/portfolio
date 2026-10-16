module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY' });
    return;
  }

  const { system, messages } = req.body || {};
  if (!system || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'Request must include "system" and a non-empty "messages" array' });
    return;
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system,
        messages,
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      const message = (data && data.error && data.error.message) || 'Upstream request failed';
      res.status(upstream.status).json({ error: message });
      return;
    }

    const text = data && data.content && data.content[0] && data.content[0].text;
    if (!text) {
      res.status(502).json({ error: 'Empty response from Claude' });
      return;
    }

    res.status(200).json({ text: text.trim() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reach Claude API' });
  }
};
