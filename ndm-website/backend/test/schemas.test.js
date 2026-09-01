'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createReleaseSchema, updateReleaseSchema, sha256 } = require('../src/schemas/admin.schema');
const { downloadOsSchema, feedQuerySchema } = require('../src/schemas/release.schema');

const HEX64 = '0123456789abcdef'.repeat(4);

test('sha256 accepts 64 hex chars (any case, trimmed) and lowercases it', () => {
  assert.equal(sha256.parse(HEX64), HEX64);
  assert.equal(sha256.parse(`  ${HEX64.toUpperCase()} `), HEX64);
});

test('sha256 rejects wrong length and non-hex input', () => {
  for (const bad of [HEX64.slice(0, 63), `${HEX64}0`, 'g'.repeat(64), '', 'sha256:' + HEX64, 42, null]) {
    assert.equal(sha256.safeParse(bad).success, false, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test('createReleaseSchema accepts optional checksums and rejects invalid ones', () => {
  const base = { version: '0.2.0', windowsUrl: 'https://x.test/a.exe', linuxUrl: 'https://x.test/a.deb' };
  assert.deepEqual(createReleaseSchema.body.parse(base), base);
  const withSha = createReleaseSchema.body.parse({ ...base, windowsSha256: HEX64.toUpperCase(), linuxSha256: HEX64 });
  assert.equal(withSha.windowsSha256, HEX64);
  assert.equal(withSha.linuxSha256, HEX64);
  assert.equal(createReleaseSchema.body.safeParse({ ...base, windowsSha256: 'abc' }).success, false);
  assert.equal(createReleaseSchema.body.safeParse({ ...base, windowsSha256: null }).success, false);
  // .strict(): unknown keys are rejected
  assert.equal(createReleaseSchema.body.safeParse({ ...base, downloadCount: 5 }).success, false);
});

test('updateReleaseSchema allows clearing a checksum with null', () => {
  assert.deepEqual(updateReleaseSchema.body.parse({ windowsSha256: null }), { windowsSha256: null });
  assert.deepEqual(updateReleaseSchema.body.parse({ linuxSha256: HEX64 }), { linuxSha256: HEX64 });
  assert.equal(updateReleaseSchema.body.safeParse({ linuxSha256: 'xyz' }).success, false);
  assert.equal(updateReleaseSchema.body.safeParse({}).success, false);
});

test('release os schemas accept only windows|linux', () => {
  assert.deepEqual(downloadOsSchema.params.parse({ os: 'windows' }), { os: 'windows' });
  assert.deepEqual(feedQuerySchema.query.parse({ os: 'linux' }), { os: 'linux' });
  assert.equal(downloadOsSchema.params.safeParse({ os: 'macos' }).success, false);
  assert.equal(feedQuerySchema.query.safeParse({ os: 'Windows' }).success, false);
  assert.equal(feedQuerySchema.query.safeParse({}).success, false);
  assert.equal(feedQuerySchema.query.safeParse({ os: 'linux', extra: 1 }).success, false);
});

test('contactSchema: honeypot must stay empty, message needs a sentence, unknown keys rejected', () => {
  const { contactSchema } = require('../src/schemas/contact.schema');
  const good = { name: ' Ada ', email: 'ADA@Example.com', topic: 'bug', message: 'The app crashes on start.' };
  const parsed = contactSchema.body.parse(good);
  assert.equal(parsed.name, 'Ada');
  assert.equal(parsed.email, 'ada@example.com');
  assert.equal(parsed.website, '');
  assert.equal(contactSchema.body.parse({ email: 'a@b.co', message: 'Ten characters here' }).topic, 'general');
  assert.equal(contactSchema.body.safeParse({ ...good, website: 'http://spam' }).success, false);
  assert.equal(contactSchema.body.safeParse({ ...good, message: 'short' }).success, false);
  assert.equal(contactSchema.body.safeParse({ ...good, topic: 'sales' }).success, false);
  assert.equal(contactSchema.body.safeParse({ ...good, email: 'not-an-email' }).success, false);
  assert.equal(contactSchema.body.safeParse({ ...good, extra: 1 }).success, false);
});

test('contact admin schemas: reply needs a body, status is a closed set, ids coerce', () => {
  const {
    contactListQuerySchema, contactIdParamSchema, updateContactStatusSchema, contactReplySchema,
  } = require('../src/schemas/contact.schema');

  // Listing: paging defaults, optional filters, unknown keys rejected.
  assert.deepEqual(contactListQuerySchema.query.parse({}), { page: 1, limit: 20 });
  assert.equal(contactListQuerySchema.query.parse({ status: 'replied' }).status, 'replied');
  assert.equal(contactListQuerySchema.query.safeParse({ status: 'archived' }).success, false);
  assert.equal(contactListQuerySchema.query.safeParse({ topic: 'sales' }).success, false);
  assert.equal(contactListQuerySchema.query.safeParse({ limit: 500 }).success, false);
  assert.equal(contactListQuerySchema.query.safeParse({ nope: 1 }).success, false);

  // Params: the router hands strings over, so coercion matters.
  assert.deepEqual(contactIdParamSchema.params.parse({ id: '42' }), { id: 42 });
  assert.equal(contactIdParamSchema.params.safeParse({ id: '0' }).success, false);
  assert.equal(contactIdParamSchema.params.safeParse({ id: 'abc' }).success, false);

  // Status change.
  assert.deepEqual(updateContactStatusSchema.body.parse({ status: 'spam' }), { status: 'spam' });
  assert.equal(updateContactStatusSchema.body.safeParse({ status: 'deleted' }).success, false);
  assert.equal(updateContactStatusSchema.body.safeParse({}).success, false);

  // Reply: trimmed, non-trivial, `close` defaults to false.
  const reply = contactReplySchema.body.parse({ body: '  Thanks for writing in.  ' });
  assert.equal(reply.body, 'Thanks for writing in.');
  assert.equal(reply.close, false);
  assert.equal(contactReplySchema.body.parse({ body: 'ok', close: true }).close, true);
  assert.equal(contactReplySchema.body.safeParse({ body: ' ' }).success, false);
  assert.equal(contactReplySchema.body.safeParse({ body: 'x'.repeat(10001) }).success, false);
  assert.equal(contactReplySchema.body.safeParse({ body: 'ok', extra: 1 }).success, false);
});

test('googleSchema: a bounded credential string, nothing else', () => {
  const { googleSchema } = require('../src/schemas/auth.schema');
  const credential = 'a'.repeat(500);
  assert.deepEqual(googleSchema.body.parse({ credential }), { credential });
  assert.equal(googleSchema.body.parse({ credential: `  ${credential}  ` }).credential, credential);
  // Too short to be a JWT, and too long to be worth any crypto work.
  assert.equal(googleSchema.body.safeParse({ credential: 'short' }).success, false);
  assert.equal(googleSchema.body.safeParse({ credential: 'a'.repeat(4097) }).success, false);
  assert.equal(googleSchema.body.safeParse({}).success, false);
  // .strict(): a caller cannot smuggle its own email past verification.
  assert.equal(googleSchema.body.safeParse({ credential, email: 'a@b.co' }).success, false);
});

test('team schemas: invite needs an email, join needs a well-formed token', () => {
  const { inviteSchema, joinSchema, inviteLookupSchema } = require('../src/schemas/team.schema');
  assert.deepEqual(inviteSchema.body.parse({ email: ' Bob@Example.com ' }), { email: 'bob@example.com' });
  assert.equal(inviteSchema.body.safeParse({ email: 'nope' }).success, false);
  assert.equal(inviteSchema.body.safeParse({ email: 'a@b.co', role: 'admin' }).success, false);
  const token = 'A'.repeat(43);
  assert.deepEqual(joinSchema.body.parse({ token }), { token });
  assert.equal(joinSchema.body.safeParse({ token: 'short' }).success, false);
  assert.equal(joinSchema.body.safeParse({ token: `${token}$` }).success, false);
  assert.deepEqual(inviteLookupSchema.params.parse({ token }), { token });
});

test('two-factor schemas: 6-digit enable code, recovery codes allowed at login, disable needs password', () => {
  const { twoFactorLoginSchema, twoFactorEnableSchema, twoFactorDisableSchema } = require('../src/schemas/twoFactor.schema');
  assert.deepEqual(twoFactorEnableSchema.body.parse({ code: ' 123456 ' }), { code: '123456' });
  assert.equal(twoFactorEnableSchema.body.safeParse({ code: 'k7f3q-9x2mp' }).success, false);
  assert.equal(twoFactorLoginSchema.body.safeParse({ challenge: 'x'.repeat(30), code: 'k7f3q-9x2mp' }).success, true);
  assert.equal(twoFactorLoginSchema.body.safeParse({ challenge: 'short', code: '123456' }).success, false);
  assert.equal(twoFactorDisableSchema.body.safeParse({ code: '123456' }).success, false);
  assert.equal(twoFactorDisableSchema.body.safeParse({ password: 'pw', code: '123456' }).success, true);
});

test('deleteAccountSchema demands the password and the literal word DELETE', () => {
  const { deleteAccountSchema } = require('../src/schemas/user.schema');
  assert.deepEqual(deleteAccountSchema.body.parse({ password: 'pw', confirm: ' DELETE ' }), { password: 'pw', confirm: 'DELETE' });
  assert.equal(deleteAccountSchema.body.safeParse({ password: 'pw', confirm: 'delete' }).success, false);
  assert.equal(deleteAccountSchema.body.safeParse({ password: '', confirm: 'DELETE' }).success, false);
  assert.equal(deleteAccountSchema.body.safeParse({ password: 'pw', confirm: 'DELETE', extra: 1 }).success, false);
});
