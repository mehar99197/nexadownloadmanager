'use strict';

/**
 * A Team membership grants something only while the OWNER's Team plan does.
 *
 * Two holes, both on the member's side of the roster:
 *
 *  1. GET /api/team and POST /api/team/join handed a member the owner's
 *     licence key unconditionally. Nothing clears the roster when the owner
 *     moves off Team, so after Team → Pro every former member kept reading the
 *     owner's (now Pro) key from /api/team — a paid plan leaked to people the
 *     owner is no longer paying for.
 *
 *  2. A banned owner's members stayed entitled through their device tokens.
 *     The licence-key path answers `banned` for the owner's ban, and the device
 *     path signs out a banned HOLDER, but the member's team plan was resolved
 *     without ever reading the owner's ban — so the members of a banned account
 *     kept validating as Team.
 */

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.EMAIL_VERIFICATION_REQUIRED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./helpers/testServer');

const FP_MEMBER = '7'.repeat(32);

async function quietly(fn) {
  const original = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = original; }
}

async function captureMail(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  try { await fn(); } finally { console.log = original; }
  return lines.join('\n');
}

function joinToken(mail) {
  const m = /\/team\/join\?token=([^\s&"'<]+)/.exec(mail);
  return m ? decodeURIComponent(m[1]) : null;
}

/** An owner on a paid Team plan, and one invited member who has not joined yet. */
async function teamWithInvite() {
  await srv.reset();
  const owner = srv.client();
  const o = await srv.makeUser(owner, 'entowner');
  const bought = await owner.post('/api/subscription/mock-complete',
    { plan: 'team', billingCycle: 'monthly' }, { token: o.token });
  assert.equal(bought.status, 200, bought.text);
  const ownerKey = (await owner.get('/api/user/license', { token: o.token })).body.data.licenseKey;
  assert.ok(ownerKey);

  const member = srv.client();
  const m = await srv.makeUser(member, 'entmember');
  const mail = await captureMail(async () => {
    const invited = await owner.post('/api/team/invites', { email: m.email }, { token: o.token });
    assert.equal(invited.status, 201, invited.text);
  });
  const token = joinToken(mail);
  assert.ok(token, 'an invite link was mailed');
  return { owner, o, ownerKey, member, m, token };
}

async function signInDevice(member, m, fingerprint) {
  const app = srv.client();
  const code = await app.post('/api/device/code',
    { device_fingerprint: fingerprint, device_name: 'Member PC', app_version: '0.3.0' });
  assert.equal(code.status, 200, code.text);
  const approved = await member.post('/api/device/approve',
    { user_code: code.body.data.userCode }, { token: m.token });
  assert.equal(approved.status, 200, approved.text);
  const poll = await app.post('/api/device/token',
    { device_code: code.body.data.deviceCode, device_fingerprint: fingerprint });
  assert.equal(poll.status, 200, poll.text);
  return { app, deviceToken: poll.body.data.deviceToken };
}

const ownerIdOf = async (email) => (await srv.query('SELECT id FROM users WHERE email = ?', [email]))[0].id;

test('team membership entitlements follow the owner', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  await t.test('a member of a live Team plan is given the key (unchanged)', async () => {
    const { ownerKey, member, m, token } = await teamWithInvite();
    const joined = await member.post('/api/team/join', { token }, { token: m.token });
    assert.equal(joined.status, 200, joined.text);
    assert.equal(joined.body.data.usable, true);
    assert.equal(joined.body.data.licenseKey, ownerKey);
    const team = await member.get('/api/team', { token: m.token });
    assert.equal(team.body.data.role, 'member');
    assert.equal(team.body.data.licenseKey, ownerKey);
  });

  await t.test('after Team → Pro a former member no longer reads the owner\'s key', async () => {
    const { o, ownerKey, member, m, token } = await teamWithInvite();
    const joined = await member.post('/api/team/join', { token }, { token: m.token });
    assert.equal(joined.status, 200, joined.text);

    // The owner moves to Pro. The roster row is still there — nothing clears it.
    await srv.query("UPDATE subscriptions SET plan = 'pro', seats = 1 WHERE user_id = ?",
      [await ownerIdOf(o.email)]);

    const team = await member.get('/api/team', { token: m.token });
    assert.equal(team.status, 200, team.text);
    assert.equal(team.body.data.role, 'member');
    assert.equal(team.body.data.usable, false);
    assert.equal(team.body.data.licenseKey, null, 'no key once the team is gone');
    assert.ok(!team.text.includes(ownerKey), 'the owner\'s Pro key is nowhere in the answer');

    // The dashboard's licence endpoint already falls back to the member's own row.
    const lic = await member.get('/api/user/license', { token: m.token });
    assert.equal(lic.body.data.viaTeam, false);
    assert.notEqual(lic.body.data.licenseKey, ownerKey);
  });

  await t.test('joining a leftover invite after Team → Pro does not hand out the key', async () => {
    const { o, ownerKey, member, m, token } = await teamWithInvite();
    await srv.query("UPDATE subscriptions SET plan = 'pro', seats = 1 WHERE user_id = ?",
      [await ownerIdOf(o.email)]);
    const joined = await member.post('/api/team/join', { token }, { token: m.token });
    assert.equal(joined.status, 200, joined.text);
    assert.equal(joined.body.data.usable, false);
    assert.equal(joined.body.data.licenseKey, null);
    assert.ok(!joined.text.includes(ownerKey));
  });

  await t.test('a banned owner\'s members lose the team plan on their devices', async () => {
    const { o, ownerKey, member, m, token } = await teamWithInvite();
    assert.equal((await member.post('/api/team/join', { token }, { token: m.token })).status, 200);
    const { app, deviceToken } = await quietly(() => signInDevice(member, m, FP_MEMBER));

    const before = await app.post('/api/license/validate',
      { device_token: deviceToken, device_fingerprint: FP_MEMBER });
    assert.equal(before.body.valid, true, JSON.stringify(before.body));
    assert.equal(before.body.plan, 'team');

    await srv.query('UPDATE users SET banned = 1 WHERE email = ?', [o.email]);

    const after = await app.post('/api/license/validate',
      { device_token: deviceToken, device_fingerprint: FP_MEMBER });
    // The member is not banned: they keep their machine signed in, on their own
    // (Free) plan — never the banned owner's Team plan.
    assert.notEqual(after.body.plan, 'team', JSON.stringify(after.body));
    if (after.body.valid) assert.equal(after.body.plan, 'free');

    const beat = await app.post('/api/license/heartbeat',
      { device_token: deviceToken, device_fingerprint: FP_MEMBER });
    assert.notEqual(beat.body.plan, 'team', JSON.stringify(beat.body));

    // And the site stops presenting the banned owner's plan and key.
    const lic = await member.get('/api/user/license', { token: m.token });
    assert.equal(lic.body.data.viaTeam, false);
    assert.notEqual(lic.body.data.licenseKey, ownerKey);
    const team = await member.get('/api/team', { token: m.token });
    assert.equal(team.body.data.usable, false);
    assert.equal(team.body.data.licenseKey, null);
  });

  await srv.stop();
});
