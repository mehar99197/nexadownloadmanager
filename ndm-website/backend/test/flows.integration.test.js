'use strict';

/**
 * Integration tests for the flows the first suite left uncovered: password
 * reset, the Stripe webhook lifecycle (purchase → renewal → cancel → end),
 * team invitations, the contact inbox, reviews moderation, control-panel 2FA,
 * the creator (root) panel, self-service devices / export / deletion, and the
 * uploaded-installer download route the desktop updater resumes against.
 *
 * Same rules as api.integration.test.js: real app, real MySQL, skipped when no
 * database is reachable.
 */
process.env.RATE_LIMIT_DISABLED = '1';
process.env.RELEASE_UPLOAD_DIR = require('path').join(
  require('os').tmpdir(), `nexa-test-uploads-${process.pid}`
);

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const srv = require('./helpers/testServer');
const { resetDownloadCounter } = require('../src/utils/downloadCounter');

const dbUp = () => srv.available();

/** Run `fn` while capturing every console.log line the email mock prints. */
async function captureMail(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  try { await fn(); } finally { console.log = original; }
  return lines.join('\n');
}

function linkParam(mail, path, param) {
  const re = new RegExp(`${path.replace(/[/?]/g, '\\$&')}\\?${param}=([^\\s&"'<]+)`);
  const m = re.exec(mail);
  return m ? decodeURIComponent(m[1]) : null;
}

async function insertAdmin(email, role = 'admin', password = 'admin-password-123') {
  const hash = await bcrypt.hash(password, 12);
  await srv.query(
    'INSERT INTO users (name, email, password_hash, role, email_verified) VALUES (?, ?, ?, ?, 1)',
    [role === 'root' ? 'Creator' : 'Staff', email, hash, role]
  );
  return { email, password };
}

/** Stripe-shaped webhook bodies. Mock mode accepts unsigned JSON. */
function stripeEvent(type, object, id = `evt_${crypto.randomUUID()}`) {
  return { id, type, data: { object } };
}

test('backend flows', async (t) => {
  if (!(await dbUp())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  // ---------------------------------------------------------- password reset
  await t.test('password reset', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const email = 'reset-user@example.test';
    const password = 'original-password';
    await api.post('/api/auth/register', { name: 'Reset User', email, password });
    const first = await api.post('/api/auth/login', { email, password });
    assert.equal(first.status, 200, first.text);
    const firstToken = first.body.data.token;

    let resetToken;
    await t2.test('forgot-password answers 200 for any address and mails a link to a real one', async () => {
      const mail = await captureMail(async () => {
        const res = await api.post('/api/auth/forgot-password', { email });
        assert.equal(res.status, 200, res.text);
        const unknown = await api.post('/api/auth/forgot-password', { email: 'nobody@example.test' });
        assert.equal(unknown.status, 200, 'no user enumeration');
      });
      resetToken = linkParam(mail, '/reset-password', 'token');
      assert.ok(resetToken, 'reset link was mailed');
    });

    await t2.test('the link sets a new password and signs the account out everywhere', async () => {
      const res = await api.post('/api/auth/reset-password', { token: resetToken, password: 'brand-new-password' });
      assert.equal(res.status, 200, res.text);
      const refresh = await api.post('/api/auth/refresh');
      assert.equal(refresh.status, 401, 'old browser session is gone');
      const old = await api.post('/api/auth/login', { email, password });
      assert.equal(old.status, 401, 'old password no longer works');
      const fresh = await api.post('/api/auth/login', { email, password: 'brand-new-password' });
      assert.equal(fresh.status, 200, fresh.text);
      // The 7-day access token itself stays valid until it expires (stateless).
      void firstToken;
    });

    await t2.test('the same link cannot be replayed to set a second password', async () => {
      const res = await api.post('/api/auth/reset-password', { token: resetToken, password: 'attacker-chosen' });
      assert.equal(res.status, 400, res.text);
      assert.equal(res.body.error.code, 'INVALID_TOKEN');
      const login = await api.post('/api/auth/login', { email, password: 'attacker-chosen' });
      assert.equal(login.status, 401);
    });

    await t2.test('a token of another type is refused', async () => {
      const res = await api.post('/api/auth/reset-password', { token: firstToken, password: 'whatever-else' });
      assert.equal(res.status, 400);
    });

    await t2.test('an over-long password is rejected before hashing', async () => {
      const res = await api.post('/api/auth/register', {
        name: 'X', email: 'long@example.test', password: 'p'.repeat(129),
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });
  });

  // --------------------------------------------- subscription via webhooks
  await t.test('Stripe webhook lifecycle: purchase, renewal, cancellation', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const { token, email } = await srv.makeUser(api, 'stripe');
    const me = await api.get('/api/user/me', { token });
    const userId = me.body.data.user.id;
    const licenseKey = (await api.get('/api/user/license', { token })).body.data.licenseKey;
    const device = 'c0ffee'.repeat(6).slice(0, 32);
    const T = Date.now();
    const stripeSub = `sub_${T}`;
    const customer = `cus_${T}`;
    const validate = () => api.post('/api/license/validate', { license_key: licenseKey, device_fingerprint: device });
    const status = async () => (await api.get('/api/subscription/status', { token })).body.data;

    await t2.test('a malformed event is a 400, not a crash', async () => {
      const res = await api.post('/api/webhooks/stripe', { hello: 'world' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid_event');
    });

    let expiryAfterPurchase;
    await t2.test('checkout.session.completed activates Pro and records the payment', async () => {
      const res = await api.post('/api/webhooks/stripe', stripeEvent('checkout.session.completed', {
        id: 'cs_1', customer, subscription: stripeSub, payment_intent: `pi_first_${T}`,
        amount_total: 500, currency: 'usd', metadata: { userId, plan: 'pro', billingCycle: 'monthly' },
      }));
      assert.equal(res.status, 200, res.text);
      const s = await status();
      assert.equal(s.plan, 'pro');
      assert.equal(s.status, 'active');
      assert.equal(s.cancelAtPeriodEnd, false);
      expiryAfterPurchase = new Date(s.expiryDate).getTime();
      assert.ok(expiryAfterPurchase > Date.now() + 27 * 86400e3, 'about a month of access');
      const v = await validate();
      assert.equal(v.body.valid, true);
      assert.equal(v.body.plan, 'pro');
      const billing = await api.get('/api/user/billing', { token });
      assert.equal(billing.body.data.payments.length, 1);
    });

    await t2.test('a replayed event is acknowledged as a duplicate and changes nothing', async () => {
      const ev = stripeEvent('checkout.session.completed', {
        id: 'cs_1', customer, subscription: stripeSub, payment_intent: `pi_first_${T}`,
        amount_total: 500, currency: 'usd', metadata: { userId, plan: 'pro', billingCycle: 'monthly' },
      }, `evt_dup_${T}`);
      const a = await api.post('/api/webhooks/stripe', ev);
      assert.equal(a.status, 200);
      const b = await api.post('/api/webhooks/stripe', ev);
      assert.equal(b.status, 200);
      assert.equal(b.body.duplicate, true);
      const billing = await api.get('/api/user/billing', { token });
      assert.equal(billing.body.data.payments.length, 1, 'payment not double-counted');
    });

    const periodEnd = Math.floor(Date.now() / 1000) + 61 * 86400;
    await t2.test('a renewal invoice extends the expiry to the paid period end and adds a payment', async () => {
      const res = await api.post('/api/webhooks/stripe', stripeEvent('invoice.paid', {
        id: `in_renew_${T}`, customer, subscription: stripeSub, payment_intent: `pi_renew_${T}`,
        amount_paid: 500, currency: 'usd', billing_reason: 'subscription_cycle',
        lines: { data: [{ period: { start: periodEnd - 31 * 86400, end: periodEnd },
                          price: { recurring: { interval: 'month' } } }] },
      }));
      assert.equal(res.status, 200, res.text);
      const s = await status();
      assert.equal(new Date(s.expiryDate).getTime(), periodEnd * 1000);
      assert.equal(s.plan, 'pro');
      assert.equal(s.trial, false);
      const billing = await api.get('/api/user/billing', { token });
      assert.equal(billing.body.data.payments.length, 2);
      assert.equal(billing.body.data.payments.every((p) => p.status === 'paid'), true);
    });

    await t2.test('an older invoice arriving late never moves the expiry backwards', async () => {
      const older = periodEnd - 40 * 86400;
      const res = await api.post('/api/webhooks/stripe', stripeEvent('invoice.paid', {
        id: `in_old_${T}`, customer, subscription: stripeSub, payment_intent: `pi_old_${T}`,
        amount_paid: 500, currency: 'usd', billing_reason: 'subscription_cycle',
        lines: { data: [{ period: { start: older - 31 * 86400, end: older } }] },
      }));
      assert.equal(res.status, 200, res.text);
      const s = await status();
      assert.equal(new Date(s.expiryDate).getTime(), periodEnd * 1000);
    });

    await t2.test('a renewal whose invoice carries no period still adds a full cycle', async () => {
      const before = new Date((await status()).expiryDate).getTime();
      const res = await api.post('/api/webhooks/stripe', stripeEvent('invoice.payment_succeeded', {
        id: `in_noperiod_${T}`, customer, subscription: stripeSub, payment_intent: `pi_np_${T}`,
        amount_paid: 500, currency: 'usd', billing_reason: 'subscription_cycle',
      }));
      assert.equal(res.status, 200, res.text);
      const after = new Date((await status()).expiryDate).getTime();
      assert.ok(after > before + 27 * 86400e3, 'one more month was granted');
    });

    await t2.test('a failed renewal payment is recorded and does not touch access', async () => {
      const before = (await status()).expiryDate;
      const res = await api.post('/api/webhooks/stripe', stripeEvent('invoice.payment_failed', {
        id: `in_fail_${T}`, customer, customer_email: email, payment_intent: `pi_fail_${T}`,
        amount_due: 500, currency: 'usd', metadata: { plan: 'pro', billingCycle: 'monthly' },
      }));
      assert.equal(res.status, 200, res.text);
      const billing = await api.get('/api/user/billing', { token });
      assert.ok(billing.body.data.payments.some((p) => p.status === 'failed'));
      assert.equal((await status()).expiryDate, before);
    });

    await t2.test('cancelling stops the renewal but keeps the paid period', async () => {
      const res = await api.post('/api/subscription/cancel', null, { token });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.status, 'active');
      assert.equal(res.body.data.cancelAtPeriodEnd, true);
      const v = await validate();
      assert.equal(v.body.valid, true, 'the desktop app keeps Pro until the period ends');
      const meNow = await api.get('/api/user/me', { token });
      assert.equal(meNow.body.data.subscription.cancelAtPeriodEnd, true);
      const again = await api.post('/api/subscription/cancel', null, { token });
      assert.equal(again.status, 400);
      assert.equal(again.body.error.code, 'ALREADY_CANCELLING');
    });

    await t2.test('reactivating from the Stripe portal clears the flag', async () => {
      const res = await api.post('/api/webhooks/stripe', stripeEvent('customer.subscription.updated', {
        id: stripeSub, object: 'subscription', customer, status: 'active',
        cancel_at_period_end: false, current_period_end: periodEnd + 30 * 86400,
      }));
      assert.equal(res.status, 200, res.text);
      const s = await status();
      assert.equal(s.cancelAtPeriodEnd, false);
      assert.equal(new Date(s.expiryDate).getTime(), (periodEnd + 30 * 86400) * 1000);
    });

    await t2.test('the subscription actually ending marks it cancelled for the app', async () => {
      const res = await api.post('/api/webhooks/stripe', stripeEvent('customer.subscription.deleted', {
        id: stripeSub, object: 'subscription', customer,
      }));
      assert.equal(res.status, 200, res.text);
      // The account goes back to Free rather than to a dead row: the person can
      // subscribe again from the same account, and the app sees a Free plan.
      const after = await status();
      assert.equal(after.plan, 'free');
      assert.equal(after.cancelAtPeriodEnd, false);
      // The key still validates — as Free. Answering `expired` would make the
      // desktop app delete the key, and the person may well subscribe again.
      const v = await validate();
      assert.equal(v.body.valid, true);
      assert.equal(v.body.plan, 'free');
      assert.equal(v.body.features.authSiteDownloads, false, 'a Free client gets Free entitlements');
    });

    await t2.test('buying again re-activates and clears any period-end flag', async () => {
      const res = await api.post('/api/webhooks/stripe', stripeEvent('checkout.session.completed', {
        id: 'cs_2', customer, subscription: `${stripeSub}_2`, payment_intent: `pi_second_${T}`,
        amount_total: 4500, currency: 'usd', metadata: { userId, plan: 'pro', billingCycle: 'yearly' },
      }));
      assert.equal(res.status, 200, res.text);
      const s = await status();
      assert.equal(s.status, 'active');
      assert.equal(s.cancelAtPeriodEnd, false);
      assert.ok(new Date(s.expiryDate).getTime() > Date.now() + 360 * 86400e3, 'a year of access');
      assert.equal((await validate()).body.valid, true);
    });

    await t2.test('the free plan has nothing to cancel', async () => {
      const other = srv.client();
      const u = await srv.makeUser(other, 'freecancel');
      const res = await other.post('/api/subscription/cancel', null, { token: u.token });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'NOT_A_PAID_PLAN');
    });
  });

  // ------------------------------------------------------------------ team
  await t.test('team invitations', async (t2) => {
    await srv.reset();
    const owner = srv.client();
    const o = await srv.makeUser(owner, 'owner');
    // A paid Team plan through the dev-only mock checkout.
    const buy = await owner.post('/api/subscription/mock-complete', { plan: 'team', billingCycle: 'monthly' }, { token: o.token });
    assert.equal(buy.status, 200, buy.text);

    const member = srv.client();
    const m = await srv.makeUser(member, 'member');

    await t2.test('a Free account cannot invite', async () => {
      const res = await member.post('/api/team/invites', { email: 'x@example.test' }, { token: m.token });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'NOT_TEAM_OWNER');
    });

    await t2.test('the owner cannot invite themselves', async () => {
      const res = await owner.post('/api/team/invites', { email: o.email }, { token: o.token });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'SELF_INVITE');
    });

    let inviteToken;
    let memberId;
    await t2.test('an invitation is created and mailed', async () => {
      const mail = await captureMail(async () => {
        const res = await owner.post('/api/team/invites', { email: m.email }, { token: o.token });
        assert.equal(res.status, 201, res.text);
        memberId = res.body.data.id;
        assert.equal(res.body.data.status, 'invited');
      });
      inviteToken = linkParam(mail, '/team/join', 'token');
      assert.ok(inviteToken, 'invite link mailed');
      const dup = await owner.post('/api/team/invites', { email: m.email }, { token: o.token });
      assert.equal(dup.status, 409);
    });

    await t2.test('the public lookup names the inviter without a session', async () => {
      const anon = srv.client();
      const res = await anon.get(`/api/team/invites/${encodeURIComponent(inviteToken)}`);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.email, m.email);
      assert.equal(res.body.data.plan, 'team');
      const bad = await anon.get('/api/team/invites/not-a-real-token-value-at-all');
      assert.ok(bad.status === 404 || bad.status === 400, 'a bogus token is refused');
    });

    await t2.test('only the invited address may accept', async () => {
      const stranger = srv.client();
      const s = await srv.makeUser(stranger, 'stranger');
      const res = await stranger.post('/api/team/join', { token: inviteToken }, { token: s.token });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'EMAIL_MISMATCH');
    });

    await t2.test('accepting puts the team key on the member dashboard', async () => {
      const res = await member.post('/api/team/join', { token: inviteToken }, { token: m.token });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.role, 'member');
      const lic = await member.get('/api/user/license', { token: m.token });
      assert.equal(lic.body.data.viaTeam, true);
      assert.equal(lic.body.data.plan, 'team');
      const ownerKey = (await owner.get('/api/user/license', { token: o.token })).body.data.licenseKey;
      assert.equal(lic.body.data.licenseKey, ownerKey);
      const roster = await owner.get('/api/team', { token: o.token });
      assert.equal(roster.body.data.used, 2);
      assert.equal(roster.body.data.members[0].status, 'active');
      const spent = await member.post('/api/team/join', { token: inviteToken }, { token: m.token });
      assert.equal(spent.status, 404, 'a used invite is dead');
    });

    // The bug this guards: a member's own subscription row stays Free, and
    // every page that read that row told them they were on Free — offering the
    // Pro trial they already had, three lines above a card that said "you are
    // on X's team".
    await t2.test('a member sees the TEAM plan everywhere, not their own Free row', async () => {
      const me = (await member.get('/api/user/me', { token: m.token })).body.data;
      assert.equal(me.subscription.plan, 'team', 'the dashboard plan tile');
      assert.equal(me.subscription.viaTeam, true);
      assert.equal(me.subscription.trial, false);
      assert.equal(me.subscription.teamOwner, o.name || me.subscription.teamOwner);
      assert.ok(me.subscription.teamOwner, 'whose team it is');
      assert.equal(me.team.role, 'member');

      const status = (await member.get('/api/subscription/status', { token: m.token })).body.data;
      assert.equal(status.plan, 'team', 'the billing page plan');
      assert.equal(status.viaTeam, true);
      // A member is never shown the owner's cancellation state: it is not
      // theirs to read, and the billing page acts on it.
      assert.equal(status.cancelAtPeriodEnd, false);
      // Nor is the plan billed to them — the owner pays, so the member gets no
      // "Renews", no cancel button and no portal.
      assert.equal(status.billed, false);
      assert.equal(me.subscription.billed, false);
      const ownerStatus = (await owner.get('/api/subscription/status', { token: o.token })).body.data;
      assert.equal(ownerStatus.billed, true, 'the mock checkout stands in for a Stripe subscription');

      // …and the entitlement the desktop app receives agrees with all of it.
      const licence = (await member.get('/api/user/license', { token: m.token })).body.data;
      const validated = await member.post('/api/license/validate', {
        license_key: licence.licenseKey, device_fingerprint: 'e'.repeat(64),
      });
      assert.equal(validated.body.valid, true);
      assert.equal(validated.body.plan, 'team');
    });

    await t2.test('a member cannot start a Pro trial they already have', async () => {
      const res = await member.post('/api/subscription/start-trial', null, { token: m.token });
      assert.equal(res.status, 400, res.text);
      assert.equal(res.body.error.code, 'TRIAL_UNAVAILABLE');
      const rows = await srv.query('SELECT trial_used FROM users WHERE email = ?', [m.email]);
      assert.equal(Number(rows[0].trial_used), 0, 'the account keeps its one trial');
    });

    await t2.test('the roster is capped at the plan seats', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await owner.post('/api/team/invites', { email: `extra${i}@example.test` }, { token: o.token });
        assert.equal(res.status, 201, res.text);
      }
      const full = await owner.post('/api/team/invites', { email: 'sixth@example.test' }, { token: o.token });
      assert.equal(full.status, 400);
      assert.equal(full.body.error.code, 'TEAM_FULL');
      assert.equal((await owner.get('/api/team', { token: o.token })).body.data.canInvite, false);
    });

    await t2.test('a member can leave and an owner can remove', async () => {
      const leave = await member.post('/api/team/leave', null, { token: m.token });
      assert.equal(leave.status, 200, leave.text);
      const lic = await member.get('/api/user/license', { token: m.token });
      assert.equal(lic.body.data.viaTeam, false);
      assert.equal(lic.body.data.plan, 'free');
      // Every page follows them back, and the trial they never spent is theirs.
      const me = (await member.get('/api/user/me', { token: m.token })).body.data;
      assert.equal(me.subscription.plan, 'free');
      assert.equal(me.subscription.viaTeam, false);
      assert.equal(me.team, null);
      const trial = await member.post('/api/subscription/start-trial', null, { token: m.token });
      assert.equal(trial.status, 200, trial.text);
      const roster = await owner.get('/api/team', { token: o.token });
      const pending = roster.body.data.members.find((x) => x.email === 'extra0@example.test');
      const gone = await owner.del(`/api/team/members/${pending.id}`, { token: o.token });
      assert.equal(gone.status, 200);
      const notMine = await member.del(`/api/team/members/${memberId}`, { token: m.token });
      assert.equal(notMine.status, 403);
    });
  });

  // --------------------------------------------------------------- contact
  await t.test('contact form and admin inbox', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const admin = await insertAdmin('inbox@example.test');
    const login = await api.post('/api/admin/login', { email: admin.email, password: admin.password });
    const auth = { token: login.body.data.token };

    await t2.test('a short message is refused, a real one is stored', async () => {
      const short = await api.post('/api/contact', { email: 'a@example.test', message: 'hi' });
      assert.equal(short.status, 400);
      const res = await api.post('/api/contact', {
        name: 'Asker', email: 'asker@example.test', topic: 'bug', message: 'The app crashes when I paste a magnet link.',
      });
      assert.equal(res.status, 200, res.text);
      const rows = await srv.query('SELECT * FROM contact_messages');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].topic, 'bug');
    });

    await t2.test('the honeypot swallows bots quietly', async () => {
      const res = await api.post('/api/contact', {
        email: 'bot@example.test', message: 'buy cheap things here please now', website: 'http://spam',
      });
      assert.equal(res.status, 400, 'a filled honeypot fails validation');
      // ...and without saying which field did it. A 400 carrying
      // fieldErrors.website tells the bot exactly what to leave blank next
      // time, which is the one thing a honeypot must not do.
      assert.doesNotMatch(res.text, /website/i, 'the trap does not name itself');
    });

    let threadId;
    await t2.test('the admin sees it in the inbox and can reply', async () => {
      const list = await api.get('/api/admin/contact', auth);
      assert.equal(list.status, 200, list.text);
      const items = list.body.data.messages || list.body.data.items || list.body.data;
      const thread = (Array.isArray(items) ? items : []).find((x) => x.email === 'asker@example.test');
      assert.ok(thread, `inbox lists the message: ${list.text.slice(0, 200)}`);
      threadId = thread.id;
      const mail = await captureMail(async () => {
        const reply = await api.post(`/api/admin/contact/${threadId}/reply`, { body: 'Thanks — fixed in the next build.' }, auth);
        assert.ok(reply.status === 200 || reply.status === 201, reply.text);
        assert.equal(reply.body.data.message.status, 'replied');
        assert.equal(reply.body.data.reply.delivered, 1);
      });
      assert.match(mail, /asker@example\.test/);
      assert.match(mail, /fixed in the next build/);
    });

    await t2.test('the thread moves through statuses and the anonymous side cannot read it', async () => {
      const closed = await api.put(`/api/admin/contact/${threadId}`, { status: 'closed' }, auth);
      assert.equal(closed.status, 200, closed.text);
      const anon = await srv.client().get('/api/admin/contact');
      assert.equal(anon.status, 401);
    });
  });

  // --------------------------------------------------------------- reviews
  await t.test('reviews are moderated before they are public', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const u = await srv.makeUser(api, 'reviewer');
    const admin = await insertAdmin('mod@example.test');
    const login = await api.post('/api/admin/login', { email: admin.email, password: admin.password });
    const auth = { token: login.body.data.token };

    let reviewId;
    await t2.test('a signed-in user can post one review, which starts pending', async () => {
      const res = await api.post('/api/reviews', { rating: 5, comment: 'Fastest downloader I have used.' }, { token: u.token });
      assert.equal(res.status, 201, res.text);
      reviewId = res.body.data.id;
      const pub = await api.get('/api/reviews');
      assert.equal(pub.body.data.reviews.length, 0, 'not public yet');
      const again = await api.post('/api/reviews', { rating: 4, comment: 'Edited my mind a little.' }, { token: u.token });
      assert.equal(again.status, 201);
      assert.equal((await srv.query('SELECT COUNT(*) AS n FROM reviews'))[0].n, 1, 'one review per user');
    });

    await t2.test('anonymous posting and out-of-range ratings are refused', async () => {
      const anon = await srv.client().post('/api/reviews', { rating: 5, comment: 'anon' });
      assert.equal(anon.status, 401);
      const bad = await api.post('/api/reviews', { rating: 6, comment: 'too high' }, { token: u.token });
      assert.equal(bad.status, 400);
    });

    await t2.test('approval publishes it with the average', async () => {
      const pending = await api.get('/api/admin/reviews/pending', auth);
      assert.equal(pending.status, 200, pending.text);
      const res = await api.put(`/api/admin/reviews/${reviewId}`, { status: 'approved' }, auth);
      assert.equal(res.status, 200, res.text);
      const pub = await api.get('/api/reviews');
      assert.equal(pub.body.data.reviews.length, 1);
      assert.equal(pub.body.data.averageRating, 4);
      assert.equal(pub.body.data.reviews[0].userName, 'Test User');
      assert.equal('userId' in pub.body.data.reviews[0], false, 'no ids or emails leak');
    });
  });

  // ------------------------------------------------------- control-panel 2FA
  await t.test('admin two-factor authentication', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const totp = require('../src/utils/totp');
    // The verifier refuses a time step it has already accepted (replay guard).
    // These flow tests present several codes inside one 30 s step, so each use
    // clears the recorded step first — the guard itself has its own tests.
    const code = async (email) => {
      await srv.query('UPDATE users SET totp_last_step = NULL WHERE email = ?', [email]);
      return totp.totpAt(secret);
    };
    const admin = await insertAdmin('twofa@example.test');
    let auth;
    let secret;
    let recoveryCodes;

    await t2.test('enrolment: setup, wrong code refused, right code enables', async () => {
      const login = await api.post('/api/admin/login', { email: admin.email, password: admin.password });
      auth = { token: login.body.data.token };
      const setup = await api.post('/api/admin/2fa/setup', null, auth);
      assert.equal(setup.status, 200, setup.text);
      secret = setup.body.data.secret;
      assert.match(setup.body.data.otpauthUrl, /^otpauth:\/\/totp\//);
      const wrong = await api.post('/api/admin/2fa/enable', { code: '000000' }, auth);
      assert.equal(wrong.status, 400);
      const state = await api.get('/api/admin/2fa', auth);
      assert.equal(state.body.data.enabled, false);
      assert.equal(state.body.data.pending, true);
      const right = await api.post('/api/admin/2fa/enable', { code: await code(admin.email) }, auth);
      assert.equal(right.status, 200, right.text);
      recoveryCodes = right.body.data.recoveryCodes;
      assert.equal(recoveryCodes.length, 8);
    });

    await t2.test('login now stops at a challenge that only a valid code completes', async () => {
      const fresh = srv.client();
      const login = await fresh.post('/api/admin/login', { email: admin.email, password: admin.password });
      assert.equal(login.status, 200, login.text);
      assert.equal(login.body.data.requiresTwoFactor, true);
      assert.equal(login.body.data.token, undefined, 'no session before the second factor');
      const bad = await fresh.post('/api/admin/login/2fa', { challenge: login.body.data.challenge, code: '123456' });
      assert.equal(bad.status, 401);
      const good = await fresh.post('/api/admin/login/2fa', { challenge: login.body.data.challenge, code: await code(admin.email) });
      assert.equal(good.status, 200, good.text);
      assert.ok(good.body.data.token);
      assert.ok(fresh.cookies.get('ndm_admin_refresh'));
      const me = await fresh.get('/api/admin/me', { token: good.body.data.token });
      assert.equal(me.body.data.twoFactorEnabled, true);
    });

    await t2.test('a recovery code works exactly once', async () => {
      const fresh = srv.client();
      const challenge = (await fresh.post('/api/admin/login', { email: admin.email, password: admin.password })).body.data.challenge;
      const code = recoveryCodes[0];
      const first = await fresh.post('/api/admin/login/2fa', { challenge, code });
      assert.equal(first.status, 200, first.text);
      const again = (await fresh.post('/api/admin/login', { email: admin.email, password: admin.password })).body.data.challenge;
      const second = await fresh.post('/api/admin/login/2fa', { challenge: again, code });
      assert.equal(second.status, 401, 'a spent recovery code is refused');
      const state = await fresh.get('/api/admin/2fa', { token: first.body.data.token });
      assert.equal(state.body.data.recoveryCodesLeft, 7);
    });

    await t2.test('a staff challenge cannot complete a root login', async () => {
      const challenge = (await api.post('/api/admin/login', { email: admin.email, password: admin.password })).body.data.challenge;
      const res = await api.post('/api/root/login/2fa', { challenge, code: await code(admin.email) });
      assert.equal(res.status, 401);
    });

    await t2.test('disabling needs the password and a code', async () => {
      const fresh = srv.client();
      const challenge = (await fresh.post('/api/admin/login', { email: admin.email, password: admin.password })).body.data.challenge;
      const session = await fresh.post('/api/admin/login/2fa', { challenge, code: await code(admin.email) });
      const a = { token: session.body.data.token };
      const wrongPw = await fresh.post('/api/admin/2fa/disable', { password: 'nope-nope-nope', code: await code(admin.email) }, a);
      assert.equal(wrongPw.status, 400);
      const off = await fresh.post('/api/admin/2fa/disable', { password: admin.password, code: await code(admin.email) }, a);
      assert.equal(off.status, 200, off.text);
      const plain = await fresh.post('/api/admin/login', { email: admin.email, password: admin.password });
      assert.ok(plain.body.data.token, 'password alone signs in again');
    });
  });

  // ------------------------------------------------------------------ root
  await t.test('creator panel', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const root = await insertAdmin('creator@example.test', 'root', 'creator-password-123');
    const staff = await insertAdmin('staff@example.test');
    const customer = await srv.makeUser(srv.client(), 'customer');
    let rootAuth;

    await t2.test('the creator signs in on /api/root and a staff admin cannot', async () => {
      const res = await api.post('/api/root/login', { email: root.email, password: root.password });
      assert.equal(res.status, 200, res.text);
      rootAuth = { token: res.body.data.token };
      assert.ok(api.cookies.get('ndm_root_refresh'));
      const no = await srv.client().post('/api/root/login', { email: staff.email, password: staff.password });
      assert.equal(no.status, 401);
    });

    await t2.test('a root token also opens the staff screens; a staff token never opens root ones', async () => {
      const stats = await api.get('/api/admin/stats', rootAuth);
      assert.equal(stats.status, 200, stats.text);
      const staffLogin = await srv.client().post('/api/admin/login', { email: staff.email, password: staff.password });
      const overview = await srv.client().get('/api/root/overview', { token: staffLogin.body.data.token });
      assert.equal(overview.status, 401);
      const admins = await api.get('/api/root/admins', rootAuth);
      assert.equal(admins.body.data.admins.length, 2);
    });

    let newAdminId;
    await t2.test('root creates, demotes and reinstates staff; nobody touches root', async () => {
      const created = await api.post('/api/root/admins', {
        name: 'New Staff', email: 'newstaff@example.test', password: 'twelve-char-password',
      }, rootAuth);
      assert.equal(created.status, 201, created.text);
      newAdminId = created.body.data.id || created.body.data.admin?.id;
      const rows = await srv.query("SELECT id, role FROM users WHERE email = 'newstaff@example.test'");
      assert.equal(rows[0].role, 'admin');
      newAdminId = rows[0].id;
      const rootRow = (await srv.query("SELECT id FROM users WHERE email = 'creator@example.test'"))[0];
      const self = await api.put(`/api/root/admins/${rootRow.id}`, { banned: true }, rootAuth);
      assert.equal(self.status, 400, 'no self lockout');
      const demote = await api.del(`/api/root/admins/${newAdminId}`, rootAuth);
      assert.equal(demote.status, 200, demote.text);
      assert.equal((await srv.query('SELECT role FROM users WHERE id = ?', [newAdminId]))[0].role, 'user');
    });

    await t2.test('staff cannot change roles or ban another admin, root can', async () => {
      const staffLogin = await srv.client().post('/api/admin/login', { email: staff.email, password: staff.password });
      const staffAuth = { token: staffLogin.body.data.token };
      const rootRow = (await srv.query("SELECT id FROM users WHERE email = 'creator@example.test'"))[0];
      const roleChange = await api.put(`/api/admin/users/${newAdminId}`, { role: 'admin' }, staffAuth);
      assert.equal(roleChange.status, 400, 'role is not an accepted field');
      const banRoot = await api.put(`/api/admin/users/${rootRow.id}`, { banned: true }, staffAuth);
      assert.equal(banRoot.status, 403);
      const custRow = (await srv.query('SELECT id FROM users WHERE email = ?', [customer.email]))[0];
      const banCustomer = await api.put(`/api/admin/users/${custRow.id}`, { banned: true }, staffAuth);
      assert.equal(banCustomer.status, 200, banCustomer.text);
      const blocked = await srv.client().get('/api/user/me', { token: customer.token });
      assert.equal(blocked.status, 403, 'a banned customer is locked out immediately');
      await api.put(`/api/admin/users/${custRow.id}`, { banned: false }, staffAuth);
    });

    await t2.test('the audit trail records it and deleting a user needs the exact email', async () => {
      const audit = await api.get('/api/root/audit', rootAuth);
      assert.equal(audit.status, 200, audit.text);
      const entries = Array.isArray(audit.body.data) ? audit.body.data
        : (audit.body.data.entries || audit.body.data.logs || audit.body.data.items || []);
      assert.ok(entries.length >= 2, `audit rows written: ${audit.text.slice(0, 200)}`);
      assert.ok(entries.some((e) => /admin\.(created|demoted|deleted)|user\.banned|user\.updated/.test(e.action)),
        `expected a staff/customer action in ${entries.map((e) => e.action).join(',')}`);
      const custRow = (await srv.query('SELECT id FROM users WHERE email = ?', [customer.email]))[0];
      const wrong = await api.del(`/api/root/users/${custRow.id}`, { ...rootAuth, headers: { 'content-type': 'application/json' } });
      assert.equal(wrong.status, 400, 'no confirmation email → refused');
      const res = await fetch(`${srv.baseUrl()}/api/root/users/${custRow.id}`, {
        method: 'DELETE', headers: { 'content-type': 'application/json', authorization: `Bearer ${rootAuth.token}` },
        body: JSON.stringify({ confirmEmail: customer.email }),
      });
      assert.equal(res.status, 200, await res.text());
      assert.equal((await srv.query('SELECT COUNT(*) AS n FROM users WHERE id = ?', [custRow.id]))[0].n, 0);
      assert.equal((await srv.query('SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?', [custRow.id]))[0].n, 0, 'cascade');
    });
  });

  // ------------------------------------------ self-service account features
  await t.test('devices, export and self-deletion', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const u = await srv.makeUser(api, 'selfservice');
    const key = (await api.get('/api/user/license', { token: u.token })).body.data.licenseKey;
    await api.post('/api/license/validate', { license_key: key, device_fingerprint: 'a1'.repeat(16), device_name: 'Laptop' });

    await t2.test('the device list shows the seat without the full fingerprint', async () => {
      const res = await api.get('/api/user/devices', { token: u.token });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.activeSeats, 1);
      assert.equal(res.body.data.devices[0].name, 'Laptop');
      assert.equal(res.body.data.devices[0].shortId.length, 8);
      assert.equal('device_fingerprint' in res.body.data.devices[0], false);
      const freed = await api.del(`/api/user/devices/${res.body.data.devices[0].id}`, { token: u.token });
      assert.equal(freed.status, 200);
      assert.equal(freed.body.data.activeSeats, 0);
    });

    await t2.test('the export is a complete, secret-free document', async () => {
      const res = await api.get('/api/user/export', { token: u.token });
      assert.equal(res.status, 200, res.text);
      assert.match(res.headers.get('content-disposition'), /attachment/);
      // The file IS the document — no { ok, data } wrapper (AUDIT.md L-03).
      // Somebody opening nexa-account-7.json should find their account, not
      // this API's transport envelope around it.
      const doc = JSON.parse(res.text);
      assert.equal(doc.ok, undefined, 'no envelope in a downloaded file');
      assert.ok(doc.exportedAt, 'the document starts where the document starts');
      assert.equal(doc.account.email, u.email);
      assert.equal(doc.subscriptions[0].licenseKey, key);
      assert.doesNotMatch(res.text, /password_hash|refresh_token|totp/);
    });

    await t2.test('the profile never carries hashes or 2FA material', async () => {
      const me = await api.get('/api/user/me', { token: u.token });
      const keys = Object.keys(me.body.data.user);
      for (const k of ['password_hash', 'refresh_token_hash', 'admin_refresh_token_hash', 'root_refresh_token_hash', 'totp_secret', 'totp_recovery'])
        assert.equal(keys.includes(k), false, `${k} must not be in /me`);
      assert.equal(me.body.data.user.hasPassword, true);
    });

    await t2.test('deletion needs the password and the word DELETE, then everything is gone', async () => {
      const noWord = await api.del('/api/user/account', { token: u.token, headers: { 'content-type': 'application/json' } });
      assert.equal(noWord.status, 400);
      const call = (body) => fetch(`${srv.baseUrl()}/api/user/account`, {
        method: 'DELETE', headers: { 'content-type': 'application/json', authorization: `Bearer ${u.token}` },
        body: JSON.stringify(body),
      });
      const wrongPw = await call({ password: 'not-it', confirm: 'DELETE' });
      assert.equal(wrongPw.status, 400);
      const done = await call({ password: u.password, confirm: 'DELETE' });
      assert.equal(done.status, 200, await done.text());
      assert.equal((await srv.query('SELECT COUNT(*) AS n FROM users'))[0].n, 0);
      assert.equal((await srv.query('SELECT COUNT(*) AS n FROM license_activations'))[0].n, 0);
      const after = await api.get('/api/user/me', { token: u.token });
      assert.equal(after.status, 401);
    });
  });

  // ------------------------------------------- uploaded installer downloads
  await t.test('uploaded installer: resumable download the updater relies on', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const admin = await insertAdmin('rel@example.test');
    const login = await api.post('/api/admin/login', { email: admin.email, password: admin.password });
    const auth = { token: login.body.data.token };
    const body = crypto.randomBytes(200 * 1024);
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    let releaseId;

    await t2.test('an admin publishes a release and uploads the Windows installer', async () => {
      const created = await api.post('/api/admin/releases', {
        version: '9.9.9', changelog: 'test build', isLatest: true,
      }, auth);
      assert.equal(created.status, 201, created.text);
      releaseId = created.body.data.id;
      const badType = await fetch(`${srv.baseUrl()}/api/admin/releases/${releaseId}/artifact/windows`, {
        method: 'PUT', headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/octet-stream', 'x-filename': 'evil.html' }, body,
      });
      assert.equal(badType.status, 400);
      const up = await fetch(`${srv.baseUrl()}/api/admin/releases/${releaseId}/artifact/windows`, {
        method: 'PUT', headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/octet-stream', 'x-filename': 'NexaSetup.exe' }, body,
      });
      assert.equal(up.status, 200, await up.text());
      const latest = await api.get('/api/releases/latest');
      assert.equal(latest.body.data.windowsSha256, sha, 'checksum computed while streaming');
      assert.equal(latest.body.data.windowsSize, body.length);
      const feed = await api.get('/api/releases/feed?os=windows');
      assert.equal(feed.body.sha256, sha);
      assert.equal(feed.body.version, '9.9.9');
    });

    const dl = (headers = {}) => fetch(`${srv.baseUrl()}/api/releases/download/windows`, { headers, redirect: 'manual' });
    await t2.test('a full download streams the exact bytes, counted once', async () => {
      const res = await dl();
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('accept-ranges'), 'bytes');
      assert.equal(res.headers.get('etag'), `"${sha}"`);
      const got = Buffer.from(await res.arrayBuffer());
      assert.equal(got.equals(body), true);
      assert.equal((await api.get('/api/releases/latest')).body.data.downloadCount, 1);
    });

    await t2.test('the desktop probe (bytes=0-0) is served but not counted; a resume is served but not counted', async () => {
      const probe = await dl({ range: 'bytes=0-0' });
      assert.equal(probe.status, 206);
      assert.equal(probe.headers.get('content-range'), `bytes 0-0/${body.length}`);
      assert.equal((await probe.arrayBuffer()).byteLength, 1);
      const resume = await dl({ range: `bytes=${body.length - 1000}-` });
      assert.equal(resume.status, 206);
      const tail = Buffer.from(await resume.arrayBuffer());
      assert.equal(tail.equals(body.subarray(body.length - 1000)), true);
      // Another start from the same address inside the window is the same
      // person retrying — a cancel-and-restart, a scanner, a second click —
      // and is served in full but not counted again (utils/downloadCounter.js).
      const retry = await dl({ range: 'bytes=0-65535' });
      assert.equal(retry.status, 206);
      assert.equal((await api.get('/api/releases/latest')).body.data.downloadCount, 1,
        'a restart from the same address in the window is not a second download');
      // Forget this address — what the next window looks like — and the same
      // segmented start is a download.
      resetDownloadCounter();
      const segment = await dl({ range: 'bytes=0-65535' });
      assert.equal(segment.status, 206, 'a real segmented start counts');
      assert.equal((await api.get('/api/releases/latest')).body.data.downloadCount, 2);
    });

    await t2.test('an unsatisfiable range is a 416 with the total', async () => {
      const res = await dl({ range: `bytes=${body.length + 10}-` });
      assert.equal(res.status, 416);
      assert.equal(res.headers.get('content-range'), `bytes */${body.length}`);
    });

    await t2.test('removing the artifact makes the feed 404 again', async () => {
      const res = await api.del(`/api/admin/releases/${releaseId}/artifact/windows`, auth);
      assert.equal(res.status, 200, res.text);
      const feed = await api.get('/api/releases/feed?os=windows');
      assert.equal(feed.status, 404);
      assert.equal(fs.readdirSync(process.env.RELEASE_UPLOAD_DIR).filter((f) => !f.startsWith('.')).length, 0, 'file removed from disk');
    });
  });

  // ------------------------------------------------- malformed request bodies
  await t.test('body-parser failures carry their own codes', async (t2) => {
    const post = (body) => fetch(`${srv.baseUrl()}/api/contact`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    await t2.test('unparseable JSON is a 400 BAD_JSON, not an INTERNAL_ERROR', async () => {
      const res = await post('{"name": ');
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error.code, 'BAD_JSON');
      assert.doesNotMatch(json.error.message, /position|line \d+/, 'no parser internals in the message');
    });
    await t2.test('an oversized body is a 413 PAYLOAD_TOO_LARGE', async () => {
      const res = await post(JSON.stringify({ email: 'a@b.co', message: 'x'.repeat(1_100_000) }));
      assert.equal(res.status, 413);
      assert.equal((await res.json()).error.code, 'PAYLOAD_TOO_LARGE');
    });
  });

  await srv.stop();
  fs.rmSync(process.env.RELEASE_UPLOAD_DIR, { recursive: true, force: true });
});
