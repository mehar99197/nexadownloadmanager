'use strict';

/**
 * The adversarial pass the audit had never done: hostile input against the
 * real app, rather than a reading of the code that handles it.
 *
 * Everything before this asked "is this route guarded?". These ask "what
 * happens when someone actively tries", which is a different question and the
 * one that finds the gap between what a validator is believed to reject and
 * what it actually rejects.
 *
 * Deliberately run here and never against production: several of these would
 * trip the live rate limiter, and one of them writes a row on purpose.
 *
 * Scope — each is a class, not a payload:
 *
 *  1. SQL injection, aimed at the one real risk in this codebase: `LIMIT` and
 *     `OFFSET` are string-interpolated into a dozen queries because MySQL will
 *     not take them as placeholders. Every one is wrapped in Number()/Math.min
 *     first. That is correct, and it is exactly the kind of correct that one
 *     careless model change undoes silently.
 *  2. Mass assignment — can a caller promote themselves by adding a field?
 *  3. Prototype pollution through a JSON body.
 *  4. JWT forgery, including `alg: none`.
 *  5. IDOR — one account reaching another's rows.
 *  6. Oversized and malformed bodies.
 */

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const srv = require('./helpers/testServer');

// One list, reused, so adding a payload covers every parameter at once.
const SQLI = [
  "1; DROP TABLE users--",
  "1 UNION SELECT password_hash, 2, 3, 4, 5, 6, 7, 8 FROM users--",
  "1' OR '1'='1",
  '1 OR 1=1',
  "-1 UNION ALL SELECT NULL--",
  '1e9999',
  '0x41',
  '1,1',
];

test('hostile input', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  await t.test('an injected LIMIT or page never reaches the database', async () => {
    await srv.reset();
    const api = srv.client();
    const email = 'abuse-staff@example.test';
    await srv.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified)
       VALUES ('Staff', ?, ?, 'admin', 1)`,
      [email, await bcrypt.hash('abuse-password', 4)]
    );
    const login = await api.post('/api/admin/login', { email, password: 'abuse-password' });
    const token = login.body.data.token;

    for (const payload of SQLI) {
      for (const param of ['limit', 'page']) {
        const res = await api.get(
          `/api/admin/users?${param}=${encodeURIComponent(payload)}`,
          { token }
        );
        // Either the schema refuses it (400) or the number coercion renders it
        // harmless (200). What must never happen is a 500 — that is the shape
        // of a query the driver could not parse, i.e. the injection landed.
        assert.ok(
          res.status === 400 || res.status === 200,
          `${param}=${payload} answered ${res.status}: ${res.text.slice(0, 200)}`
        );
        if (res.status === 200) {
          assert.equal(res.text.includes('$2a$'), false, 'no hash leaked');
          assert.equal(res.text.includes('$2b$'), false, 'no hash leaked');
        }
      }
    }

    // And the table is still there, which is the blunt version of the same
    // question.
    const [{ c }] = await srv.query('SELECT COUNT(*) c FROM users');
    assert.ok(Number(c) >= 1, 'users table survived');
  });

  await t.test('a search term is data, not syntax', async () => {
    await srv.reset();
    const api = srv.client();
    const email = 'abuse-search@example.test';
    await srv.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified)
       VALUES ('Staff', ?, ?, 'admin', 1)`,
      [email, await bcrypt.hash('abuse-password', 4)]
    );
    const token = (await api.post('/api/admin/login', { email, password: 'abuse-password' })).body.data.token;

    for (const payload of ["%' OR '1'='1", "'; DELETE FROM users WHERE '1'='1", '\\', '%', '_']) {
      const res = await api.get(`/api/admin/users?q=${encodeURIComponent(payload)}`, { token });
      assert.ok(res.status === 200 || res.status === 400, `q=${payload} answered ${res.status}`);
    }
    const [{ c }] = await srv.query('SELECT COUNT(*) c FROM users');
    assert.equal(Number(c), 1, 'nothing was deleted');
  });

  await t.test('a caller cannot promote themselves by adding a field', async () => {
    await srv.reset();
    const api = srv.client();

    // Mass assignment at the front door.
    const reg = await api.post('/api/auth/register', {
      name: 'Climber',
      email: 'climber@example.test',
      password: 'a-strong-password',
      role: 'admin',
      banned: 0,
      email_verified: 1,
      id: 1,
    });
    assert.ok(reg.status === 201 || reg.status === 200 || reg.status === 400, reg.text);

    const rows = await srv.query('SELECT role, email_verified FROM users WHERE email = ?', ['climber@example.test']);
    if (rows.length) {
      assert.equal(rows[0].role, 'user', 'role must not be settable at registration');
      // Verification is something the mail proves, not something the body claims.
      assert.equal(Number(rows[0].email_verified), 0, 'email_verified must not be settable');
    }
  });

  await t.test('a profile update cannot change the role either', async () => {
    await srv.reset();
    const api = srv.client();
    const user = await srv.makeUser(api);

    await api.put('/api/user/me', { name: 'New Name', role: 'admin' }, { token: user.token });
    const [row] = await srv.query('SELECT role, name FROM users WHERE email = ?', [user.email]);
    assert.equal(row.role, 'user', 'role survived a hostile profile update');
  });

  await t.test('__proto__ in a body does not pollute Object.prototype', async () => {
    await srv.reset();
    const api = srv.client();

    // eslint-disable-next-line no-proto
    const before = Object.prototype.polluted;
    await api.post('/api/auth/register', {
      name: 'Polluter',
      email: 'polluter@example.test',
      password: 'a-strong-password',
      __proto__: { polluted: 'yes' },
      constructor: { prototype: { polluted: 'yes' } },
    });
    await api.post('/api/contact', {
      name: 'Polluter', email: 'polluter@example.test',
      subject: 'Hello', message: 'Hello there, this is a message.',
      __proto__: { polluted: 'yes' },
    });

    assert.equal(Object.prototype.polluted, before, 'Object.prototype was modified');
    assert.equal({}.polluted, undefined);
  });

  await t.test('a forged or unsigned token is not a session', async () => {
    await srv.reset();
    const api = srv.client();
    const user = await srv.makeUser(api);

    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const [, payload] = user.token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

    const forged = [
      // alg:none — the classic, and the one a hand-rolled verifier falls for.
      `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, sub: 1, role: 'root' })}.`,
      // Right shape, wrong signature.
      `${user.token.split('.').slice(0, 2).join('.')}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      // Claims edited, original signature kept.
      `${user.token.split('.')[0]}.${b64({ ...claims, role: 'root' })}.${user.token.split('.')[2]}`,
      'not.a.token',
      '',
    ];

    for (const token of forged) {
      const res = await api.get('/api/user/me', { token });
      assert.equal(res.status, 401, `a forged token answered ${res.status}`);
    }
    // The real one still works, so the assertions above are not passing by
    // accident on a broken client.
    assert.equal((await api.get('/api/user/me', { token: user.token })).status, 200);
  });

  await t.test('one account cannot read another’s rows by guessing an id', async () => {
    await srv.reset();
    const api = srv.client();
    const alice = await srv.makeUser(api, 'alice');
    const bob = await srv.makeUser(api, 'bob');

    const [bobRow] = await srv.query('SELECT id FROM users WHERE email = ?', [bob.email]);

    // Every id-taking route a customer bearer can reach.
    for (const path of [
      `/api/user/${bobRow.id}`,
      `/api/admin/users/${bobRow.id}`,
      `/api/admin/users/${bobRow.id}/details`,
    ]) {
      const res = await api.get(path, { token: alice.token });
      assert.ok(
        res.status === 401 || res.status === 403 || res.status === 404,
        `${path} answered ${res.status}: ${res.text.slice(0, 160)}`
      );
      assert.equal(res.text.includes(bob.email), false, `${path} leaked the other account`);
    }
  });

  await t.test('a malformed or oversized body is refused, not crashed on', async () => {
    await srv.reset();
    const api = srv.client();

    // Type confusion: arrays and objects where a string is expected.
    const shapes = [
      { name: ['a', 'b'], email: 'x@example.test', password: 'a-strong-password' },
      { name: { $ne: null }, email: 'x@example.test', password: 'a-strong-password' },
      { name: 'x', email: ['x@example.test'], password: 'a-strong-password' },
      { name: 'x', email: 'x@example.test', password: { toString: 'no' } },
      { name: 'A'.repeat(100_000), email: 'x@example.test', password: 'a-strong-password' },
    ];
    for (const body of shapes) {
      const res = await api.post('/api/auth/register', body);
      assert.ok(
        res.status === 400 || res.status === 413,
        `answered ${res.status}: ${res.text.slice(0, 160)}`
      );
      assert.equal(res.status === 500, false, 'a validator should refuse, not throw');
    }
  });

  await t.test('a 500 never carries the query, the table or the stack', async () => {
    await srv.reset();
    const api = srv.client();

    // Sweep the public surface with junk and read every non-2xx body: M-04 is
    // about what leaks on the way out, and it is easiest to break by accident.
    const paths = ['/api/auth/login', '/api/auth/register', '/api/contact', '/api/auth/forgot-password'];
    for (const path of paths) {
      for (const body of [{}, { email: 1 }, { email: "' OR 1=1--" }, null]) {
        const res = await api.post(path, body);
        const text = res.text || '';
        for (const leak of ['SELECT ', 'INSERT ', 'sqlMessage', 'ER_', 'at Object.', 'node_modules']) {
          assert.equal(text.includes(leak), false, `${path} leaked "${leak}": ${text.slice(0, 200)}`);
        }
      }
    }
  });

  await srv.stop();
});
