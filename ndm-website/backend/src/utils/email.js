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

async function send({ to, subject, text, html }) {
  const message = { from: config.FROM_EMAIL, to, subject, text, html };
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

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendLicenseEmail,
};
