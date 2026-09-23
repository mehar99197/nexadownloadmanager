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

// A relay reached over the network must be reached over TLS (AUDIT.md M-11).
//
// `secure` alone only covers port 465, where TLS wraps the connection from the
// first byte. On 587 — the default here and the port most relays use —
// nodemailer negotiates STARTTLS *if the server offers it* and otherwise
// carries on in the clear, which sends SMTP_USER and SMTP_PASS, and every
// verification link, reset token and licence key, as plaintext. It also
// downgrades silently: an attacker who can strip the STARTTLS capability from
// the greeting gets the same result and nothing logs a complaint.
//
// requireTLS turns that into a refusal to send. Failing to deliver an email is
// a worse outcome than delivering one, but it is a much better outcome than
// handing the credentials to whoever is on the path.
//
// The exception is a relay on loopback, where there is no network to be on:
// a developer running MailHog or Mailpit on 127.0.0.1:1025 should not have to
// terminate TLS to see a test message. Anything else, including a relay on the
// LAN, has a network hop and has to encrypt it.
function isLoopbackRelay(host) {
  // Strips the brackets an IPv6 literal is written with: [::1].
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function getTransport() {
  if (config.isEmailMock) return null;
  if (!transport) {
    const loopback = isLoopbackRelay(config.SMTP_HOST);
    transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      requireTLS: !loopback,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
      // TLS 1.0 and 1.1 are withdrawn. Without a floor, node offers whatever
      // the relay asks for, so a downgrade is the relay's decision to make.
      tls: loopback ? undefined : { minVersion: 'TLSv1.2' },
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

/**
 * Sent when a control-panel account's own password is used at the CUSTOMER
 * sign-in page.
 *
 * The site answers that attempt with the ordinary `INVALID_CREDENTIALS`, byte
 * for byte, because a distinct answer would tell whoever typed it that this
 * particular address is the administrator's — the one address on the site worth
 * attacking, handed over for the price of a password from some unrelated leak.
 *
 * So the wire says nothing and the truth goes where it belongs: the mailbox
 * that owns the account. For the owner it explains a refusal that would
 * otherwise look like "my password stopped working". For everyone else it is
 * the alarm you actually want, because reaching this point means the password
 * matched — somebody, somewhere, is holding a working control-panel password.
 *
 * Carries no link that grants anything: the console is reached from a URL the
 * reader already knows, so a forwarded copy of this is inert.
 */
async function sendControlPanelSignInAttemptEmail(user) {
  const name = escapeHtml(user.name || '');
  const console_ = `${config.FRONTEND_URL.replace(/\/+$/, '')}${user.role === 'root' ? '/root' : '/admin'}`;
  const safeConsole = escapeHtml(console_);
  return send({
    to: user.email,
    subject: 'Your control-panel password was used at the customer sign-in page',
    text: `Hi ${user.name || ''},\n\nSomebody just signed in with this account's password at the CUSTOMER sign-in page. It was refused: control-panel accounts have no customer session, and the customer site never says why.\n\nIf that was you, use the control panel instead:\n${console_}\n\nIf it was NOT you, then somebody else has a working control-panel password for this account. Change it now, and check the audit log once you are in.`,
    html: `<p>Hi ${name},</p>`
      + "<p>Somebody just signed in with this account&rsquo;s password at the <strong>customer</strong> sign-in page. "
      + 'It was refused: control-panel accounts have no customer session, and the customer site never says why.</p>'
      + `<p>If that was you, use the control panel instead: <a href="${safeConsole}">${safeConsole}</a></p>`
      + '<p>If it was <strong>not</strong> you, then somebody else has a working control-panel password for this '
      + 'account. Change it now, and check the audit log once you are in.</p>',
  });
}

/**
 * Sent when repeated wrong passwords lock password sign-in for a while
 * (utils/loginLockout.js). The sign-in form itself says nothing — a guesser
 * must not learn they tripped anything — so this is where the owner finds
 * out, together with the one action that both ends the lock and takes the
 * password out of the guesser's reach.
 */
async function sendAccountLockedEmail(user, { minutes }) {
  const name = escapeHtml(user.name || '');
  const reset = `${config.FRONTEND_URL}/forgot-password`;
  const safeReset = escapeHtml(reset);
  const when = `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return send({
    to: user.email,
    subject: 'Sign-in to your NexaDownloadManager account was locked',
    text: `Hi ${user.name || ''},\n\nSomebody entered the wrong password for your account too many times, so password sign-in is paused for ${when}.\n\nIf that was you, wait and try again. If it was not, reset your password now — that ends the pause immediately and signs out anyone else:\n${reset}\n\nSigning in with Google is not affected.`,
    html: `<p>Hi ${name},</p><p>Somebody entered the wrong password for your account too many times, so password sign-in is paused for <strong>${when}</strong>.</p><p>If that was you, wait and try again. If it was not, <a href="${safeReset}">reset your password now</a> — that ends the pause immediately and signs out anyone else.</p><p>Signing in with Google is not affected.</p>`,
  });
}

/**
 * A machine was just connected to the account from the desktop app. Sent to
 * the account's address whatever the outcome later — this is how the owner
 * of a mailbox learns that somebody with their website session added a
 * device they do not recognise.
 */
async function sendDeviceSignedInEmail(user, { deviceName, ip }) {
  const name = escapeHtml(user.name || '');
  const device = deviceName || 'a device';
  const where = ip ? ` from ${ip}` : '';
  const dashboard = `${config.FRONTEND_URL}/dashboard`;
  return send({
    to: user.email,
    subject: 'A new device signed in to your NexaDownloadManager account',
    text: `Hi ${user.name || ''},

Nexa Download Manager was just signed in on "${device}"${where}.

If that was you, there is nothing to do. If it was not, open your dashboard, sign that device out and change your password:
${dashboard}`,
    html: `<p>Hi ${name},</p><p>Nexa Download Manager was just signed in on <strong>${escapeHtml(device)}</strong>${escapeHtml(where)}.</p><p>If that was you, there is nothing to do. If it was not, <a href="${escapeHtml(dashboard)}">open your dashboard</a>, sign that device out and change your password.</p>`,
  });
}

/** Plain-text operator alert from utils/securityEvents.js. */
async function sendSecurityAlertEmail(to, subject, text) {
  return send({ to, subject: `${subject} — Nexa Download Manager`, text });
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
  const url = escapeHtml(config.FRONTEND_URL);
  return send({
    to: user.email,
    subject: `Your NexaDownloadManager ${plan} plan is active`,
    text: `Hi ${user.name || ''},\n\nThank you for subscribing to the ${plan} plan!\n\nTo use it, open Nexa Download Manager and go to Settings > Account > Sign in with Nexa. Approve the code that opens in your browser and this plan follows your account — there is nothing to paste.\n\nYour license key, for activating by hand on a machine you cannot sign in on:\n${licenseKey}\n\nIt is always on your dashboard: ${config.FRONTEND_URL}/dashboard`,
    html: `<p>Hi ${name},</p><p>Thank you for subscribing to the <strong>${safePlan}</strong> plan!</p><p>To use it, open Nexa Download Manager and go to <strong>Settings &rarr; Account &rarr; Sign in with Nexa</strong>. Approve the code that opens in your browser and this plan follows your account &mdash; there is nothing to paste.</p><p>Your license key, for activating by hand on a machine you cannot sign in on:</p><pre>${safeLicenseKey}</pre><p>It is always on your <a href="${url}/dashboard">dashboard</a>.</p>`,
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
    text: `Hi ${user.name || ''},\n\nYour Nexa account is ready.\n\n1. Download the app: ${config.FRONTEND_URL}/download\n2. Add the browser extension: ${config.FRONTEND_URL}/docs/extension\n3. In the app, open Settings > Account and sign in — your plan follows your account, with no key to copy.\n\nEvery account includes a 7-day Pro trial — no card needed.`,
    html: `<p>Hi ${name},</p><p>Your Nexa account is ready.</p><ol><li><a href="${url}/download">Download the app</a></li><li><a href="${url}/docs/extension">Add the browser extension</a></li><li>In the app, open <strong>Settings &rarr; Account</strong> and sign in &mdash; your plan follows your account, with no key to copy</li></ol><p>Every account includes a <strong>7-day Pro trial</strong> — no card needed.</p>`,
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
// Anything going into a Subject: line, flattened (AUDIT.md L-09).
//
// Nodemailer encodes headers, so a newline here is not injectable today. The
// point is that it should not reach the encoder in the first place — header
// safety would then be one dependency's implementation detail away, and the
// next thing to build a header from this text might not encode at all. Also
// trims, because a subject is one line and 200 characters is already long.
function headerSafe(value, max = 200) {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

async function sendContactMessage({ name, email, topic, message, userAgent }) {
  const to = config.SUPPORT_EMAIL || config.FROM_EMAIL;
  const safeTopic = headerSafe(topic, 60);
  const safeName = headerSafe(name, 60);
  const subject = `[Nexa contact] ${safeTopic}${safeName ? ` — ${safeName}` : ''}`;
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
  sendControlPanelSignInAttemptEmail,
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
  sendAccountLockedEmail,
  sendSecurityAlertEmail,
  sendDeviceSignedInEmail,
};
