const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const brevoKey = process.env.BREVO_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  // Verify Stripe signature
  let event;
  try {
    const rawBody = await getRawBody(req);
    const expectedSig = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');
    const receivedSig = sig.split(',').find(s => s.startsWith('v1=')).replace('v1=', '');
    if (expectedSig !== receivedSig) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
    event = JSON.parse(rawBody);
  } catch (err) {
    console.error('Webhook signature error:', err);
    return res.status(400).json({ error: err.message });
  }

  // Only handle completed checkouts
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;
  const email = session.customer_details?.email || session.customer_email;
  const amountTotal = session.amount_total; // in cents

  if (!email) {
    console.error('No email in session');
    return res.status(200).json({ received: true });
  }

  // Determine tier from amount
  let tier, nameCount;
  if (amountTotal <= 199) {
    tier = 1; nameCount = 20;
  } else if (amountTotal <= 499) {
    tier = 2; nameCount = 100;
  } else {
    tier = 3; nameCount = 999;
  }

  try {
    // Look up quiz answers from Supabase
    const sessionRes = await fetch(
      `${supabaseUrl}/rest/v1/quiz_sessions?email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        }
      }
    );
    const sessions = await sessionRes.json();
    const answers = sessions[0]?.answers || {};

    // Generate names via Claude
    const nameList = await generateNames(anthropicKey, answers, nameCount, tier);

    // Save purchase to Supabase
    await fetch(`${supabaseUrl}/rest/v1/purchases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      },
      body: JSON.stringify({
        email,
        tier,
        stripe_session_id: session.id,
        names_sent: true
      })
    });

    // For unlimited tier, save names to Supabase too
    if (tier === 3 && nameList.length > 0) {
      const namesToSave = nameList.map(n => ({
        email,
        name: n.name,
        origin: n.origin,
        meaning: n.meaning,
        tags: n.tags
      }));
      await fetch(`${supabaseUrl}/rest/v1/saved_names`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        },
        body: JSON.stringify(namesToSave)
      });
    }

    // Send email via Brevo
    await sendEmail(brevoKey, email, nameList, tier, nameCount);

    return res.status(200).json({ received: true, success: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    return res.status(200).json({ received: true, error: err.message });
  }
}

async function generateNames(apiKey, answers, count, tier) {
  const prompt = `You are a baby name expert. Generate exactly ${count} baby names based on these preferences:
- Gender: ${answers.gender || 'neutral'}
- Style: ${answers.style || 'classic'}
- Cultural background: ${answers.culture || 'no preference'}
- Name vibe: ${answers.vibe || 'warm'}
- Sound preferences: ${answers.sound || 'none'}
- Meaning themes: ${answers.meaning || 'no preference'}
- Birth season: ${answers.season || 'not specified'}

Respond ONLY with valid JSON array, no markdown:
[{"name":"...","origin":"...","meaning":"...","tags":["...","..."]}]

Make names feel warm, considered, and beautifully matched. Vary origins and styles.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  const text = data.content[0].text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  return JSON.parse(text.slice(start, end + 1));
}

async function sendEmail(brevoKey, email, names, tier, count) {
  const tierLabel = tier === 1 ? 'Starter' : tier === 2 ? 'Family' : 'Unlimited';
  const displayCount = tier === 3 ? 'Unlimited' : count;

  const namesHtml = names.map((n, i) => `
    <div style="padding:16px 0; border-bottom:1px solid rgba(28,43,58,0.08);">
      <div style="font-family:Georgia,serif; font-size:22px; color:#1C2B3A; margin-bottom:4px;">${n.name}</div>
      <div style="font-size:11px; color:#C9737A; letter-spacing:0.06em; text-transform:uppercase; margin-bottom:4px;">${n.origin}</div>
      <div style="font-size:13px; color:#8B9EB0;">${n.meaning}</div>
    </div>
  `).join('');

  const htmlContent = `
    <div style="max-width:560px; margin:0 auto; font-family:'DM Sans',sans-serif; background:#FDFAF7;">
      <div style="background:#1C2B3A; padding:32px; text-align:center;">
        <div style="font-family:Georgia,serif; font-size:36px; font-style:italic; color:#FDFAF7; letter-spacing:2px;">nomia</div>
        <div style="font-size:11px; color:#8B9EB0; letter-spacing:4px; margin-top:4px;">FIND THE PERFECT BABY NAME</div>
      </div>
      <div style="padding:40px 32px;">
        <h1 style="font-family:Georgia,serif; font-size:28px; font-weight:300; color:#1C2B3A; margin-bottom:8px;">Your ${displayCount} names are here ✦</h1>
        <p style="font-size:15px; color:#8B9EB0; margin-bottom:32px;">Your Nomia ${tierLabel} collection, curated just for you.</p>
        ${namesHtml}
        <div style="margin-top:32px; text-align:center;">
          <a href="https://trynomia.com/quiz.html" style="display:inline-block; padding:14px 32px; background:#C9737A; color:white; border-radius:99px; text-decoration:none; font-size:14px;">Generate another list</a>
        </div>
      </div>
      <div style="padding:24px; text-align:center; font-size:12px; color:#8B9EB0;">© 2026 Nomia · Made with love in New Jersey</div>
    </div>
  `;

  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': brevoKey
    },
    body: JSON.stringify({
      sender: { name: 'Nomia', email: 'hello@trynomia.com' },
      to: [{ email }],
      subject: `Your ${displayCount} Nomia names are ready ✦`,
      htmlContent
    })
  });
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
