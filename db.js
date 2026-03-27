const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  try {
    // Create wax_users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wax_users (
        id SERIAL PRIMARY KEY,
        google_id TEXT UNIQUE NOT NULL,
        email TEXT NOT NULL,
        name TEXT,
        picture TEXT,
        display_name TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create wax_mixes table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wax_mixes (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES wax_users(id),
        title TEXT NOT NULL,
        description TEXT,
        tracks JSONB NOT NULL,
        cuts JSONB,
        effects JSONB,
        label_url TEXT,
        disc_color INTEGER DEFAULT 0,
        plays INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create wax_likes table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wax_likes (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES wax_users(id),
        mix_id INTEGER REFERENCES wax_mixes(id),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, mix_id)
      );
    `);

    // Create wax_comments table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wax_comments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES wax_users(id),
        mix_id INTEGER REFERENCES wax_mixes(id),
        text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Database initialization error:', err);
    throw err;
  }
}

module.exports = { pool, initDB };
