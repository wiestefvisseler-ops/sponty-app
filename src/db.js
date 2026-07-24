'use strict';

/* ------------------------------------------------------------------ *
 *  db.js — one Postgres query interface for the whole backend.
 *
 *  Production: connects to Supabase via DATABASE_URL (node-postgres pool).
 *  Local dev / tests: if there's no DATABASE_URL, it spins up an in-memory
 *  Postgres (pglite, WASM) and auto-loads db/schema.sql — so the exact same
 *  SQL can be exercised locally without a database.
 *
 *  - query(text, params)  -> { rows, rowCount }
 *  - tx(fn)               -> runs fn(q) inside a transaction; q is a query
 *                            function bound to that single connection. Use it
 *                            (with SELECT ... FOR UPDATE) to serialize matching
 *                            per group so concurrent presses can't race.
 * ------------------------------------------------------------------ */

const url = process.env.DATABASE_URL || '';
const isLocal = url.includes('localhost') || url.includes('127.0.0.1');

let query;
let tx;
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
  query = (text, params) => pool.query(text, params);
  tx = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await fn((t, p) => client.query(t, p));
      await client.query('commit');
      return result;
    } catch (e) {
      try { await client.query('rollback'); } catch {}
      throw e;
    } finally {
      client.release();
    }
  };
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
  const norm = async (t, p) => { const r = await pg.query(t, p || []); return { rows: r.rows, rowCount: r.affectedRows }; };
  query = async (t, p) => { await ready; return norm(t, p); };
  tx = async (fn) => {
    await ready;
    return pg.transaction(async (txc) => {
      const q = async (t, p) => { const r = await txc.query(t, p || []); return { rows: r.rows, rowCount: r.affectedRows }; };
      return fn(q);
    });
  };
}

module.exports = { query, tx, ready };
