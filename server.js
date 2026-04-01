const express = require('express');
const path = require('path');
const { pool, initDB } = require('./db');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

// No-cache headers for SW and HTML so browsers always check for updates
app.use((req, res, next) => {
  if (req.path === '/sw.js' || req.path === '/' || req.path.endsWith('.html') || req.path.startsWith('/api/')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false }));
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
        m.label_url, m.disc_color, m.plays, m.created_at, m.parent_mix_id, m.arcs,
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
    const { userId, title, description, tracks, cuts, effects, labelUrl, discColor, parentMixId, arcs } = req.body;

    if (!userId || !title || !tracks) {
      return res.status(400).json({ error: 'Missing required fields: userId, title, tracks' });
    }

    const result = await pool.query(
      `INSERT INTO wax_mixes (user_id, title, description, tracks, cuts, effects, label_url, disc_color, parent_mix_id, arcs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [userId, title, description, JSON.stringify(tracks), JSON.stringify(cuts), JSON.stringify(effects), labelUrl, discColor || 0, parentMixId || null, JSON.stringify(arcs || [])]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Create mix error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/mixes/:id - delete a mix (owner only)
app.delete('/api/mixes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    // Verify ownership
    const check = await pool.query('SELECT user_id FROM wax_mixes WHERE id = $1', [id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Mix not found' });
    if (check.rows[0].user_id !== userId) return res.status(403).json({ error: 'Not authorized' });

    // Delete related data first, then the mix
    await pool.query('DELETE FROM wax_comments WHERE mix_id = $1', [id]);
    await pool.query('DELETE FROM wax_likes WHERE mix_id = $1', [id]);
    await pool.query('DELETE FROM wax_mixes WHERE id = $1', [id]);

    res.json({ deleted: true });
  } catch (err) {
    console.error('Delete mix error:', err);
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

// GET /api/mixes/:id/chain - returns full chain as circular linked list
// Walks up to root, then down through children. Returns array ordered
// so the requested mix is first, then continues through the chain.
app.get('/api/mixes/:id/chain', async (req, res) => {
  try {
    const { id } = req.params;
    // Walk UP to root (ancestors)
    const ancestors = await pool.query(`
      WITH RECURSIVE up AS (
        SELECT id, parent_mix_id, title, tracks, cuts, effects, arcs, disc_color, label_url, plays, 0 as depth
        FROM wax_mixes WHERE id = $1
        UNION ALL
        SELECT m.id, m.parent_mix_id, m.title, m.tracks, m.cuts, m.effects, m.arcs, m.disc_color, m.label_url, m.plays, u.depth + 1
        FROM wax_mixes m JOIN up u ON m.id = u.parent_mix_id
        WHERE u.depth < 50
      )
      SELECT * FROM up ORDER BY depth DESC
    `, [id]);

    // Find root ID
    const rootId = ancestors.rows.length > 0 ? ancestors.rows[0].id : parseInt(id);

    // Walk DOWN from root (descendants via parent_mix_id)
    const descendants = await pool.query(`
      WITH RECURSIVE down AS (
        SELECT id, parent_mix_id, title, tracks, cuts, effects, arcs, disc_color, label_url, plays, 0 as depth
        FROM wax_mixes WHERE id = $1
        UNION ALL
        SELECT m.id, m.parent_mix_id, m.title, m.tracks, m.cuts, m.effects, m.arcs, m.disc_color, m.label_url, m.plays, d.depth + 1
        FROM wax_mixes m JOIN down d ON m.parent_mix_id = d.id
        WHERE d.depth < 50
      )
      SELECT * FROM down ORDER BY depth ASC
    `, [rootId]);

    // Build full chain (root → child → grandchild → ...)
    const fullChain = descendants.rows;

    // Rotate so requested mix is first (circular linked list start)
    const startIdx = fullChain.findIndex(m => m.id === parseInt(id));
    const rotated = startIdx > 0
      ? fullChain.slice(startIdx).concat(fullChain.slice(0, startIdx))
      : fullChain;

    res.json(rotated);
  } catch (err) {
    console.error('Get chain error:', err);
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

    // userId might be a DB integer or a Google string ID from older clients
    let dbUserId = parseInt(userId, 10);
    if (isNaN(dbUserId)) {
      // Look up by google_id
      const lookup = await pool.query('SELECT id FROM wax_users WHERE google_id = $1', [String(userId)]);
      if (lookup.rows.length === 0) {
        return res.status(400).json({ error: 'User not found' });
      }
      dbUserId = lookup.rows[0].id;
    }

    const result = await pool.query(
      `INSERT INTO wax_comments (user_id, mix_id, text) VALUES ($1, $2, $3)
       RETURNING *`,
      [dbUserId, mixId, text]
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
        prompt: 'ONLY the center label of a vinyl record — NOT a full vinyl record, NOT showing any grooves or black vinyl. Just the circular label itself, filling the entire image edge-to-edge. The label is a perfect circle that takes up the full 1024x1024 canvas with a plain white background behind it. Specs: flat solid-color background (single color fill like red, blue, orange, navy, etc.), perfectly centered small spindle hole in the middle (tiny white dot), text arranged in horizontal lines — small label name/logo text near the top, larger song title text in the center area, smaller artist name below that. Typography is clean sans-serif or simple serif. Maximum 2 colors for the design (background color + white text, or background + one accent). NO illustrations, NO portraits, NO photographs, NO detailed artwork, NO gradients, NO metallic effects, NO 3D effects, NO vinyl grooves anywhere. Think of classic minimalist record labels: solid background, simple centered text, clean and flat. The entire image is JUST the circular label crop — nothing else. Theme/mood for colors and text style: ' + prompt,
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

// Client-side debug log collection — stored in memory + printed
const debugLogs = [];
app.post('/api/client-log', (req, res) => {
  const { tag, data } = req.body;
  const entry = { ts: new Date().toISOString(), tag: tag || 'LOG', data };
  debugLogs.push(entry);
  if (debugLogs.length > 200) debugLogs.shift();
  console.log(`[CLIENT ${entry.tag}]`, typeof data === 'string' ? data : JSON.stringify(data));
  res.json({ ok: true });
});

// GET recent debug logs
app.get('/api/debug-logs', (req, res) => {
  res.json(debugLogs);
});

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Catch-all: serve index.html
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`House server running on port ${PORT}`));
