// send-sequences.js
// GET  — called by cron.js to process all due scheduled emails
// POST { email, type } — manual single-email trigger

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const brevoKey    = process.env.BREVO_API_KEY;

  if (!supabaseUrl || !supabaseKey || !brevoKey) {
    return res.status(500).json({ error: 'Missing environment variables' });
  }

  // Manual single trigger
  if (req.method === 'POST') {
    const { email, type } = req.body || {};
    if (!email || !type) return res.status(400).json({ error: 'email and type required' });
    if (!['day3', 'day7', 'upgrade_nudge'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type' });
    }
    try {
      await sendOne(email, type, null, supabaseUrl, supabaseKey, brevoKey);
      return res.status(200).json({ success: true, email, type });
    } catch (err) {
      console.error('Manual send error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Queue processor (GET from cron)
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const now = new Date().toISOString();
    const queueRes = await supabaseFetch(
      `${supabaseUrl}/rest/v1/scheduled_emails?send_after=lte.${now}&sent=eq.false&cancelled=eq.false&order=send_after.asc&limit=50`,
      'GET', null, supabaseKey
    );
    const queue = await queueRes.json();

    if (!Array.isArray(queue) || queue.length === 0) {
      return res.status(200).json({ processed: 0, results: [] });
    }

    const results = [];
    for (const row of queue) {
      try {
        // Check if user has upgraded — skip day3/day7 for paid users
        const statusRes = await supabaseFetch(
          `${supabaseUrl}/rest/v1/user_status?email=eq.${encodeURIComponent(row.email)}&limit=1`,
          'GET', null, supabaseKey
        );
        const statusData = await statusRes.json();
        const status = statusData[0]?.status || 'free';

        if ((row.type === 'day3' || row.type === 'day7') && status !== 'free') {
          // User has upgraded — cancel this email silently
          await markRow(row.id, { cancelled: true }, supabaseUrl, supabaseKey);
          results.push({ id: row.id, email: row.email, type: row.type, skipped: 'upgraded' });
          continue;
        }

        await sendOne(row.email, row.type, row.id, supabaseUrl, supabaseKey, brevoKey);
        results.push({ id: row.id, email: row.email, type: row.type, success: true });
      } catch (err) {
        console.error(`Failed ${row.type} → ${row.email}:`, err.message);
        results.push({ id: row.id, email: row.email, type: row.type, success: false, error: err.message });
      }
    }

    return res.status(200).json({ processed: results.length, results });
  } catch (err) {
    console.error('Queue processor error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ---------------------------------------------------------------------------
// Core send function — fetches data, builds email, sends, marks sent
// ---------------------------------------------------------------------------

async function sendOne(email, type, rowId, supabaseUrl, supabaseKey, brevoKey) {
  // Quiz answers
  const sessionRes = await supabaseFetch(
    `${supabaseUrl}/rest/v1/quiz_sessions?email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1`,
    'GET', null, supabaseKey
  );
  const sessions = await sessionRes.json();
  const quizAnswers = sessions[0]?.answers || {};

  // Generated names — day7 offsets by 3; upgrade_nudge excludes saved_names
  let names = [];
  if (type === 'upgrade_nudge') {
    names = await getNamesExcludingSaved(email, supabaseUrl, supabaseKey);
  } else {
    const offset = type === 'day7' ? 3 : 0;
    const r = await supabaseFetch(
      `${supabaseUrl}/rest/v1/generated_names?email=eq.${encodeURIComponent(email)}&order=created_at.asc&limit=3&offset=${offset}`,
      'GET', null, supabaseKey
    );
    names = await r.json();
    if (!Array.isArray(names)) names = [];
  }

  const { subject, htmlContent } = buildEmail(type, email, names, quizAnswers);

  const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': brevoKey },
    body: JSON.stringify({
      sender: { name: 'Nomia', email: 'nick@ohlsonads.com' },
      to: [{ email }],
      subject,
      htmlContent
    })
  });

  if (!brevoRes.ok) {
    const err = await brevoRes.json();
    throw new Error(`Brevo: ${JSON.stringify(err)}`);
  }

  // Mark as sent
  if (rowId) {
    await markRow(rowId, { sent: true }, supabaseUrl, supabaseKey);
  }
}

// Get names for upgrade_nudge — exclude anything already in saved_names
async function getNamesExcludingSaved(email, supabaseUrl, supabaseKey) {
  const [genRes, savedRes] = await Promise.all([
    supabaseFetch(
      `${supabaseUrl}/rest/v1/generated_names?email=eq.${encodeURIComponent(email)}&order=created_at.asc&limit=20`,
      'GET', null, supabaseKey
    ),
    supabaseFetch(
      `${supabaseUrl}/rest/v1/saved_names?email=eq.${encodeURIComponent(email)}`,
      'GET', null, supabaseKey
    )
  ]);
  const generated = await genRes.json();
  const saved     = await savedRes.json();

  if (!Array.isArray(generated)) return [];
  const savedSet = new Set((Array.isArray(saved) ? saved : []).map(n => n.name?.toLowerCase()));
  return generated.filter(n => !savedSet.has(n.name?.toLowerCase())).slice(0, 3);
}

async function markRow(id, patch, supabaseUrl, supabaseKey) {
  await supabaseFetch(
    `${supabaseUrl}/rest/v1/scheduled_emails?id=eq.${id}`,
    'PATCH', patch, supabaseKey
  );
}

function supabaseFetch(url, method, body, supabaseKey) {
  const opts = {
    method,
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(url, opts);
}

// ---------------------------------------------------------------------------
// Email builders
// ---------------------------------------------------------------------------

function buildEmail(type, email, names, quizAnswers) {
  switch (type) {
    case 'day3':          return buildDay3(email, names, quizAnswers);
    case 'day7':          return buildDay7(email, names, quizAnswers);
    case 'upgrade_nudge': return buildUpgradeNudge(email, names, quizAnswers);
    default: throw new Error(`Unknown email type: ${type}`);
  }
}

// ---------------------------------------------------------------------------
// Shared HTML helpers
// ---------------------------------------------------------------------------

const LOGO_HEADER = `
  <div style="background:#1C2B3A; padding:28px 32px; text-align:center;">
    <img src="https://raw.githubusercontent.com/nickmistretta/baby-names-api/main/nomia-email-logo.png"
         alt="Nomia" style="height:60px; width:auto; display:inline-block;" />
  </div>`;

const footer = (email) => `
  <div style="padding:24px 32px; text-align:center; border-top:1px solid rgba(28,43,58,0.07);">
    <p style="font-size:11px; color:#8B9EB0; margin:0; line-height:1.9;">
      © 2026 Nomia &nbsp;·&nbsp;
      <a href="https://trynomia.com/unsubscribe?email=${encodeURIComponent(email)}"
         style="color:#8B9EB0; text-decoration:underline;">Unsubscribe</a>
    </p>
  </div>`;

function nameCards(names) {
  if (!names || names.length === 0) {
    return `<p style="font-size:14px; color:#8B9EB0; text-align:center; padding:20px 0;">
      Take the quiz to see your personalised names.
    </p>`;
  }
  return names.map(n => `
    <div style="border:1px solid rgba(28,43,58,0.09); border-radius:12px; padding:18px 22px;
                margin-bottom:10px; background:#ffffff;">
      <div style="font-family:Georgia,'Times New Roman',serif; font-size:26px; font-weight:300;
                  color:#1C2B3A; margin-bottom:3px;">${n.name || '—'}</div>
      <div style="font-size:10px; color:#C9737A; letter-spacing:0.1em; text-transform:uppercase;
                  margin-bottom:5px;">${n.origin || ''}</div>
      <div style="font-size:13px; color:#8B9EB0; line-height:1.5;">${n.meaning || ''}</div>
    </div>`).join('');
}

function ctaButton(label, url) {
  return `
    <div style="text-align:center; margin:32px 0 24px;">
      <a href="${url}"
         style="display:inline-block; background:#C9737A; color:#ffffff; text-decoration:none;
                padding:14px 36px; border-radius:99px; font-size:14px;
                font-family:system-ui,-apple-system,sans-serif; letter-spacing:0.04em;">
        ${label}
      </a>
    </div>`;
}

function wrap(inner) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#eeebe7;">
  <div style="max-width:560px;margin:32px auto;background:#FDFAF7;
              border-radius:4px;overflow:hidden;
              font-family:system-ui,-apple-system,sans-serif;">
    ${inner}
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Day 3
// ---------------------------------------------------------------------------

function buildDay3(email, names, qa) {
  const style = qa.style || qa.vibe || 'timeless and warm';

  const body = `
    ${LOGO_HEADER}
    <div style="padding:40px 32px 8px;">
      <h1 style="font-family:Georgia,'Times New Roman',serif; font-size:28px; font-weight:300;
                 color:#1C2B3A; margin:0 0 14px; line-height:1.25;">
        Your baby names are still waiting ✦
      </h1>
      <p style="font-size:15px; color:#8B9EB0; line-height:1.75; margin:0 0 10px;">
        A few days ago you told us you were looking for something
        <strong style="color:#1C2B3A; font-weight:500;">${style}</strong>.
        We chose these with exactly that in mind.
      </p>
      <p style="font-size:15px; color:#8B9EB0; line-height:1.75; margin:0 0 28px;">
        They've been sitting here for you — and they're worth a proper look.
      </p>
      ${nameCards(names)}
      <p style="font-size:14px; color:#8B9EB0; line-height:1.7; margin:24px 0 4px;">
        There are more where these came from. Run the quiz again and we'll find a
        completely fresh list tailored to exactly where you are right now.
      </p>
      ${ctaButton('See all your names →', 'https://trynomia.com/quiz.html')}
    </div>
    ${footer(email)}`;

  return { subject: 'Your baby names are still waiting ✦', htmlContent: wrap(body) };
}

// ---------------------------------------------------------------------------
// Day 7
// ---------------------------------------------------------------------------

function buildDay7(email, names, qa) {
  const body = `
    ${LOGO_HEADER}
    <div style="padding:40px 32px 8px;">
      <h1 style="font-family:Georgia,'Times New Roman',serif; font-size:28px; font-weight:300;
                 color:#1C2B3A; margin:0 0 14px; line-height:1.25;">
        Still searching for the perfect name?
      </h1>
      <p style="font-size:15px; color:#8B9EB0; line-height:1.75; margin:0 0 14px;">
        Most parents spend weeks — sometimes months — going back and forth.
        That's not indecision. That's how important this is.
        You don't have to do it alone.
      </p>
      <p style="font-size:15px; color:#8B9EB0; line-height:1.75; margin:0 0 28px;">
        Have you tried our
        <strong style="color:#1C2B3A; font-weight:500;">taste-matching quiz</strong>?
        Tell us names you already love — Isla, Arlo, Cleo, anything — and we'll find
        more with the same energy, roots, and feel. It often surfaces names you'd
        never have thought to search for.
      </p>
      ${nameCards(names)}
      ${ctaButton('Try the taste matching quiz →', 'https://trynomia.com/quiz.html')}
      <p style="font-size:13px; color:#8B9EB0; line-height:1.7; margin:0 0 36px; text-align:center;">
        A fresh angle might be all it takes.
      </p>
    </div>
    ${footer(email)}`;

  return { subject: 'Still searching for the perfect name?', htmlContent: wrap(body) };
}

// ---------------------------------------------------------------------------
// Upgrade nudge — Day 14 for Starter / Family buyers
// ---------------------------------------------------------------------------

function buildUpgradeNudge(email, names, qa) {
  const features = [
    ['Unlimited generation', 'Run as many quizzes as you like — every list is unique to your answers.'],
    ['Personal dashboard',   'Save your favourites, compare side by side, come back any time.'],
    ['Taste-matching quiz',  'Feed us names you love. We find more with the same energy and roots.'],
    ['Load 25 more',         'Not happy with a list? Generate 25 fresh names without starting over.'],
  ];

  const featureRows = features.map(([title, desc]) => `
    <div style="display:flex; gap:14px; margin-bottom:16px; align-items:flex-start;">
      <div style="color:#C9737A; font-size:16px; margin-top:1px; flex-shrink:0;">✦</div>
      <div>
        <div style="font-size:14px; font-weight:500; color:#1C2B3A; margin-bottom:2px;">${title}</div>
        <div style="font-size:13px; color:#8B9EB0; line-height:1.5;">${desc}</div>
      </div>
    </div>`).join('');

  const body = `
    ${LOGO_HEADER}
    <div style="padding:40px 32px 8px;">
      <h1 style="font-family:Georgia,'Times New Roman',serif; font-size:28px; font-weight:300;
                 color:#1C2B3A; margin:0 0 14px; line-height:1.25;">
        You've seen some names.<br/>There are hundreds more ✦
      </h1>
      <p style="font-size:15px; color:#8B9EB0; line-height:1.75; margin:0 0 28px;">
        You took the first step — and your curated list is a real starting point.
        Nomia Unlimited removes every limit so you can keep searching until something
        truly clicks.
      </p>

      <div style="background:#ffffff; border:1px solid rgba(28,43,58,0.08);
                  border-radius:12px; padding:24px 24px 8px; margin-bottom:28px;">
        <div style="font-size:10px; color:#C9737A; letter-spacing:0.12em; text-transform:uppercase;
                    margin-bottom:18px;">What Unlimited adds</div>
        ${featureRows}
      </div>

      <p style="font-size:14px; color:#8B9EB0; line-height:1.65; margin:0 0 14px;">
        Here are three more names already matched to your style —
        a glimpse of what's waiting for you:
      </p>
      ${nameCards(names)}
      ${ctaButton('Upgrade to Unlimited →', 'https://buy.stripe.com/fZueVe936b4bcQ0eTv2Fa02')}
      <p style="font-size:12px; color:#8B9EB0; text-align:center; margin:0 0 36px;">
        One-time $9.99 · No subscription · Yours forever
      </p>
    </div>
    ${footer(email)}`;

  return { subject: "You've seen some names. There are hundreds more ✦", htmlContent: wrap(body) };
}
