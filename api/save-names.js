module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, names } = req.body;
  if (!email || !names || !names.length) return res.status(400).json({ error: 'Email and names required' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  try {
    const namesToSave = names.map(n => ({
      email,
      name: n.name,
      origin: n.origin || '',
      meaning: n.meaning || '',
      tags: n.tags || []
    }));

    const response = await fetch(`${supabaseUrl}/rest/v1/saved_names`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(namesToSave)
    });

    if (!response.ok) {
      const err = await response.json();
      console.error('Supabase error:', err);
      return res.status(200).json({ success: false, detail: err });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('save-names error:', err);
    return res.status(500).json({ error: err.message });
  }
}
