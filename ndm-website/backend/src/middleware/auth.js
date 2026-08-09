'use strict';

const { verifyAccess } = require('../utils/jwt');
const { fail } = require('../utils/respond');
const User = require('../models/User');

function extractBearer(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

async function requireAuth(req, res, next) {
  try {
    const token = extractBearer(req);
    if (!token) return fail(res, 'UNAUTHORIZED', 'Authentication required', 401);
    const payload = verifyAccess(token);
    const user = await User.findById(Number(payload.sub));
    if (!user) return fail(res, 'UNAUTHORIZED', 'Account not found', 401);
    if (user.banned) return fail(res, 'FORBIDDEN', 'Account is banned', 403);
    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireAuth };
