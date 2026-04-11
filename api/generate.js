module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', message: 'Nomia API is running' });
  }

  // --- BREVO EMAIL CAPTURE ---
  // Called separately from the quiz when user enters email at upsell
  if (req.method === 'POST' && req.body?.action === 'subscribe') {
    const email = req.body?.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const brevoKey = process.env.BREVO_API_KEY;
    if (!brevoKey) return res.status(500).json({ error: 'Brevo key not configured' });

    try {
      const brevoRes = await fetch('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': brevoKey
        },
        body: JSON.stringify({
          email,
          listIds: [3],
          updateEnabled: true
        })
      });

      const brevoData = await brevoRes.json();

      // 204 = already exists and updated, 201 = created — both are fine
      if (brevoRes.status === 201 || brevoRes.status === 204) {
        return res.status(200).json({ success: true });
      } else {
        console.error('Brevo error:', brevoData);
        return res.status(200).json({ success: false, detail: brevoData });
      }
    } catch (err) {
      console.error('Brevo catch:', err);
      return res.status(200).json({ success: false, error: err.message });
    }
  }

  // --- ANTHROPIC NAME GENERATION ---
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
