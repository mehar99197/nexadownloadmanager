'use strict';

const nodemailer = require('nodemailer');
const config = require('../config/env');

// In mock mode (no SMTP_HOST) we log the message instead of sending.
let transport = null;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getTransport() {
  if (config.isEmailMock) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

async function send({ to, subject, text, html, replyTo }) {
  const message = { from: config.FROM_EMAIL, to, subject, text, html };
  if (replyTo) message.replyTo = replyTo;
  if (config.isEmailMock) {
    // eslint-disable-next-line no-console
    console.log('[email:mock] ──────────────────────────────');
    // eslint-disable-next-line no-console
    console.log(`  to:      ${to}`);
    // eslint-disable-next-line no-console
    console.log(`  subject: ${subject}`);
    // eslint-disable-next-line no-console
    console.log(`  body:    ${text || html}`);
    // eslint-disable-next-line no-console
    console.log('[email:mock] ──────────────────────────────');
    return { mocked: true };
  }
  return getTransport().sendMail(message);
}

async function sendVerificationEmail(user, token) {
  const link = `${config.FRONTEND_URL}/verify-email?token=${encodeURIComponent(token)}`;
  const name = escapeHtml(user.name);
  const safeLink = escapeHtml(link);
  return send({
    to: user.email,
    subject: 'Verify your NexaDownloadManager email',
    text: `Hi ${user.name || ''},\n\nVerify your email address:\n${link}\n\nThis link expires in 1 hour.`,
    html: `<p>Hi ${name},</p><p>Verify your email address:</p><p><a href="${safeLink}">${safeLink}</a></p><p>This link expires in 1 hour.</p>`,
  });
}

/**
 * Sent when somebody tries to register an address that already has an account.
 *
 * Registration used to answer 409 EMAIL_EXISTS, which is a free, definitive
 * "does this person have a Nexa account?" oracle for any address on the
 * internet. It now answers exactly as it does for a new address, and the truth
 * goes to the only party entitled to it: the inbox that owns the address. That
 * also warns the real owner that someone is poking at their account.
 *
 * Deliberately carries no link that grants anything — sign-in and password
 * reset are reached from the site, so a forwarded copy of this is inert.
 */
async function sendAccountExistsEmail(user) {
  const name = escapeHtml(user.name || '');
  const signIn = `${config.FRONTEND_URL}/login`;
  const reset = `${config.FRONTEND_URL}/forgot-password`;
  return send({
    to: user.email,
    subject: 'You already have a NexaDownloadManager account',
    text: `Hi ${user.name || ''},\n\nSomebody just tried to create a Nexa Download Manager account with this email address, but you already have one.\n\nSign in: ${signIn}\nForgotten your password: ${reset}\n\nIf that was you, simply sign in — no new account was created and nothing about your existing one has changed. If it was not you, you can ignore this email; whoever tried was not told whether this address is registered.`,
    html: `<p>Hi ${name},</p>`
      + '<p>Somebody just tried to create a Nexa Download Manager account with this email address, but you already have one.</p>'
      + `<p><a href="${escapeHtml(signIn)}">Sign in</a> &middot; <a href="${escapeHtml(reset)}">Forgotten your password</a></p>`
      + '<p>If that was you, simply sign in — no new account was created and nothing about your existing one has changed. '
      + 'If it was not you, you can ignore this email; whoever tried was not told whether this address is registered.</p>',
  });
}

async function sendPasswordResetEmail(user, token) {
  const link = `${config.FRONTEND_URL}/reset-password?token=${encodeURIComponent(token)}`;
  const name = escapeHtml(user.name);
  const safeLink = escapeHtml(link);
  return send({
    to: user.email,
    subject: 'Reset your NexaDownloadManager password',
    text: `Hi ${user.name || ''},\n\nReset your password:\n${link}\n\nThis link expires in 1 hour. If you did not request this, ignore this email.`,
    html: `<p>Hi ${name},</p><p>Reset your password:</p><p><a href="${safeLink}">${safeLink}</a></p><p>This link expires in 1 hour. If you did not request this, ignore this email.</p>`,
  });
}

async function sendLicenseEmail(user, licenseKey, plan) {
  const name = escapeHtml(user.name);
  const safeLicenseKey = escapeHtml(licenseKey);
  const safePlan = escapeHtml(plan);
  return send({
    to: user.email,
    subject: `Your NexaDownloadManager ${plan} license key`,
    text: `Hi ${user.name || ''},\n\nThank you for subscribing to the ${plan} plan!\n\nYour license key:\n${licenseKey}\n\nEnter this key in the NDM app to unlock premium features.`,
    html: `<p>Hi ${name},</p><p>Thank you for subscribing to the <strong>${safePlan}</strong> plan!</p><p>Your license key:</p><pre>${safeLicenseKey}</pre><p>Enter this key in the NDM app to unlock premium features.</p>`,
  });
}

// Sent once the first payment lands. Not a tax invoice — Stripe issues those —
// so it says where to find the real one.
async function sendReceiptEmail(user, { plan, billingCycle, amount, currency, invoiceUrl }) {
  const name = escapeHtml(user.name);
  const safePlan = escapeHtml(plan);
  const safeCycle = escapeHtml(billingCycle);
  const price = `${(Number(amount) || 0).toFixed(2)} ${String(currency || 'usd').toUpperCase()}`;
  const invoiceLine = invoiceUrl
    ? `\n\nYour invoice: ${invoiceUrl}`
    : '\n\nYour invoice is available from Billing on the website.';
  const invoiceHtml = invoiceUrl
    ? `<p><a href="${escapeHtml(invoiceUrl)}">View your invoice</a></p>`
    : '<p>Your invoice is available from Billing on the website.</p>';
  return send({
    to: user.email,
    subject: `Your NexaDownloadManager ${plan} receipt`,
    text: `Hi ${user.name || ''},\n\nThanks — your ${plan} (${billingCycle}) subscription is active.\nAmount: ${price}${invoiceLine}\n\nManage or cancel any time: ${config.FRONTEND_URL}/billing`,
    html: `<p>Hi ${name},</p><p>Thanks — your <strong>${safePlan}</strong> (${safeCycle}) subscription is active.</p><p>Amount: <strong>${escapeHtml(price)}</strong></p>${invoiceHtml}<p><a href="${escapeHtml(config.FRONTEND_URL)}/billing">Manage or cancel any time</a></p>`,
  });
}

// Sent after the address is verified: the one email that decides whether a new
// account ever becomes a user, so it links straight to the download.
async function sendWelcomeEmail(user) {
  const name = escapeHtml(user.name);
  const url = escapeHtml(config.FRONTEND_URL);
  return send({
    to: user.email,
    subject: 'Welcome to Nexa — here is how to start',
    text: `Hi ${user.name || ''},\n\nYour Nexa account is ready.\n\n1. Download the app: ${config.FRONTEND_URL}/download\n2. Add the browser extension: ${config.FRONTEND_URL}/docs/extension\n3. Your license key is on your dashboard: ${config.FRONTEND_URL}/dashboard\n\nEvery account includes a 7-day Pro trial — no card needed.`,
    html: `<p>Hi ${name},</p><p>Your Nexa account is ready.</p><ol><li><a href="${url}/download">Download the app</a></li><li><a href="${url}/docs/extension">Add the browser extension</a></li><li><a href="${url}/dashboard">Find your license key</a></li></ol><p>Every account includes a <strong>7-day Pro trial</strong> — no card needed.</p>`,
  });
}

// Sent while a trial still has days left, so the choice is theirs, not a surprise.
async function sendTrialEndingEmail(user, daysLeft) {
  const name = escapeHtml(user.name);
  const days = Number(daysLeft) || 0;
  const when = days <= 1 ? 'tomorrow' : `in ${days} days`;
  return send({
    to: user.email,
    subject: `Your Nexa Pro trial ends ${when}`,
    text: `Hi ${user.name || ''},\n\nYour Pro trial ends ${when}. After that your account returns to the Free plan (3 downloads at a time); nothing is deleted and no charge is made.\n\nKeep Pro: ${config.FRONTEND_URL}/pricing`,
    html: `<p>Hi ${name},</p><p>Your Pro trial ends <strong>${escapeHtml(when)}</strong>. After that your account returns to the Free plan (3 downloads at a time) — nothing is deleted and no charge is made.</p><p><a href="${escapeHtml(config.FRONTEND_URL)}/pricing">Keep Pro</a></p>`,
  });
}

/**
 * A message from the website's contact form, delivered to the support inbox
 * with Reply-To set to the visitor so support can answer from their client.
 */
async function sendContactMessage({ name, email, topic, message, userAgent }) {
  const to = config.SUPPORT_EMAIL || config.FROM_EMAIL;
  const subject = `[Nexa contact] ${topic}${name ? ` — ${name}` : ''}`;
  const text = [
    message,
    '',
    '—',
    `Name: ${name || '(not given)'}`,
    `Email: ${email}`,
    `Topic: ${topic}`,
    userAgent ? `Browser: ${userAgent}` : null,
  ].filter((line) => line !== null).join('\n');
  const html = `<p>${escapeHtml(message).replace(/\n/g, '<br>')}</p><hr>` +
    `<p><b>Name:</b> ${escapeHtml(name || '(not given)')}<br>` +
    `<b>Email:</b> ${escapeHtml(email)}<br>` +
    `<b>Topic:</b> ${escapeHtml(topic)}` +
    (userAgent ? `<br><b>Browser:</b> ${escapeHtml(userAgent)}` : '') + '</p>';
  return send({ to, subject, text, html, replyTo: email });
}

/**
 * An admin's reply to a contact message, sent from the support address to the
 * visitor. Reply-To points at the support inbox (never the noreply sender) so a
 * customer answering this email lands back in the queue.
 *
 * The original message is quoted underneath so a visitor who wrote weeks ago
 * knows what this is about.
 */
async function sendContactReply({ to, name, topic, replyBody, originalMessage, adminName }) {
  const greeting = name ? `Hi ${name},` : 'Hello,';
  const subject = `Re: [Nexa support] ${topic || 'your message'}`;
  const signature = adminName ? `${adminName} — Nexa Download Manager support` : 'Nexa Download Manager support';
  const quoted = String(originalMessage || '').trim();
  const text = [
    greeting,
    '',
    replyBody,
    '',
    '—',
    signature,
    quoted ? '' : null,
    quoted ? 'Your original message:' : null,
    quoted ? quoted.split('\n').map((line) => `> ${line}`).join('\n') : null,
  ].filter((line) => line !== null).join('\n');
  const html =
    `<p>${escapeHtml(greeting)}</p>` +
    `<p>${escapeHtml(replyBody).replace(/\n/g, '<br>')}</p>` +
    `<p>—<br>${escapeHtml(signature)}</p>` +
    (quoted
      ? `<hr><p style="color:#666"><b>Your original message:</b></p>` +
        `<blockquote style="color:#666;border-left:3px solid #ddd;margin:0;padding-left:12px">` +
        `${escapeHtml(quoted).replace(/\n/g, '<br>')}</blockquote>`
      : '');
  return send({ to, subject, text, html, replyTo: config.supportReplyTo });
}

/**
 * Invitation onto a Team licence. The link carries a one-time token; the
 * invitee must sign in with THIS address to accept, so a forwarded email
 * cannot hand the seat to somebody else.
 */
// A display name is whatever its owner typed. Putting it in a SUBJECT line
// sent from our own domain, to any address they choose, is a phishing kit:
// "Nexa Security: your licence is suspended, act now" reads as ours in every
// inbox list. So the subject is fixed, the name appears only in the body (where
// it is escaped and visibly attributed), and control characters — which are
// what turns a header value into two headers — are stripped either way.
function inviterLabel(ownerName) {
  const cleaned = String(ownerName || '').replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 60);
  return cleaned || 'A Nexa user';
}

async function sendTeamInviteEmail({ to, ownerName, ownerEmail, token }) {
  const link = `${config.FRONTEND_URL}/team/join?token=${encodeURIComponent(token)}`;
  const owner = inviterLabel(ownerName);
  // The inviter's address is the one piece of provenance the recipient can
  // actually check, so it goes in the body beside the name they chose.
  const from = ownerEmail ? ` (${ownerEmail})` : '';
  return send({
    to,
    subject: 'You have been invited to a Nexa Team licence',
    text: `${owner}${from} has invited you to join their Nexa Download Manager Team plan.\n\nAccept the invitation:\n${link}\n\nSign in (or create an account) with this email address — ${to} — to accept. The team's licence key then appears on your dashboard and unlocks Pro features in the app.\n\nThe name above was chosen by whoever sent this invitation. Nexa never asks for a password or payment details by email.\n\nIf you were not expecting this, ignore this email.`,
    html: `<p><strong>${escapeHtml(owner)}</strong>${escapeHtml(from)} has invited you to join their Nexa Download Manager <strong>Team</strong> plan.</p>` +
      `<p><a href="${escapeHtml(link)}">Accept the invitation</a></p>` +
      `<p>Sign in (or create an account) with this email address — <strong>${escapeHtml(to)}</strong> — to accept. The team's licence key then appears on your dashboard and unlocks Pro features in the app.</p>` +
      '<p style="color:#666;font-size:13px">The name above was chosen by whoever sent this invitation. '
      + 'Nexa never asks for a password or payment details by email.</p>'
      + '<p>If you were not expecting this, ignore this email.</p>',
  });
}

module.exports = {
  // Exported for the test that pins the sanitising rule; nothing else calls it.
  inviterLabel,
  sendTeamInviteEmail,
  sendContactMessage,
  sendContactReply,
  sendVerificationEmail,
  sendAccountExistsEmail,
  sendPasswordResetEmail,
  sendLicenseEmail,
  sendReceiptEmail,
  sendWelcomeEmail,
  sendTrialEndingEmail,
};
