'use strict';

/**
 * M-04 — what an error response is allowed to say in production.
 *
 * `details` used to carry MySQL's own duplicate-key text unconditionally:
 * "Duplicate entry 'someone@example.test' for key 'users.email'" names the
 * table, the index and the value — schema disclosure, and on any route with
 * a unique constraint on an address, the account oracle /auth/register was
 * rewritten to close. Only the stack was gated on !isProd.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_value_that_is_long_enough_x1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ZodError, z } = require('zod');

const config = require('../src/config/env');
const { errorHandler } = require('../src/middleware/errorHandler');

function run(err, { prod, headersSent = false } = {}) {
  // Both flags together, because that is how config/env.js derives them:
  // exposeStackTraces = !isHardened, and isHardened is true for NODE_ENV
  // production AND for any deployment on a public address. Flipping isProd
  // alone would describe a production that cannot exist.
  const was = { isProd: config.isProd, exposeStackTraces: config.exposeStackTraces };
  config.isProd = prod;
  config.exposeStackTraces = !prod;
  const sent = {};
  const res = {
    headersSent,
    status(code) { sent.status = code; return this; },
    json(body) { sent.body = body; return this; },
  };
  let passedOn = null;
  try {
    errorHandler(err, {}, res, (e) => { passedOn = e; });
  } finally {
    Object.assign(config, was);
  }
  return { ...sent, passedOn };
}

const dupEntry = Object.assign(new Error('ER_DUP_ENTRY'), {
  code: 'ER_DUP_ENTRY',
  sqlMessage: "Duplicate entry 'someone@example.test' for key 'users.email'",
});

test('a duplicate-key error never names the table, index or value in production', () => {
  const { status, body } = run(dupEntry, { prod: true });
  assert.equal(status, 409);
  assert.equal(body.error.code, 'DUPLICATE');
  assert.equal(body.error.message, 'Duplicate entry');
  assert.equal(body.error.details, undefined);
  assert.doesNotMatch(JSON.stringify(body), /someone@example\.test|users\.email/);
});

test('...but says exactly which key in development', () => {
  const { body } = run(dupEntry, { prod: false });
  assert.match(body.error.details, /users\.email/);
});

test('an unexpected throw is a bare INTERNAL_ERROR in production', () => {
  const err = new Error("ENOENT: no such file, open '/home/deploy/uploads/releases/x.exe'");
  const { status, body } = run(err, { prod: true });
  assert.equal(status, 500);
  assert.equal(body.error.code, 'INTERNAL_ERROR');
  assert.equal(body.error.message, 'Something went wrong');
  assert.equal(body.error.stack, undefined);
  assert.doesNotMatch(JSON.stringify(body), /deploy|uploads/);
});

test('a deliberate 5xx keeps the wording it chose', () => {
  const err = Object.assign(new Error('Billing is not available on this deployment'),
    { status: 503, code: 'BILLING_UNAVAILABLE' });
  const { status, body } = run(err, { prod: true });
  assert.equal(status, 503);
  assert.equal(body.error.code, 'BILLING_UNAVAILABLE');
  assert.equal(body.error.message, 'Billing is not available on this deployment');
});

test('development keeps the message and the stack for a 500', () => {
  const err = new Error('boom');
  const { body } = run(err, { prod: false });
  assert.equal(body.error.message, 'boom');
  assert.match(body.error.stack, /boom/);
});

test('validation errors are shaped the same in both modes', () => {
  let zerr;
  try { z.object({ email: z.string().email() }).parse({ email: 'nope' }); } catch (e) { zerr = e; }
  assert.ok(zerr instanceof ZodError);
  for (const prod of [true, false]) {
    const { status, body } = run(zerr, { prod });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.ok(body.error.details.fieldErrors.email);
  }
});

test('an error after the headers went out is handed to Express, not written over the body', () => {
  const { status, body, passedOn } = run(new Error('stream broke'), { prod: true, headersSent: true });
  assert.equal(status, undefined, 'nothing more was written');
  assert.equal(body, undefined);
  assert.equal(passedOn.message, 'stream broke');
});
