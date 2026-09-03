'use strict';

/**
 * Where is this server running, and does that make it a PUBLIC deployment?
 *
 * The security posture used to hang entirely on NODE_ENV: every fail-closed
 * check in config/env.js was skipped unless it said "production". That is one
 * word in a file nobody looks at, and the live box ran for weeks with it set
 * to "development" — dev secrets tolerated, Stripe in mock mode with unsigned
 * webhooks, cookies without Secure, stack traces in 500s — while serving the
 * real domain behind the real proxy.
 *
 * FRONTEND_URL is a signal that cannot be forgotten in the same way: it has to
 * name the public site or every email link is wrong. So a deployment counts as
 * public whenever that URL is not a loopback or private-network address, and
 * a public deployment gets the production checks whether or not NODE_ENV says
 * so. NODE_ENV=production still turns them on unconditionally.
 *
 * Loaded by config/env.js AND config/licenseKeys.js (which cannot require
 * env.js — see its header), so dotenv runs here, once, before either reads
 * process.env.
 */

require('dotenv').config();

const NODE_ENV = process.env.NODE_ENV || 'development';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

/**
 * Loopback, RFC 1918, link-local and `.local`/`.localhost` names. A phone on
 * the same Wi-Fi testing http://192.168.1.5:5173 is still development; a
 * hostname anybody on the internet can resolve is not. Anything unparsable is
 * treated as public — the safe direction.
 */
function isPrivateHost(url) {
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '127.0.0.1') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  return false;
}

const isProd = NODE_ENV === 'production';
const isLocalDeployment = isPrivateHost(FRONTEND_URL);
// Production checks apply here. Either NODE_ENV says so, or the site is public.
const isHardened = isProd || !isLocalDeployment;

module.exports = { NODE_ENV, FRONTEND_URL, isProd, isLocalDeployment, isHardened, isPrivateHost };
