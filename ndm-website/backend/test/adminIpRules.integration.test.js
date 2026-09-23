'use strict';

/**
 * The panel-managed IP allow-list, end to end (AUDIT.md M-06).
 *
 * ADMIN_ALLOWED_IPS is set here to an address that is NOT the test client's,
 * which is the only configuration in which this feature is observable: with
 * the caller already covered by .env, every rule below would be decoration and
 * the lock-out guard could never fire. So the .env half admits 203.0.113.1 and
 * nobody else, and the suite has to open the gate for itself through the
 * database — which is the thing being tested.
 */

process.env.RATE_LIMIT_DISABLED = '1';
process.env.ADMIN_ALLOWED_IPS = '203.0.113.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const srv = require('./helpers/testServer');
const AdminIpRule = require('../src/models/AdminIpRule');

const PASSWORD = 'ip-rules-password';

async function seedRoot() {
  const email = process.env.ROOT_ADMIN_EMAIL;
  await srv.query(
    `INSERT INTO users (name, email, password_hash, role, email_verified)
     VALUES ('Creator', ?, ?, 'root', 1)`,
    [email, await bcrypt.hash(PASSWORD, 4)]
  );
  return email;
}

// Straight to the table: the gate has to be open before a sign-in is possible,
// and opening it through the API would need a sign-in first.
async function allow(value, label = null) {
  await srv.query('INSERT INTO admin_ip_rules (value, label) VALUES (?, ?)', [value, label]);
  AdminIpRule.dropCache();
}

async function signIn(api, email) {
  const res = await api.post('/api/root/login', { email, password: PASSWORD });
  assert.equal(res.status, 200, res.text);
  return res.body.data.token;
}

test('the panel IP allow-list', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  await t.test('an address only the database allows can still reach the panel', async () => {
    await srv.reset();
    AdminIpRule.dropCache();
    const email = await seedRoot();
    const api = srv.client();

    // .env admits 203.0.113.1 only, so the gate is shut to this client.
    const shut = await api.post('/api/root/login', { email, password: PASSWORD });
    assert.equal(shut.status, 403, shut.text);
    assert.equal(shut.body.error.code, 'IP_FORBIDDEN');

    // A row in the table is enough to open it — no restart, no .env edit.
    await allow('127.0.0.1', 'the test client');
    const token = await signIn(api, email);
    assert.equal((await api.get('/api/root/me', { token })).status, 200);
  });

  await t.test('a CIDR range covers an address nobody listed by hand', async () => {
    await srv.reset();
    AdminIpRule.dropCache();
    const email = await seedRoot();
    const api = srv.client();
    // The whole point of M-06: one entry that survives the ISP moving you.
    await allow('127.0.0.0/8', 'loopback range');
    const token = await signIn(api, email);
    assert.equal((await api.get('/api/root/me', { token })).status, 200);
  });

  await t.test('the screen reports the whole gate, not only its own half', async () => {
    await srv.reset();
    AdminIpRule.dropCache();
    const email = await seedRoot();
    const api = srv.client();
    await allow('127.0.0.1', 'the test client');
    const token = await signIn(api, email);

    const { body } = await api.get('/api/root/ip-rules', { token });
    assert.deepEqual(body.data.envList, ['203.0.113.1'], 'the .env half is shown read-only');
    assert.equal(body.data.rules.length, 1);
    assert.equal(body.data.rules[0].value, '127.0.0.1');
    assert.equal(body.data.openToEveryone, false);
    assert.ok(body.data.yourIp, 'the address the server actually sees');
  });

  await t.test('adding, disabling and removing an entry', async () => {
    await srv.reset();
    AdminIpRule.dropCache();
    const email = await seedRoot();
    const api = srv.client();
    await allow('127.0.0.1', 'the test client');
    const token = await signIn(api, email);

    const added = await api.post('/api/root/ip-rules',
      { value: '198.51.100.0/24', label: 'the office' }, { token });
    assert.equal(added.status, 201, added.text);

    // Same entry twice is a 409, not a second row.
    const again = await api.post('/api/root/ip-rules', { value: '198.51.100.0/24' }, { token });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ALREADY_EXISTS');

    // Something that could never match is refused where it is typed.
    const junk = await api.post('/api/root/ip-rules', { value: 'the office wifi' }, { token });
    assert.equal(junk.status, 400, junk.text);

    const id = added.body.data.id;
    assert.equal((await api.patch(`/api/root/ip-rules/${id}`, { enabled: false }, { token })).status, 200);
    assert.equal((await api.patch(`/api/root/ip-rules/${id}`, { enabled: true }, { token })).status, 200);
    assert.equal((await api.del(`/api/root/ip-rules/${id}`, { token })).status, 200);
    assert.equal((await api.del(`/api/root/ip-rules/${id}`, { token })).status, 404);

    // Every one of those left a line in the audit log.
    const actions = (await srv.query(
      "SELECT action FROM audit_logs WHERE action LIKE 'root.ip_rule%' ORDER BY id"
    )).map((r) => r.action);
    assert.deepEqual(actions, [
      'root.ip_rule_added', 'root.ip_rule_disabled', 'root.ip_rule_enabled', 'root.ip_rule_removed',
    ]);
  });

  await t.test('the list refuses to lock its own editor out', async () => {
    await srv.reset();
    AdminIpRule.dropCache();
    const email = await seedRoot();
    const api = srv.client();
    await allow('127.0.0.1', 'the only way in');
    const token = await signIn(api, email);

    const [rule] = (await api.get('/api/root/ip-rules', { token })).body.data.rules;

    // Removing the only entry that admits this caller is refused, both ways.
    const disabled = await api.patch(`/api/root/ip-rules/${rule.id}`, { enabled: false }, { token });
    assert.equal(disabled.status, 409, disabled.text);
    assert.equal(disabled.body.error.code, 'WOULD_LOCK_YOU_OUT');

    const deleted = await api.del(`/api/root/ip-rules/${rule.id}`, { token });
    assert.equal(deleted.status, 409, deleted.text);
    assert.equal(deleted.body.error.code, 'WOULD_LOCK_YOU_OUT');

    // Still there, and the panel still answers.
    assert.equal((await api.get('/api/root/me', { token })).status, 200);

    // With a second way in, the first can go.
    assert.equal((await api.post('/api/root/ip-rules', { value: '127.0.0.0/8' }, { token })).status, 201);
    assert.equal((await api.del(`/api/root/ip-rules/${rule.id}`, { token })).status, 200);
    assert.equal((await api.get('/api/root/me', { token })).status, 200);
  });

  await t.test('* opens the gate and the screen says so', async () => {
    await srv.reset();
    AdminIpRule.dropCache();
    const email = await seedRoot();
    const api = srv.client();
    await allow('*', 'open while developing');
    const token = await signIn(api, email);
    const { body } = await api.get('/api/root/ip-rules', { token });
    assert.equal(body.data.openToEveryone, true);
  });

  await srv.stop();
});
