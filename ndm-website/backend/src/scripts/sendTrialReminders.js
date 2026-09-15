'use strict';

/**
 * Email everyone whose Pro trial ends soon, once each.
 *
 * Run it from cron. On Hostinger this is driven by daily-maintenance.sh,
 * which the hPanel cron job calls once a night (see ndm-website/deploy/README.md):
 *   node src/scripts/sendTrialReminders.js [--days 2] [--dry-run]
 *
 * "Once each" is enforced by subscriptions.trial_reminder_sent_at, which is
 * stamped BEFORE the send is attempted — a crash mid-run can therefore skip a
 * reminder, which is the right way round: a missed email is a nuisance, a
 * duplicate one is spam.
 */
const { getPool, query, execute } = require('../config/db');
const { sendTrialEndingEmail } = require('../utils/email');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const days = Math.max(1, Number(arg('days', 2)) || 2);
  const dryRun = process.argv.includes('--dry-run');

  // Trials still running, ending within `days`, never reminded, not on Stripe.
  const rows = await query(
    `SELECT s.id, s.trial_ends_at, u.id AS user_id, u.name, u.email
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
      WHERE s.trial_ends_at IS NOT NULL
        AND s.stripe_subscription_id IS NULL
        AND s.trial_reminder_sent_at IS NULL
        AND s.trial_ends_at > NOW()
        AND s.trial_ends_at <= DATE_ADD(NOW(), INTERVAL ? DAY)
        AND u.banned = 0
      ORDER BY s.trial_ends_at ASC`,
    [days]
  );

  console.log(`${rows.length} trial(s) ending within ${days} day(s)${dryRun ? ' [dry run]' : ''}`);
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const msLeft = new Date(row.trial_ends_at).getTime() - Date.now();
    const daysLeft = Math.max(1, Math.ceil(msLeft / 86400000));
    if (dryRun) {
      console.log(`  would email ${row.email} (${daysLeft}d left)`);
      continue;
    }
    // Claim first so a later crash cannot cause a second send.
    const claim = await execute(
      'UPDATE subscriptions SET trial_reminder_sent_at = NOW() WHERE id = ? AND trial_reminder_sent_at IS NULL',
      [row.id]
    );
    if (!claim.affectedRows) continue;   // another run got there first
    try {
      await sendTrialEndingEmail({ name: row.name, email: row.email }, daysLeft);
      sent += 1;
    } catch (err) {
      failed += 1;
      console.error(`  ! ${row.email}: ${err.message}`);
    }
  }
  if (!dryRun) console.log(`sent ${sent}, failed ${failed}`);
}

async function shutdown() {
  const p = await getPool();
  await p.end();
}

main()
  .then(shutdown)
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('trial reminders failed:', err);
    await shutdown().catch(() => { /* pool already gone */ });
    process.exit(1);
  });
