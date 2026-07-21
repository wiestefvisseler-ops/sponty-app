'use strict';

/* ------------------------------------------------------------------ *
 *  db.js — one Postgres query interface for the whole backend.
 *
 *  Production: connects to Supabase via DATABASE_URL (node-postgres pool).
 *  Local dev / tests: if there's no DATABASE_URL, it spins up an in-memory
 *  Postgres (pglite, WASM) and auto-loads db/schema.sql — so the exact same
 *  SQL can be exercised locally without a database. (pglite data is NOT
 *  persisted; that's fine for dev/tests.)
 *
 *  Everything returns { rows, rowCount } so callers don't care which backend.
 * ------------------------------------------------------------------ */

const url = process.env.DATABASE_URL || '';
const isLocal = url.includes('localhost') || url.includes('127.0.0.1');

let queryImpl;
let ready = Promise.resolve();

if (url) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (e) => console.error('  ⚠️  pg pool error:', e.message));
  queryImpl = (text, params) => pool.query(text, params);
  console.log('  🗄  Postgres via DATABASE_URL');
} else {
  const { PGlite } = require('@electric-sql/pglite');
  const fs = require('fs');
  const path = require('path');
  const pg = new PGlite();
  ready = (async () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    await pg.exec(schema);
    console.log('  🧪  in-memory pglite (no DATABASE_URL) — not persisted');
  })();
  queryImpl = async (text, params) => {
    await ready;
    const r = await pg.query(text, params || []);
    return { rows: r.rows, rowCount: r.affectedRows };
  };
}

const query = (text, params) => queryImpl(text, params);

module.exports = { query, ready };
