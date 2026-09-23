'use strict';
/**
 * Does this base's initSchema migrate a database that the DEPLOYED lineage
 * created, or does it need a hand?
 *
 * Production's schema was written by windows-fixes-v3: user_sessions has a
 * `realm` column and none of the rotation columns, the indexes are named
 * differently, and eight tables this base creates do not exist there at all.
 * CREATE TABLE IF NOT EXISTS says nothing about any of that, so the answer has
 * to come from running it rather than reading it.
 *
 * Usage:  node test/tools/migrate-check.js <old-backend-dir> <new-backend-dir>
 *
 * Both arguments are backend checkouts. Point the first at whatever wrote the
 * database you are about to deploy over — a clone at the deployed commit — and
 * the second at this one. It needs the portable test server (testdb.sh up);
 * it creates and drops its own databases and touches nothing else.
 */
const path = require('path');
const mysql = require(path.join(process.argv[3], 'node_modules', 'mysql2', 'promise'));

const DB = 'ndm_migrate_check';
const CONN = {
  host: '127.0.0.1', port: 3399, user: 'root', password: 'root', multipleStatements: true,
};

function envFor(dir) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    MYSQL_HOST: '127.0.0.1', MYSQL_PORT: '3399', MYSQL_USER: 'root',
    MYSQL_PASS: 'root', MYSQL_DB: DB,
    JWT_SECRET: 'test_jwt_secret_value_that_is_long_enough_x1',
    JWT_ADMIN_SECRET: 'test_admin_secret_value_long_enough_x2',
    LICENSE_JWT_SECRET: 'test_license_secret_value_long_enough_x3',
    JWT_ROOT_SECRET: 'test_root_secret_value_long_enough_x4',
    FRONTEND_URL: 'http://localhost:5173',
    ROOT_ADMIN_EMAIL: 'creator@example.test',
    PASSWORD_BREACH_CHECK: 'false',
    _DIR: dir,
  };
}

function runSchema(dir) {
  // A child process, because the two checkouts' config/env.js and config/db.js
  // are different modules that both want to be the one in require.cache.
  const { spawnSync } = require('child_process');
  const script = `
    const { initSchema } = require(${JSON.stringify(path.join(dir, 'src/config/schema.js'))});
    initSchema().then(async () => {
      console.log('SCHEMA_OK');
      process.exit(0);
    }).catch((err) => { console.error('SCHEMA_FAIL', err && err.message); process.exit(1); });
  `;
  const res = spawnSync(process.execPath, ['-e', script], {
    env: envFor(dir), cwd: dir, encoding: 'utf8', timeout: 120000,
  });
  return { ok: res.status === 0, out: `${res.stdout || ''}${res.stderr || ''}`.trim() };
}

async function describe(conn, db) {
  const [cols] = await conn.query(
    `SELECT table_name, column_name, column_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = ?
      ORDER BY table_name, column_name`, [db]
  );
  return cols.map((c) => `${c.TABLE_NAME || c.table_name}.${c.COLUMN_NAME || c.column_name} ${c.COLUMN_TYPE || c.column_type}`);
}

(async () => {
  const deployed = process.argv[2];
  const fresh = process.argv[3];
  const conn = await mysql.createConnection(CONN);

  // 1. A database shaped like production: the deployed lineage's schema.
  await conn.query(`DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const first = runSchema(deployed);
  console.log(`deployed lineage schema: ${first.ok ? 'ok' : 'FAILED'}`);
  if (!first.ok) { console.log(first.out); process.exit(1); }

  const before = await describe(conn, DB);
  console.log(`  ${before.length} columns across ${new Set(before.map((c) => c.split('.')[0])).size} tables`);

  // 2. This base's initSchema over the top — the deploy.
  const second = runSchema(fresh);
  console.log(`this base's migration over it: ${second.ok ? 'ok' : 'FAILED'}`);
  if (!second.ok) { console.log(second.out); process.exit(1); }
  const migrated = await describe(conn, DB);

  // 3. What this base builds from nothing, for comparison.
  const FRESH_DB = `${DB}_fresh`;
  await conn.query(`DROP DATABASE IF EXISTS ${FRESH_DB}; CREATE DATABASE ${FRESH_DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const third = (() => {
    const saved = process.env.MYSQL_DB;
    const { spawnSync } = require('child_process');
    const script = `
      const { initSchema } = require(${JSON.stringify(path.join(fresh, 'src/config/schema.js'))});
      initSchema().then(() => { console.log('SCHEMA_OK'); process.exit(0); })
        .catch((e) => { console.error('SCHEMA_FAIL', e && e.message); process.exit(1); });
    `;
    const res = spawnSync(process.execPath, ['-e', script], {
      env: { ...envFor(fresh), MYSQL_DB: FRESH_DB }, cwd: fresh, encoding: 'utf8', timeout: 120000,
    });
    process.env.MYSQL_DB = saved;
    return { ok: res.status === 0, out: `${res.stdout || ''}${res.stderr || ''}`.trim() };
  })();
  console.log(`this base from nothing: ${third.ok ? 'ok' : 'FAILED'}`);
  if (!third.ok) { console.log(third.out); process.exit(1); }
  const clean = await describe(conn, FRESH_DB);

  const migratedSet = new Set(migrated);
  const cleanSet = new Set(clean);
  const missing = clean.filter((c) => !migratedSet.has(c));
  const extra = migrated.filter((c) => !cleanSet.has(c));

  console.log('\n--- after migrating production-shaped -> this base ---');
  console.log(`missing (a fresh install has it, the migrated one does not): ${missing.length}`);
  for (const m of missing) console.log(`  MISSING ${m}`);
  console.log(`left over from the old lineage: ${extra.length}`);
  for (const e of extra) console.log(`  EXTRA   ${e}`);

  await conn.query(`DROP DATABASE ${DB}; DROP DATABASE ${FRESH_DB}`);
  await conn.end();
  process.exit(missing.length ? 2 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
