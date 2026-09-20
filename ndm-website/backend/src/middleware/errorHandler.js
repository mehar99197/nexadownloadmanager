'use strict';

const { ZodError } = require('zod');
const config = require('../config/env');

function notFound(req, res) {
  return res.status(404).json({
    ok: false,
    error: { code: 'NOT_FOUND', message: `Route not found: ${req.method} ${req.originalUrl}` },
  });
}

function errorHandler(err, req, res, next) {
  // Headers already on the wire — an installer stream that failed part way,
  // say. Nothing sent from here could be a well-formed answer any more, so
  // hand it to Express, which closes the connection; trying to write a JSON
  // body over a half-sent response would only throw a second error.
  if (res.headersSent) return next(err);

  let status = err.status || 500;
  let code = err.code || 'INTERNAL_ERROR';
  let message = err.message || 'Something went wrong';
  let details;

  if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Invalid input';
    details = err.flatten();
  } else if (err.name === 'TokenExpiredError') {
    status = 401; code = 'TOKEN_EXPIRED'; message = 'Token expired';
  } else if (err.name === 'JsonWebTokenError') {
    status = 401; code = 'INVALID_TOKEN'; message = 'Invalid token';
  } else if (err.code === 'ER_DUP_ENTRY') {
    status = 409; code = 'DUPLICATE'; message = 'Duplicate entry';
    // MySQL's text names the table, the index and the value that collided —
    // an email address, on any route with a unique constraint on one. In
    // production that is schema disclosure and, worse, the account oracle
    // /auth/register was rewritten to close, re-opened one layer down. It
    // stays in development, where it is the fastest way to see which key.
    if (!config.isProd) details = err.sqlMessage;
  } else if (err.code === 'ER_NO_REFERENCED_ROW_2') {
    status = 400; code = 'BAD_REQUEST'; message = 'Referenced record does not exist';
  }

  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error('[error]', err);
    // An error nobody gave a status is an unexpected throw, and its message
    // is whatever threw — a driver, a library, a file path. None of that is
    // for the caller in production; the log above has it. A deliberate 5xx
    // (a 503 BILLING_UNAVAILABLE, say) chose its wording and keeps it.
    if (config.isProd && !err.status) message = 'Something went wrong';
  }

  const error = { code, message };
  if (details !== undefined) error.details = details;
  if (!config.isProd && status >= 500) error.stack = err.stack;

  return res.status(status).json({ ok: false, error });
}

module.exports = { notFound, errorHandler };
