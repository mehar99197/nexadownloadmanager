'use strict';

/**
 * Apply the database schema, then any numbered migration in src/migrations/.
 *
 *   npm run migrate            # apply everything pending
 *   npm run migrate -- --status  # list applied vs pending, change nothing
 *
 * The base schema (config/schema.js) is idempotent and always runs first, so a
 * fresh database and an existing one both end up correct. Anything that schema
 * cannot express (backfills, data rewrites, destructive changes) goes in a
 * migration file named `NNN-description.js` exporting `async up(conn)`.
 *
 * Applied migrations are recorded in `schema_migrations`, and each one runs
 * inside a transaction, so a failure leaves the database on the last good step.
 */
const fs = require('fs');
const path = require('path');

const { getPool, query, execute, withTransaction } = require('../config/db');
const { initSchema } = require('../config/schema');

const DIR = path.join(__dirname, '..', 'migrations');

async function ensureLedger() {
  await execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(191) NOT NULL PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

function available() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).sort();
}

async function applied() {
  const rows = await query('SELECT name FROM schema_migrations');
  return new Set(rows.map((r) => r.name));
}

async function main() {
  const statusOnly = process.argv.includes('--status');

  console.log('[migrate] applying base schema…');
  await initSchema();
  await ensureLedger();

  const done = await applied();
  const all = available();
  const pending = all.filter((n) => !done.has(n));

  if (statusOnly) {
    for (const name of all)
      console.log(`  ${done.has(name) ? 'applied ' : 'PENDING '} ${name}`);
    if (!all.length) console.log('  (no migration files)');
    return;
  }

  if (!pending.length) {
    console.log('[migrate] nothing pending');
    return;
  }
  for (const name of pending) {
    const migration = require(path.join(DIR, name));
    if (typeof migration.up !== 'function')
      throw new Error(`${name} does not export an async up(conn)`);
    console.log(`[migrate] ${name}…`);
    await withTransaction(async (conn) => {
      await migration.up(conn);
      await conn.execute('INSERT INTO schema_migrations (name) VALUES (?)', [name]);
    });
  }
  console.log(`[migrate] applied ${pending.length} migration(s)`);
}

main()
  .then(async () => { (await getPool()).end(); process.exit(0); })
  .catch(async (err) => {
    console.error('[migrate] failed:', err.message);
    try { (await getPool()).end(); } catch { /* pool already gone */ }
    process.exit(1);
  });
