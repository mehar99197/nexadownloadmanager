'use strict';

/**
 * How the mail transport is built (AUDIT.md M-11).
 *
 * `secure` only covers port 465, where TLS wraps the connection from the first
 * byte. On 587 — the default, and the port most relays use — nodemailer
 * negotiates STARTTLS *if the server offers it* and otherwise continues in the
 * clear, sending SMTP_USER and SMTP_PASS along with every verification link,
 * reset token and licence key. It also downgrades silently: strip STARTTLS
 * from the greeting and the same thing happens with nothing logged.
 *
 * Each case runs in its own process. The transport is memoised in a module
 * variable and config/env.js reads the environment once at load, so two cases
 * in one process would be answering about whichever ran first.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const backendRoot = path.resolve(__dirname, '..');

// Replaces nodemailer before email.js requires it, sends one message, and
// prints the options the transport was built with.
const PROBE = `
  const Module = require('module');
  const stub = {
    createTransport(options) {
      console.log('TRANSPORT_OPTIONS ' + JSON.stringify(options));
      return { sendMail: async () => ({ stubbed: true }) };
    },
  };
  Module._load = ((load) => function (request, parent, isMain) {
    if (request === 'nodemailer') return stub;
    return load(request, parent, isMain);
  })(Module._load);

  // send() is internal; any exported sender reaches it. The welcome mail has
  // the simplest signature and no side effects beyond the send itself.
  const email = require('./src/utils/email');
  email.sendWelcomeEmail({ name: 'Ada', email: 'someone@example.test' })
    .then(() => process.exit(0))
    .catch((err) => { console.error('SEND_FAILED', err.message); process.exit(1); });
`;

function transportOptions(extraEnv = {}) {
  const res = spawnSync(process.execPath, ['-e', PROBE], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      FRONTEND_URL: 'http://localhost:5173',
      SMTP_USER: 'mailer@example.test',
      SMTP_PASS: 'a-real-smtp-password',
      ...extraEnv,
    },
  });
  const line = (res.stdout || '').split('\n').find((l) => l.startsWith('TRANSPORT_OPTIONS '));
  assert.ok(line, `no transport was built:\n${res.stdout}\n${res.stderr}`);
  return JSON.parse(line.slice('TRANSPORT_OPTIONS '.length));
}

test('a relay on the default port must negotiate STARTTLS, not merely offer it', () => {
  const options = transportOptions({ SMTP_HOST: 'smtp.example.test' });
  assert.equal(options.port, 587);
  assert.equal(options.secure, false, 'port 587 is not implicit TLS');
  assert.equal(options.requireTLS, true, 'without this the session can stay in the clear');
  assert.equal(options.tls.minVersion, 'TLSv1.2');
  // The thing the encryption is protecting, present and correct.
  assert.equal(options.auth.pass, 'a-real-smtp-password');
});

test('port 465 keeps implicit TLS, and requiring it as well costs nothing', () => {
  const options = transportOptions({ SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465' });
  assert.equal(options.secure, true);
  assert.equal(options.requireTLS, true);
  assert.equal(options.tls.minVersion, 'TLSv1.2');
});

test('a relay on loopback is exempt — there is no network to encrypt', () => {
  // A developer running MailHog or Mailpit should not have to terminate TLS to
  // read a test message.
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    const options = transportOptions({ SMTP_HOST: host, SMTP_PORT: '1025' });
    assert.equal(options.requireTLS, false, host);
    assert.equal(options.tls, undefined, host);
  }
});

test('a hostname that merely starts with 127, or is bracketed, is judged correctly', () => {
  // 127.evil.com and 1270.example.com are somebody else's machines. An earlier
  // draft of the check matched both, which would have exempted them.
  for (const host of ['127.evil.com', '1270.example.com', '192.168.1.5']) {
    assert.equal(transportOptions({ SMTP_HOST: host }).requireTLS, true, host);
  }
  // [::1] is how an IPv6 literal is written in a host field.
  assert.equal(transportOptions({ SMTP_HOST: '[::1]', SMTP_PORT: '1025' }).requireTLS, false);
});

test('with no SMTP_HOST nothing is built at all — mock mode logs instead', () => {
  const res = spawnSync(process.execPath, ['-e', PROBE], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', FRONTEND_URL: 'http://localhost:5173', SMTP_HOST: '' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!res.stdout.includes('TRANSPORT_OPTIONS'), 'mock mode must not build a transport');
  assert.match(res.stdout, /\[email:mock\]/);
});
