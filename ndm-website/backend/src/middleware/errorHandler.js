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
  }

  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error('[error]', err);
  }

  const error = { code, message };
  if (details !== undefined) error.details = details;
  if (config.exposeStackTraces && status >= 500) error.stack = err.stack;

  return res.status(status).json({ ok: false, error });
}

module.exports = { notFound, errorHandler };
