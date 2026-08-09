'use strict';

const { verifyAdmin } = require('../utils/jwt');
const { fail } = require('../utils/respond');
const config = require('../config/env');
const User = require('../models/User');

function ipWhitelist(req, res, next) {
  const allowed = config.ADMIN_ALLOWED_IPS;
  if (!allowed || allowed.length === 0) return next();
  const ip = req.ip;
  const normalized = ip && ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (allowed.includes(ip) || allowed.includes(normalized)) return next();
  return fail(res, 'IP_FORBIDDEN', 'Access from this IP is not allowed', 403);
}

function extractBearer(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

async function verifyAdminToken(req, res, next) {
  try {
    const token = extractBearer(req);
    if (!token) return fail(res, 'UNAUTHORIZED', 'Admin authentication required', 401);
    const payload = verifyAdmin(token);
    const user = await User.findById(Number(payload.sub));
    if (!user || user.role !== 'admin')
      return fail(res, 'FORBIDDEN', 'Admin access required', 403);
    if (user.banned) return fail(res, 'FORBIDDEN', 'Account is banned', 403);
    req.admin = user;
    return next();
  } catch (err) {
    return next(err);
  }
}

const requireAdmin = [ipWhitelist, verifyAdminToken];

module.exports = { ipWhitelist, requireAdmin, verifyAdminToken };
