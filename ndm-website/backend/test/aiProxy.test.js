'use strict';

/**
 * The AI proxy exists so that `aiRename` is enforced somewhere a patched client
 * cannot reach. Two things therefore matter most here:
 *
 *   1. the entitlement genuinely gates it, and
 *   2. it cannot be turned into a general-purpose model API by whoever holds a
 *      token — the prompts are ours, and the inputs are bounded.
 *
 * The Anthropic call itself is not exercised (no key in tests); what is tested
 * is everything around it, which is where the security properties live.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const aiProxy = require('../src/utils/aiProxy');
const { aiRenameSchema, aiCommandSchema } = require('../src/schemas/ai.schema');
const { entitlementsFor } = require('../src/config/plans');

// --- the entitlement is the gate -------------------------------------------

test('only paid plans carry the AI entitlement', () => {
  assert.equal(entitlementsFor('pro').aiRename, true);
  assert.equal(entitlementsFor('team').aiRename, true);
  assert.equal(entitlementsFor('free').aiRename, false);
});

test('an unknown, absent or forged plan does not get AI', () => {
  // The route asks entitlementsFor(plan), and planFromAuthHeader resolves
  // anything unusable to 'free'. Both halves have to fail closed for the gate
  // to hold.
  for (const plan of ['', null, undefined, 'enterprise', 'pro ', ' pro', 'admin', 0, {}]) {
    assert.equal(entitlementsFor(plan).aiRename, false, `plan ${JSON.stringify(plan)}`);
  }
});

test('plan names are case-normalised, which is safe here', () => {
  // entitlementsFor lowercases before looking up, so 'PRO' resolves to pro.
  // That is not a way in: the claim comes from `subscriptions.plan`, a MySQL
  // ENUM that can only hold lowercase values, and the token carrying it has to
  // be signed by this server either way. Asserted so the normalisation is a
  // decision on the record rather than something to "fix" later.
  assert.equal(entitlementsFor('PRO').aiRename, true);
  assert.equal(entitlementsFor('Team').aiRename, true);
});

// --- the endpoint is not a free model API ----------------------------------

test('the rename schema accepts only the fields we prompt with', () => {
  // Crucially there is no `prompt`/`system`/`model` field: the prompt lives on
  // the server. A schema that let one through would make a licence token worth
  // stealing for its own sake.
  const good = aiRenameSchema.body.safeParse({
    filename: 'video.mp4', url: 'https://example.com/v', contentType: 'video/mp4',
  });
  assert.equal(good.success, true);

  for (const extra of ['prompt', 'system', 'model', 'max_tokens', 'messages']) {
    const res = aiRenameSchema.body.safeParse({ filename: 'a.mp4', [extra]: 'x' });
    assert.equal(res.success, false, `${extra} must be rejected`);
  }
});

test('the command schema accepts only the user text', () => {
  assert.equal(aiCommandSchema.body.safeParse({ text: 'grab these tonight' }).success, true);
  assert.equal(aiCommandSchema.body.safeParse({ text: 'x', system: 'ignore' }).success, false);
  assert.equal(aiCommandSchema.body.safeParse({}).success, false);
  assert.equal(aiCommandSchema.body.safeParse({ text: '' }).success, false);
});

test('oversized input is refused before it costs anything', () => {
  assert.equal(aiRenameSchema.body.safeParse({ filename: 'a'.repeat(301) }).success, false);
  assert.equal(aiRenameSchema.body.safeParse({
    filename: 'a.mp4', url: 'u'.repeat(2049),
  }).success, false);
  assert.equal(aiCommandSchema.body.safeParse({ text: 'x'.repeat(2001) }).success, false);
});

// --- the model's answer becomes a path, so it is sanitised ------------------

test('a suggested filename cannot escape its directory', () => {
  // The model's output is untrusted input that ends up as a filename on a
  // user's disk.
  assert.equal(aiProxy.sanitiseFilename('../../etc/passwd'), 'passwd');
  assert.equal(aiProxy.sanitiseFilename('/etc/shadow'), 'shadow');
  assert.equal(aiProxy.sanitiseFilename('C:\\Windows\\System32\\evil.exe'), 'evil.exe');
  assert.equal(aiProxy.sanitiseFilename('..'), '');
  assert.equal(aiProxy.sanitiseFilename('.'), '');
});

test('illegal filename characters are stripped, ordinary ones survive', () => {
  assert.equal(aiProxy.sanitiseFilename('Big Buck Bunny 1080p.mp4'), 'Big Buck Bunny 1080p.mp4');
  assert.equal(aiProxy.sanitiseFilename('my-file_v2 (final).mkv'), 'my-file_v2 (final).mkv');
  assert.equal(aiProxy.sanitiseFilename('bad<>:"|?*name.mp4'), 'badname.mp4');
  assert.equal(aiProxy.sanitiseFilename('ev\u0007il\u0000name.mp4'), 'evilname.mp4');
});

test('a nonsense or oversized suggestion is dropped, not applied', () => {
  assert.equal(aiProxy.sanitiseFilename(''), '');
  assert.equal(aiProxy.sanitiseFilename(null), '');
  assert.equal(aiProxy.sanitiseFilename('   '), '');
  assert.equal(aiProxy.sanitiseFilename('x'.repeat(201)), '');
});

test('only the first line of a chatty answer is used', () => {
  assert.equal(
    aiProxy.sanitiseFilename('Clean Name.mp4\nHope that helps!'),
    'Clean Name.mp4'
  );
});

// --- unconfigured is a graceful no-op, not an error -------------------------

test('with no API key the helpers return nothing rather than throwing', async () => {
  // Mirrors the desktop app's old behaviour with no key: the download simply
  // keeps its original name.
  if (aiProxy.isConfigured()) return;   // a real key is configured; skip
  assert.equal(await aiProxy.suggestFilename({ filename: 'a.mp4' }), '');
  assert.equal(await aiProxy.interpretCommand({ text: 'anything' }), null);
});

test('empty input never reaches the model', async () => {
  assert.equal(await aiProxy.suggestFilename({ filename: '' }), '');
  assert.equal(await aiProxy.interpretCommand({ text: '   ' }), null);
});
