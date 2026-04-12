module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', message: 'Nomia API is running' });
  }

  // --- EMAIL CAPTURE / SUBSCRIBE ---
  if (req.method === 'POST' && req.body?.action === 'subscribe') {
    const { email, names, quiz_answers } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const brevoKey   = process.env.BREVO_API_KEY;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;

    const results = { brevo: false, names: false, status: false, scheduled: false };

    // 1. Add to Brevo contact list
    if (brevoKey) {
      try {
        const brevoRes = await fetch('https://api.brevo.com/v3/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-key': brevoKey },
          body: JSON.stringify({ email, listIds: [3], updateEnabled: true })
        });
        results.brevo = brevoRes.status === 201 || brevoRes.status === 204;
        if (!results.brevo) console.error('Brevo error:', await brevoRes.json());
      } catch (err) {
        console.error('Brevo catch:', err);
      }
    }

    if (supabaseUrl && supabaseKey) {
      const headers = {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      };

      // 2. Save free generated names to generated_names
      if (Array.isArray(names) && names.length > 0) {
        try {
          const rows = names.map(n => ({
            email,
            name: n.name || '',
            origin: n.origin || '',
            meaning: n.meaning || '',
            tags: Array.isArray(n.tags) ? n.tags : [],
            quiz_answers: quiz_answers || {}
          }));
          const r = await fetch(`${supabaseUrl}/rest/v1/generated_names`, {
            method: 'POST',
            headers: { ...headers, 'Prefer': 'return=minimal' },
            body: JSON.stringify(rows)
          });
          results.names = r.ok;
          if (!r.ok) console.error('generated_names error:', await r.json());
        } catch (err) {
          console.error('generated_names catch:', err);
        }
      }

      // 3. Upsert user_status as 'free' — ignore if email already exists (don't downgrade paid users)
      try {
        const r = await fetch(`${supabaseUrl}/rest/v1/user_status`, {
          method: 'POST',
          headers: { ...headers, 'Prefer': 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify({ email, status: 'free' })
        });
        results.status = r.ok;
        if (!r.ok) console.error('user_status error:', await r.json());
      } catch (err) {
        console.error('user_status catch:', err);
      }

      // 4. Schedule day3 and day7 emails (only if not already scheduled)
      try {
        const now = Date.now();
        const scheduled = [
          { email, type: 'day3', send_after: new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString() },
          { email, type: 'day7', send_after: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString() }
        ];
        const r = await fetch(`${supabaseUrl}/rest/v1/scheduled_emails`, {
          method: 'POST',
          headers: { ...headers, 'Prefer': 'return=minimal' },
          body: JSON.stringify(scheduled)
        });
        results.scheduled = r.ok;
        if (!r.ok) console.error('scheduled_emails error:', await r.json());
      } catch (err) {
        console.error('scheduled_emails catch:', err);
      }
    }

    return res.status(200).json({ success: true, ...results });
  }

  // --- ANTHROPIC NAME GENERATION ---
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

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

    // If email was provided at generation time, parse and save names
    if (email && data.content?.[0]?.text) {
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
    name: n.name || '',
    origin: n.origin || '',
    meaning: n.meaning || '',
    tags: Array.isArray(n.tags) ? n.tags : [],
    quiz_answers: quizAnswers
  }));

  const r = await fetch(`${supabaseUrl}/rest/v1/generated_names`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(rows)
  });

  if (!r.ok) {
    const err = await r.json();
    throw new Error(JSON.stringify(err));
  }
}
