module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, type } = req.body || {};
  if (!email || !type) return res.status(400).json({ error: 'email and type required' });
  if (!['day3', 'day7', 'upgrade_nudge'].includes(type)) {
    return res.status(400).json({ error: 'type must be day3, day7, or upgrade_nudge' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const brevoKey = process.env.BREVO_API_KEY;

  if (!supabaseUrl || !supabaseKey || !brevoKey) {
    return res.status(500).json({ error: 'Missing environment variables' });
  }

  try {
    // Get most recent quiz answers
    const sessionRes = await fetch(
      `${supabaseUrl}/rest/v1/quiz_sessions?email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
    );
    const sessions = await sessionRes.json();
    const quizAnswers = sessions[0]?.answers || {};

    // Get 3 names — offset by 3 for day7 so it shows fresh names
    const offset = type === 'day7' ? 3 : 0;
    const namesRes = await fetch(
      `${supabaseUrl}/rest/v1/generated_names?email=eq.${encodeURIComponent(email)}&order=created_at.asc&limit=3&offset=${offset}`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
    );
    const names = await namesRes.json();

    const { subject, htmlContent } = buildEmail(type, email, names, quizAnswers);

    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': brevoKey
      },
      body: JSON.stringify({
        sender: { name: 'Nomia', email: 'nick@ohlsonads.com' },
        to: [{ email }],
        subject,
        htmlContent
      })
    });

    const brevoData = await brevoRes.json();
    if (!brevoRes.ok) {
      console.error('Brevo send error:', brevoData);
      return res.status(200).json({ success: false, detail: brevoData });
    }

    return res.status(200).json({ success: true, type, email });
  } catch (err) {
    console.error('send-sequences error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ---------------------------------------------------------------------------
// Email builders
// ---------------------------------------------------------------------------

function buildEmail(type, email, names, quizAnswers) {
  switch (type) {
    case 'day3':        return buildDay3(email, names, quizAnswers);
    case 'day7':        return buildDay7(email, names, quizAnswers);
    case 'upgrade_nudge': return buildUpgradeNudge(email, names, quizAnswers);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const LOGO = `
  <div style="background:#1C2B3A; padding:28px 32px; text-align:center;">
    <img src="https://raw.githubusercontent.com/nickmistretta/baby-names-api/main/nomia-email-logo.png"
         alt="Nomia" style="height:64px; width:auto; display:inline-block;" />
  </div>`;

const FOOTER = (email) => `
  <div style="padding:24px 32px; text-align:center; border-top:1px solid rgba(28,43,58,0.06);">
    <p style="font-size:11px; color:#8B9EB0; margin:0; line-height:1.8;">
      © 2026 Nomia · Made with love ·
      <a href="https://trynomia.com/unsubscribe?email=${encodeURIComponent(email)}"
         style="color:#8B9EB0; text-decoration:underline;">Unsubscribe</a>
    </p>
  </div>`;

function nameCards(names) {
  if (!names || names.length === 0) return '';
  return names.map(n => `
    <div style="border:1px solid rgba(28,43,58,0.1); border-radius:12px; padding:20px 24px; margin-bottom:12px; background:#ffffff;">
      <div style="font-family:Georgia,'Times New Roman',serif; font-size:26px; font-weight:300; color:#1C2B3A; margin-bottom:4px;">${n.name || '—'}</div>
      <div style="font-size:10px; color:#C9737A; letter-spacing:0.1em; text-transform:uppercase; margin-bottom:6px;">${n.origin || ''}</div>
      <div style="font-size:13px; color:#8B9EB0; line-height:1.5;">${n.meaning || ''}</div>
    </div>`).join('');
}

function ctaButton(text, url) {
  return `
    <div style="text-align:center; margin:32px 0;">
      <a href="${url}"
         style="display:inline-block; background:#C9737A; color:#ffffff; text-decoration:none;
                padding:14px 36px; border-radius:99px; font-size:14px;
                font-family:system-ui,-apple-system,sans-serif; letter-spacing:0.04em;">
        ${text}
      </a>
    </div>`;
}

function wrapper(content) {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
    </head>
    <body style="margin:0; padding:0; background:#f4f1ee;">
      <div style="max-width:560px; margin:0 auto; background:#FDFAF7; font-family:system-ui,-apple-system,sans-serif;">
        ${content}
      </div>
    </body>
    </html>`;
}

// ---------------------------------------------------------------------------
// Day 3
// ---------------------------------------------------------------------------

function buildDay3(email, names, quizAnswers) {
  const style = quizAnswers.style || quizAnswers.vibe || 'timeless';

  const body = `
    ${LOGO}
    <div style="padding:40px 32px 0;">
      <h1 style="font-family:Georgia,'Times New Roman',serif; font-size:28px; font-weight:300;
                 color:#1C2B3A; margin:0 0 12px;">Your baby names are still waiting ✦</h1>
      <p style="font-size:15px; color:#8B9EB0; line-height:1.7; margin:0 0 28px;">
        A few days ago you told us you were looking for something
        <strong style="color:#1C2B3A; font-weight:500;">${style}</strong>.
        We chose these names with that in mind — and they're worth a second look.
      </p>
      ${nameCards(names)}
      ${ctaButton('See all your names →', 'https://trynomia.com/quiz.html')}
      <p style="font-size:13px; color:#8B9EB0; line-height:1.7; margin:0 0 40px; text-align:center;">
        Run the quiz again any time — every generation is unique to your answers.
      </p>
    </div>
    ${FOOTER(email)}`;

  return {
    subject: 'Your baby names are still waiting ✦',
    htmlContent: wrapper(body)
  };
}

// ---------------------------------------------------------------------------
// Day 7
// ---------------------------------------------------------------------------

function buildDay7(email, names, quizAnswers) {
  const body = `
    ${LOGO}
    <div style="padding:40px 32px 0;">
      <h1 style="font-family:Georgia,'Times New Roman',serif; font-size:28px; font-weight:300;
                 color:#1C2B3A; margin:0 0 12px;">Still searching for the perfect name?</h1>
      <p style="font-size:15px; color:#8B9EB0; line-height:1.7; margin:0 0 16px;">
        Most parents spend weeks — sometimes months — going back and forth on a name.
        That's completely normal. The right name takes time to land.
      </p>
      <p style="font-size:15px; color:#8B9EB0; line-height:1.7; margin:0 0 28px;">
        One thing that really helps: our <strong style="color:#1C2B3A; font-weight:500;">taste-matching quiz</strong>.
        Tell us names you already love and we'll find more with the same energy, roots, and feel.
        You haven't tried it yet — and it often unlocks names you'd never have thought to search for.
      </p>
      ${nameCards(names)}
      ${ctaButton('Try the taste matching quiz →', 'https://trynomia.com/quiz.html')}
      <p style="font-size:13px; color:#8B9EB0; line-height:1.7; margin:0 0 40px; text-align:center;">
        A fresh perspective might be exactly what you need.
      </p>
    </div>
    ${FOOTER(email)}`;

  return {
    subject: 'Still searching for the perfect name?',
    htmlContent: wrapper(body)
  };
}

// ---------------------------------------------------------------------------
// Upgrade nudge (for Starter / Family buyers)
// ---------------------------------------------------------------------------

function buildUpgradeNudge(email, names, quizAnswers) {
  const features = [
    'Unlimited name generation — run as many quizzes as you like',
    'Personal dashboard to save and organise your favourites',
    'Taste-matching quiz — feed us names you love, get more like them',
    'Load more — keep generating until one truly clicks',
  ];

  const featureList = features.map(f => `
    <div style="display:flex; align-items:flex-start; gap:10px; margin-bottom:10px;">
      <span style="color:#C9737A; font-size:14px; margin-top:1px;">✦</span>
      <span style="font-size:14px; color:#1C2B3A; line-height:1.5;">${f}</span>
    </div>`).join('');

  const body = `
    ${LOGO}
    <div style="padding:40px 32px 0;">
      <h1 style="font-family:Georgia,'Times New Roman',serif; font-size:28px; font-weight:300;
                 color:#1C2B3A; margin:0 0 12px;">You've seen some names.<br>There are hundreds more ✦</h1>
      <p style="font-size:15px; color:#8B9EB0; line-height:1.7; margin:0 0 28px;">
        Your current plan gave you a curated starting point. Nomia Unlimited removes every limit —
        generate as many lists as you want, save your favourites, and use our taste-matching quiz
        to find names with exactly the right feel.
      </p>

      <div style="background:#ffffff; border:1px solid rgba(28,43,58,0.08); border-radius:12px; padding:24px; margin-bottom:28px;">
        <div style="font-size:11px; color:#C9737A; letter-spacing:0.1em; text-transform:uppercase; margin-bottom:16px;">What you unlock</div>
        ${featureList}
      </div>

      <p style="font-size:14px; color:#8B9EB0; line-height:1.6; margin:0 0 12px;">
        Here are a few of the names we've already matched to your style — a taste of what's waiting:
      </p>
      ${nameCards(names)}
      ${ctaButton('Upgrade to Unlimited →', 'https://buy.stripe.com/fZueVe936b4bcQ0eTv2Fa02')}
      <p style="font-size:13px; color:#8B9EB0; line-height:1.7; margin:0 0 40px; text-align:center;">
        One-time $9.99 · No subscription · Yours forever
      </p>
    </div>
    ${FOOTER(email)}`;

  return {
    subject: "You've seen some names. There are hundreds more ✦",
    htmlContent: wrapper(body)
  };
}
