const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// OpenAI label generation proxy
app.post('/api/generate-label', async (req, res) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.json({ error: 'OpenAI key not configured' });
  const { prompt } = req.body;
  if (!prompt) return res.json({ error: 'No prompt provided' });
  try {
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: 'Vinyl record center label design, circular format, vintage aesthetic, retro typography, warm tones, music label art: ' + prompt,
        n: 1, size: '1024x1024', response_format: 'b64_json'
      })
    });
    const d = await r.json();
    if (d.data && d.data[0]) {
      res.json({ image: 'data:image/png;base64,' + d.data[0].b64_json });
    } else {
      res.json({ error: d.error?.message || 'Generation failed' });
    }
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Catch-all: serve index.html
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`WAX server running on port ${PORT}`));
