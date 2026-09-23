'use strict';

const { ZodError } = require('zod');
const config = require('../config/env');

function notFound(req, res) {
  return res.status(404).json({
    ok: false,
    // The URL is deliberately not echoed (AUDIT.md L-08). The content type is
    // JSON so reflecting it was never browser-exploitable, but repeating
    // attacker-supplied text back to them earns nothing: the caller already
    // knows what they asked for, and the full URL is in the access log for
    // anyone who needs it.
    error: { code: 'NOT_FOUND', message: `Route not found: ${req.method}` },
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
    // err.sqlMessage is MySQL's own text: it names the index and quotes the
    // value that collided ("Duplicate entry 'a@b.com' for key
    // 'users.uq_users_email'"), which hands out both the schema and, on a
    // public endpoint, a confirmation that the value already exists. Keep it
    // for local debugging only — the same switch that governs stack traces.
    if (config.exposeStackTraces) details = err.sqlMessage;
  } else if (err.code === 'ER_NO_REFERENCED_ROW_2') {
    status = 400; code = 'BAD_REQUEST'; message = 'Referenced record does not exist';
  } else if (err.type === 'entity.parse.failed') {
    // body-parser: the JSON did not parse. Its own code is the parser's
    // internal one and its message quotes the byte offset — neither is an
    // API contract, and 'INTERNAL_ERROR' on a 400 read as our fault.
    status = 400; code = 'BAD_JSON'; message = 'Request body is not valid JSON';
  } else if (err.type === 'entity.too.large') {
    status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request body is too large';
  }

  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error('[error]', err);
    // An UNEXPECTED 5xx message is whatever threw — a MySQL column name, a
    // file path, a third-party SDK's wording. Log it, but do not serve it in
    // production. `err.status` is what tells the two apart: a route that
    // chose its own 5xx (`503 BILLING_UNAVAILABLE`, say) wrote that wording
    // for the customer to read, and masking it turns a clear "payments are
    // off right now" into "Something went wrong".
    if (config.isProd && !err.status) { code = 'INTERNAL_ERROR'; message = 'Something went wrong'; }
  }

  const error = { code, message };
  if (details !== undefined) error.details = details;
  if (config.exposeStackTraces && status >= 500) error.stack = err.stack;

  return res.status(status).json({ ok: false, error });
}

module.exports = { notFound, errorHandler };
