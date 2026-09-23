'use strict';

/**
 * Clear an account's second factor when nothing else can (AUDIT.md M-14).
 *
 *   npm run reset-2fa -- owner@example.com
 *   npm run reset-2fa -- owner@example.com --dry-run
 *
 * Every other way back from a lost authenticator needs something the person
 * locked out no longer has:
 *
 *   - a recovery code        — gone with the set, or never saved
 *   - the authenticator      — the thing that was lost
 *   - a staff admin's reset  — POST /api/root/admins/:id/reset-2fa, which only
 *                              the creator can call, and only against STAFF
 *
 * That last one is the gap. There is no account above the creator, so a
 * creator who loses their authenticator with no codes left has no route back
 * through the product at all — and with ADMIN_2FA_REQUIRED on, that is the
 * whole panel, permanently.
 *
 * So the way back is deliberately *outside* the product: a shell on the host.
 * That is the right trust boundary rather than a weaker one — anyone who can
 * run this can already read the database and the JWT secrets, so it grants no
 * authority they did not have. What it adds is that the recovery is one
 * documented command instead of hand-written SQL against a live table, and
 * that it leaves an audit row saying it happened.
 *
 * It does NOT touch the password. Somebody who has lost their phone still has
 * to know it.
 */

const readline = require('readline');
const { connectDB, query } = require('../config/db');
const config = require('../config/env');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

/* eslint-disable no-console */

function usage(message) {
  if (message) console.error(`[reset2fa] ${message}\n`);
  console.error('Usage: npm run reset-2fa -- <email> [--dry-run] [--yes]');
  console.error('');
  console.error('  <email>     the account to clear. Defaults to ROOT_ADMIN_EMAIL.');
  console.error('  --dry-run   report what would change and exit without writing.');
  console.error('  --yes       skip the confirmation prompt (for non-interactive use).');
  process.exit(1);
}

// A tty may not be there (cron, a piped shell). Without one, --yes is required
// rather than assumed: this is a security control being switched off.
function confirm(questionText) {
  if (!process.stdin.isTTY) {
    usage('not a terminal — pass --yes to confirm non-interactively');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(questionText, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));

  for (const flag of flags) {
    if (!['--dry-run', '--yes'].includes(flag)) usage(`unknown option ${flag}`);
  }

  const email = (positional[0] || config.ROOT_ADMIN_EMAIL || '').toLowerCase().trim();
  if (!email) usage('no email given, and ROOT_ADMIN_EMAIL is not set');

  await connectDB();

  const rows = await query(
    `SELECT id, name, email, role, totp_enabled, totp_secret, totp_recovery
       FROM users WHERE email = ?`,
    [email]
  );
  if (!rows.length) usage(`no account with the email ${email}`);
  const user = rows[0];

  let stored = [];
  try { stored = JSON.parse(user.totp_recovery || '[]'); } catch { stored = []; }

  console.log('───────────────────────────────────────────');
  console.log(` account:        ${user.email}  (#${user.id}, ${user.role})`);
  console.log(` 2FA enabled:    ${user.totp_enabled ? 'yes' : 'no'}`);
  console.log(` secret stored:  ${user.totp_secret ? 'yes' : 'no'}`);
  console.log(` recovery codes: ${Array.isArray(stored) ? stored.length : 0}`);
  console.log('───────────────────────────────────────────');

  if (!user.totp_enabled && !user.totp_secret) {
    console.log('[reset2fa] Nothing to clear — this account has no second factor.');
    process.exit(0);
  }

  if (flags.has('--dry-run')) {
    console.log('[reset2fa] --dry-run: would clear the second factor and revoke sessions. Nothing written.');
    process.exit(0);
  }

  if (!flags.has('--yes')) {
    const answer = await confirm(
      `Clear the second factor on ${user.email}? This is a security control. [y/N] `
    );
    if (answer !== 'y' && answer !== 'yes') {
      console.log('[reset2fa] Cancelled. Nothing written.');
      process.exit(0);
    }
  }

  // The same three columns POST /api/root/admins/:id/reset-2fa clears, so the
  // two paths cannot drift into leaving different residue behind.
  await User.update(user.id, { totpEnabled: 0, totpSecret: null, totpRecovery: null });
  // Any bearer still out there was minted under the old posture. This is the
  // same follow-up the HTTP route does, and it is what makes the reset take
  // effect everywhere rather than only on the next sign-in.
  await User.revokeSessions(user.id);
  await AuditLog.create({
    adminUserId: user.id,
    action: `${user.role === 'root' ? 'root' : 'admin'}.2fa_reset_from_host`,
    entityType: 'user',
    entityId: user.id,
    summary: `Two-factor cleared from the server shell for ${user.email}`,
    metadata: { reason: 'lost authenticator', via: 'src/scripts/reset2fa.js' },
  });

  const loginPath = user.role === 'root' ? '/root/login' : '/admin/login';
  console.log('');
  console.log(`[reset2fa] Done. ${user.email} now signs in with the password alone.`);
  console.log(`[reset2fa] Sign in: ${config.FRONTEND_URL.replace(/\/+$/, '')}${loginPath}`);
  console.log('');
  console.log('[reset2fa] Do these two things next, in this order:');
  console.log('[reset2fa]   1. Enrol an authenticator again on the Security page.');
  console.log('[reset2fa]   2. Save the recovery codes it shows. They are shown once,');
  console.log('[reset2fa]      and having none is what made this script necessary.');
  if (!config.ADMIN_2FA_REQUIRED) {
    console.log('');
    console.log('[reset2fa] NOTE: ADMIN_2FA_REQUIRED is off, so nothing will make you do step 1.');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[reset2fa] failed:', err.message);
  process.exit(1);
});
