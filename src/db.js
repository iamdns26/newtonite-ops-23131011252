const fs = require('fs');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://ops:ops@localhost:5432/ops', max: 20 });

// Run fn inside one DB transaction (commit on success, rollback on any error).
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

const ensureSchema = () => pool.query(fs.readFileSync(__dirname + '/schema.sql', 'utf8'));

module.exports = { pool, tx, ensureSchema };
