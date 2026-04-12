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

  // Strip optional email/quiz_answers before forwarding to Anthropic
  const { email, quiz_answers, ...anthropicBody } = req.body || {};

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(anthropicBody)
    });

    const data = await response.json();

    // If email was provided, parse the generated names and save to Supabase
    if (email && data.content && data.content[0] && data.content[0].text) {
      try {
        const rawText = data.content[0].text
          .replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const jsonStart = rawText.indexOf('{');
        const jsonEnd = rawText.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
          const parsed = JSON.parse(rawText.slice(jsonStart, jsonEnd + 1));
          const allNames = [...(parsed.free || []), ...(parsed.premium || [])];
          if (allNames.length > 0) {
            await saveGeneratedNames(email, allNames, quiz_answers || {});
          }
        }
      } catch (saveErr) {
        // Non-fatal — don't fail the response if the save fails
        console.error('Failed to save generated names:', saveErr);
      }
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

async function saveGeneratedNames(email, names, quizAnswers) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return;

  const rows = names.map(n => ({
    email,
    name: n.name,
    origin: n.origin || '',
    meaning: n.meaning || '',
    tags: Array.isArray(n.tags) ? n.tags : [],
    quiz_answers: quizAnswers
  }));

  const res = await fetch(`${supabaseUrl}/rest/v1/generated_names`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(rows)
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(JSON.stringify(err));
  }
}
