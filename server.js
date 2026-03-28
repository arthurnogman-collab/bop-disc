const express = require('express');
const path = require('path');
const { pool, initDB } = require('./db');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/albums', express.static(path.join(__dirname, 'public', 'albums')));

// Initialize database on startup
initDB().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

// Helper function to decode JWT payload (simple base64 decode, no verification)
function decodeJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64').toString();
    return JSON.parse(payload);
  } catch (e) {
    return null;
  }
}

// ===== AUTH ROUTES =====

// POST /api/auth/google - receives credential JWT, decodes it, upserts user
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: 'No credential provided' });
    }

    const payload = decodeJWT(credential);
    if (!payload) {
      return res.status(400).json({ error: 'Invalid token' });
    }

    const { sub: googleId, email, name, picture } = payload;
    if (!googleId || !email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Upsert user in database
    const result = await pool.query(
      `INSERT INTO wax_users (google_id, email, name, picture, display_name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (google_id) DO UPDATE SET
         email = $2,
         name = $3,
         picture = $4,
         updated_at = NOW()
       RETURNING id, google_id, email, name, picture, display_name`,
      [googleId, email, name, picture, name]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me - returns user from DB by id
app.get('/api/auth/me', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: 'No userId provided' });
    }

    const result = await pool.query(
      'SELECT id, google_id, email, name, picture, display_name FROM wax_users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/auth/display-name - update user's display name
app.patch('/api/auth/display-name', async (req, res) => {
  try {
    const { userId, displayName } = req.body;
    if (!userId || !displayName) {
      return res.status(400).json({ error: 'Missing userId or displayName' });
    }
    const result = await pool.query(
      'UPDATE wax_users SET display_name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, google_id, email, name, picture, display_name',
      [displayName, userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update display name error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== MIXES ROUTES =====

// GET /api/mixes - returns recent mixes with user info, like count, comment count
app.get('/api/mixes', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        m.id, m.user_id, m.title, m.description, m.tracks, m.cuts, m.effects,
        m.label_url, m.disc_color, m.plays, m.created_at,
        u.id as creator_id, u.display_name, u.name, u.picture,
        (SELECT COUNT(*) FROM wax_likes WHERE mix_id = m.id)::int as like_count,
        (SELECT COUNT(*) FROM wax_comments WHERE mix_id = m.id)::int as comment_count
       FROM wax_mixes m
       LEFT JOIN wax_users u ON m.user_id = u.id
       ORDER BY m.created_at DESC
       LIMIT 50`
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Get mixes error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mixes - create a new mix
app.post('/api/mixes', async (req, res) => {
  try {
    const { userId, title, description, tracks, cuts, effects, labelUrl, discColor } = req.body;

    if (!userId || !title || !tracks) {
      return res.status(400).json({ error: 'Missing required fields: userId, title, tracks' });
    }

    const result = await pool.query(
      `INSERT INTO wax_mixes (user_id, title, description, tracks, cuts, effects, label_url, disc_color)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [userId, title, description, JSON.stringify(tracks), JSON.stringify(cuts), JSON.stringify(effects), labelUrl, discColor || 0]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Create mix error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mixes/:id/play - increment play count
app.post('/api/mixes/:id/play', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'UPDATE wax_mixes SET plays = plays + 1 WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Mix not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Play mix error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== LIKES ROUTES =====

// POST /api/likes - toggle like (add or remove)
app.post('/api/likes', async (req, res) => {
  try {
    const { userId, mixId } = req.body;

    if (!userId || !mixId) {
      return res.status(400).json({ error: 'Missing required fields: userId, mixId' });
    }

    // Check if like already exists
    const existing = await pool.query(
      'SELECT id FROM wax_likes WHERE user_id = $1 AND mix_id = $2',
      [userId, mixId]
    );

    let liked = false;
    if (existing.rows.length > 0) {
      // Remove like
      await pool.query(
        'DELETE FROM wax_likes WHERE user_id = $1 AND mix_id = $2',
        [userId, mixId]
      );
    } else {
      // Add like
      await pool.query(
        'INSERT INTO wax_likes (user_id, mix_id) VALUES ($1, $2)',
        [userId, mixId]
      );
      liked = true;
    }

    // Get updated count
    const count = await pool.query(
      'SELECT COUNT(*) as count FROM wax_likes WHERE mix_id = $1',
      [mixId]
    );

    res.json({ liked, count: parseInt(count.rows[0].count) });
  } catch (err) {
    console.error('Like toggle error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/likes/:mixId - returns like count and whether current user liked it
app.get('/api/likes/:mixId', async (req, res) => {
  try {
    const { mixId } = req.params;
    const { userId } = req.query;

    const countResult = await pool.query(
      'SELECT COUNT(*) as count FROM wax_likes WHERE mix_id = $1',
      [mixId]
    );

    let userLiked = false;
    if (userId) {
      const userLikeResult = await pool.query(
        'SELECT id FROM wax_likes WHERE user_id = $1 AND mix_id = $2',
        [userId, mixId]
      );
      userLiked = userLikeResult.rows.length > 0;
    }

    res.json({ count: parseInt(countResult.rows[0].count), userLiked });
  } catch (err) {
    console.error('Get likes error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== COMMENTS ROUTES =====

// GET /api/comments/:mixId - returns comments for a mix with user info
app.get('/api/comments/:mixId', async (req, res) => {
  try {
    const { mixId } = req.params;

    const result = await pool.query(
      `SELECT
        c.id, c.user_id, c.text, c.created_at,
        u.id as commenter_id, u.display_name, u.name, u.picture
       FROM wax_comments c
       LEFT JOIN wax_users u ON c.user_id = u.id
       WHERE c.mix_id = $1
       ORDER BY c.created_at DESC`,
      [mixId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Get comments error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/comments - add comment
app.post('/api/comments', async (req, res) => {
  try {
    const { userId, mixId, text } = req.body;

    if (!userId || !mixId || !text) {
      return res.status(400).json({ error: 'Missing required fields: userId, mixId, text' });
    }

    const result = await pool.query(
      `INSERT INTO wax_comments (user_id, mix_id, text) VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, mixId, text]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Create comment error:', err);
    res.status(500).json({ error: err.message });
  }
});

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

app.listen(PORT, () => console.log(`House server running on port ${PORT}`));
