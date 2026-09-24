'use strict';

/**
 * Team invitations age out (AUDIT.md M-12).
 *
 * `team_members.invited_at` was written on every invite and read by nothing,
 * so a link worked for ever: a year-old forwarded invitation still joined the
 * team, and revoking it meant the owner noticing and deleting the row.
 *
 * The address check was always sound — only the invited address may accept —
 * so this is staleness rather than takeover. It still matters, because the
 * invited address is the one thing an attacker who reads an old mailbox
 * already has.
 *
 * Rows are aged with SQL rather than by waiting, and the TTL is pushed down to
 * one day for the same reason: a test that sleeps for fourteen days is not a
 * test.
 */

process.env.RATE_LIMIT_DISABLED = '1';
process.env.TEAM_INVITE_TTL_DAYS = '1';

const test = require('node:test');
const assert = require('node:assert/strict');

const srv = require('./helpers/testServer');

// The mock mailer logs the message, so the invite link can be read back the
// way the invitee would see it. resend answers { sent: true } and deliberately
// does not hand the token to the caller.
async function captureMail(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  try { await fn(); } finally { console.log = original; }
  return lines.join('\n');
}

function linkParam(mail, path, param) {
  const escaped = path.replace(/[/?]/g, (ch) => "\\" + ch);
  const re = new RegExp(escaped + "\\?" + param + "=([^\\s&\"'<]+)");
  const m = re.exec(mail);
  return m ? decodeURIComponent(m[1]) : null;
}

// Pull the row back in time. Anything past the TTL does; two days is clear of
// any clock skew between node and the database.
async function age(email, days) {
  await srv.query(
    'UPDATE team_members SET invited_at = DATE_SUB(NOW(), INTERVAL ? DAY) WHERE email = ?',
    [days, email]
  );
}

test('team invitations expire', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  // One team owner and one invitee, reused across the cases below.
  async function setup() {
    await srv.reset();
    const owner = srv.client();
    const o = await srv.makeUser(owner, 'teamowner');
    const bought = await owner.post(
      '/api/subscription/mock-complete',
      { plan: 'team', billingCycle: 'monthly' },
      { token: o.token }
    );
    assert.equal(bought.status, 200, bought.text);

    const member = srv.client();
    const m = await srv.makeUser(member, 'teammember');

    let token;
    const mail = await captureMail(async () => {
      const invited = await owner.post('/api/team/invites', { email: m.email }, { token: o.token });
      assert.equal(invited.status, 201, invited.text);
    });
    token = linkParam(mail, '/team/join', 'token');
    assert.ok(token, 'an invite link was mailed');
    return { owner, o, member, m, token };
  }

  // Resend rotates the token AND resets invited_at, so it is both the owner's
  // remedy for an expired invite and the only way to get a fresh plaintext one.
  async function resend(owner, o, email) {
    const [row] = await srv.query('SELECT id FROM team_members WHERE email = ?', [email]);
    const mail = await captureMail(async () => {
      const res = await owner.post(`/api/team/invites/${row.id}/resend`, {}, { token: o.token });
      assert.equal(res.status, 200, res.text);
    });
    const next = linkParam(mail, '/team/join', 'token');
    assert.ok(next, 'a fresh invite link was mailed');
    return next;
  }

  await t.test('a fresh invitation is accepted', async () => {
    const { member, m, token } = await setup();
    const res = await member.post('/api/team/join', { token }, { token: m.token });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.role, 'member');
  });

  await t.test('an invitation past the cut-off is refused, and says why', async () => {
    const { owner, o, member, m, token } = await setup();
    await age(m.email, 2);

    // Before sign-in, where the invitee first sees it.
    const anon = srv.client();
    const looked = await anon.get(`/api/team/invites/${encodeURIComponent(token)}`);
    assert.equal(looked.status, 410, looked.text);
    assert.equal(looked.body.error.code, 'INVITE_EXPIRED');
    // Actionable, rather than "no longer valid" with nothing to do about it.
    assert.match(looked.body.error.message, /expired/i);

    // And on the accept, which is the one that actually grants the seat.
    const joined = await member.post('/api/team/join', { token }, { token: m.token });
    assert.equal(joined.status, 410, joined.text);
    assert.equal(joined.body.error.code, 'INVITE_EXPIRED');

    // Nothing was granted on the way past, and the dead invite is not holding
    // a seat: counting it would turn a five-seat team into a four-seat one
    // with nothing on the roster explaining why.
    const roster = await owner.get('/api/team', { token: o.token });
    assert.equal(roster.body.data.used, 1, 'the owner alone');
    assert.equal(roster.body.data.members.length, 1, 'the row is still there');
    assert.equal(roster.body.data.members[0].expired, true, 'and is shown as dead');
    assert.equal(roster.body.data.canInvite, true, 'so the seat can be used again');
  });

  await t.test('resending revives it — the owner needs no other remedy', async () => {
    const { owner, o, member, m } = await setup();
    await age(m.email, 2);

    // rotateToken resets invited_at, so the resend is the documented way back.
    const fresh = await resend(owner, o, m.email);
    const joined = await member.post('/api/team/join', { token: fresh }, { token: m.token });
    assert.equal(joined.status, 200, joined.text);
    assert.equal(joined.body.data.role, 'member');
  });

  // GET /api/team saying canInvite:true is only half of M-12: the invite route
  // itself used to count every roster row, dead invitations included, and
  // answered TEAM_FULL to the very invitation the roster said had room.
  await t.test('an expired invitation frees its seat for a NEW invitation, not just on the roster', async () => {
    const { owner, o, m } = await setup();
    // Fill the five-seat team: the owner, the setup invite and three more.
    const stamp = Date.now();
    await captureMail(async () => {
      for (const n of ['fill1', 'fill2', 'fill3']) {
        const res = await owner.post('/api/team/invites', { email: `${n}x${stamp}@example.test` }, { token: o.token });
        assert.equal(res.status, 201, res.text);
      }
      const over = await owner.post('/api/team/invites', { email: `over${stamp}@example.test` }, { token: o.token });
      assert.equal(over.status, 400, over.text);
      assert.equal(over.body.error.code, 'TEAM_FULL');
    });

    // One of them ages out: the roster says a seat is free again…
    await age(m.email, 2);
    const roster = await owner.get('/api/team', { token: o.token });
    assert.equal(roster.body.data.used, 4);
    assert.equal(roster.body.data.canInvite, true);

    // …and the invite route agrees, rather than answering TEAM_FULL.
    await captureMail(async () => {
      const res = await owner.post('/api/team/invites', { email: `after${stamp}@example.test` }, { token: o.token });
      assert.equal(res.status, 201, res.text);
    });
    const now = await owner.get('/api/team', { token: o.token });
    assert.equal(now.body.data.used, 5);
    assert.equal(now.body.data.canInvite, false);
  });

  // The count and the insert were two separate statements, so invitations
  // sent together all read the same "room for one more" and all went in.
  await t.test('invitations sent at the same moment cannot exceed the seats', async () => {
    const { owner, o } = await setup();
    // Owner + the setup invite hold two of five seats: three more fit.
    const stamp = Date.now();
    const emails = Array.from({ length: 8 }, (_, i) => `race${i}x${stamp}@example.test`);
    let results;
    await captureMail(async () => {
      results = await Promise.all(emails.map((email) =>
        owner.post('/api/team/invites', { email }, { token: o.token })));
    });
    const created = results.filter((r) => r.status === 201).length;
    const refused = results.filter((r) => r.status === 400 && r.body?.error?.code === 'TEAM_FULL').length;
    assert.equal(created, 3, results.map((r) => r.status).join(','));
    assert.equal(refused, emails.length - 3);

    const roster = await owner.get('/api/team', { token: o.token });
    assert.equal(roster.body.data.used, 5);
    assert.equal(roster.body.data.members.length, 4);
  });

  await t.test('an accepted membership does not expire', async () => {
    const { owner, o, member, m, token } = await setup();
    assert.equal((await member.post('/api/team/join', { token }, { token: m.token })).status, 200);

    // invited_at is history once the row is active; ageing it must change
    // nothing. Getting this wrong would cut off paying members after a
    // fortnight, which is a far worse bug than the one being fixed.
    await age(m.email, 400);
    const lic = await member.get('/api/user/license', { token: m.token });
    assert.equal(lic.status, 200, lic.text);
    assert.equal(lic.body.data.viaTeam, true);
    assert.equal(lic.body.data.plan, 'team');

    const roster = await owner.get('/api/team', { token: o.token });
    assert.equal(roster.body.data.used, 2);
  });

  await srv.stop();
});
