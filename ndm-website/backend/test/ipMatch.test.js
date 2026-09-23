'use strict';

/**
 * utils/ipMatch.js — the comparison the admin IP gate is built on (AUDIT.md
 * M-06). A gate is only as good as its matcher, so the cases that matter here
 * are the ones where a sloppy implementation says YES and should not.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { ipMatches, matchesEntry, isValidEntry, parseAddress } = require('../src/utils/ipMatch');

test('an exact IPv4 entry matches itself and nothing else', () => {
  assert.equal(matchesEntry('203.0.113.7', '203.0.113.7'), true);
  assert.equal(matchesEntry('203.0.113.7', '203.0.113.8'), false);
  // The one a string prefix comparison gets wrong.
  assert.equal(matchesEntry('203.0.113.7', '203.0.113.70'), false);
  assert.equal(matchesEntry('203.0.113.7', '103.0.113.7'), false);
});

test('an IPv4-mapped IPv6 client matches the plain IPv4 entry', () => {
  // What Node reports on a dual-stack socket.
  assert.equal(matchesEntry('203.0.113.7', '::ffff:203.0.113.7'), true);
  assert.equal(matchesEntry('203.0.113.7', '::ffff:203.0.113.8'), false);
  // And the other direction, for a list written the long way.
  assert.equal(matchesEntry('::ffff:203.0.113.7', '203.0.113.7'), true);
});

test('an IPv4 CIDR covers its range and stops at the boundary', () => {
  assert.equal(matchesEntry('203.0.113.0/24', '203.0.113.0'), true);
  assert.equal(matchesEntry('203.0.113.0/24', '203.0.113.255'), true);
  assert.equal(matchesEntry('203.0.113.0/24', '203.0.114.0'), false);
  assert.equal(matchesEntry('203.0.113.0/24', '203.0.112.255'), false);
  // A /25 splits that block in half — the bit-level case a byte-wise
  // comparison would get wrong.
  assert.equal(matchesEntry('203.0.113.0/25', '203.0.113.127'), true);
  assert.equal(matchesEntry('203.0.113.0/25', '203.0.113.128'), false);
  // /32 is one address; /0 is all of IPv4.
  assert.equal(matchesEntry('203.0.113.7/32', '203.0.113.7'), true);
  assert.equal(matchesEntry('203.0.113.7/32', '203.0.113.8'), false);
  assert.equal(matchesEntry('0.0.0.0/0', '8.8.8.8'), true);
});

test('an IPv6 CIDR works on the bits, whichever way the address is written', () => {
  assert.equal(matchesEntry('2001:db8::/32', '2001:db8:1234:5678::1'), true);
  assert.equal(matchesEntry('2001:db8::/32', '2001:db9::1'), false);
  assert.equal(matchesEntry('2001:db8:1234:5678::/64', '2001:db8:1234:5678:ffff:ffff:ffff:ffff'), true);
  assert.equal(matchesEntry('2001:db8:1234:5678::/64', '2001:db8:1234:5679::1'), false);
  // Three spellings of the loopback address are one address.
  for (const form of ['::1', '0:0:0:0:0:0:0:1', '0::1']) {
    assert.equal(matchesEntry('::1', form), true, form);
  }
});

test('a v4 entry never covers a v6 client, or the other way round', () => {
  // ::ffff:… is normalised to IPv4 first, so this is about genuine v6.
  assert.equal(matchesEntry('0.0.0.0/0', '2001:db8::1'), false);
  assert.equal(matchesEntry('::/0', '203.0.113.7'), false);
  assert.equal(matchesEntry('203.0.113.7', '2001:db8::1'), false);
});

test('* matches everything, and an empty list still allows everything', () => {
  for (const ip of ['203.0.113.7', '::ffff:8.8.8.8', '2001:db8::1']) {
    assert.equal(matchesEntry('*', ip), true, ip);
  }
  assert.equal(ipMatches([], '203.0.113.7'), true);
  assert.equal(ipMatches(['*', '203.0.113.7'], '8.8.8.8'), true);
});

test('a list matches when any one entry does', () => {
  const list = ['203.0.113.0/24', '2001:db8::/32', '198.51.100.7'];
  assert.equal(ipMatches(list, '203.0.113.9'), true);
  assert.equal(ipMatches(list, '2001:db8::99'), true);
  assert.equal(ipMatches(list, '198.51.100.7'), true);
  assert.equal(ipMatches(list, '198.51.100.8'), false);
});

test('rubbish never matches, and never throws', () => {
  const junk = ['', '   ', 'not-an-ip', '999.1.1.1', '1.2.3', '1.2.3.4.5',
    '203.0.113.0/33', '2001:db8::/129', '203.0.113.0/-1', '::/x', null, undefined];
  for (const entry of junk) {
    assert.equal(matchesEntry(entry, '203.0.113.7'), false, String(entry));
  }
  for (const ip of junk) {
    assert.equal(matchesEntry('203.0.113.7', ip), false, String(ip));
    assert.equal(matchesEntry('203.0.113.0/24', ip), false, String(ip));
  }
  // '*' is the one entry that does not care what the client sent, but a
  // client with no address at all is still not a match for a real entry.
  assert.equal(matchesEntry('*', 'not-an-ip'), true);
});

test('leading zeros are refused rather than read as octal', () => {
  // 0177.0.0.1 is 127.0.0.1 to some resolvers. An entry that means one thing
  // here and another elsewhere is worse than one that is simply rejected.
  assert.equal(parseAddress('0177.0.0.1'), null);
  assert.equal(parseAddress('01.2.3.4'), null);
  assert.equal(isValidEntry('010.0.0.1'), false);
  assert.notEqual(parseAddress('0.0.0.0'), null);
});

test('isValidEntry accepts what matches and refuses what cannot', () => {
  for (const good of ['*', '203.0.113.7', '203.0.113.0/24', '0.0.0.0/0',
    '2001:db8::1', '2001:db8::/32', '::1', '::/0', '::ffff:203.0.113.7']) {
    assert.equal(isValidEntry(good), true, good);
  }
  for (const bad of ['', 'localhost', '203.0.113.7/', '203.0.113.7/33',
    '2001:db8::/129', '1.2.3', '1.2.3.4.5', '256.0.0.1', 'x/24', '203.0.113.0/2a']) {
    assert.equal(isValidEntry(bad), false, bad);
  }
});
