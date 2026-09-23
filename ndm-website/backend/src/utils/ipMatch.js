'use strict';

/**
 * Does an address match an allow-list entry? (AUDIT.md M-06)
 *
 * The list used to be compared with `list.includes(ip)`. That is exact string
 * equality, which means a consumer connection locks its owner out of both
 * panels the moment the ISP rotates the address — and an IPv6 client never
 * matches an IPv4 entry at all, so a host that starts handing out v6 does the
 * same thing without changing anything.
 *
 * An entry may be:
 *
 *   '*'                       every address (the deliberate opt-out)
 *   '203.0.113.7'             one IPv4 address
 *   '203.0.113.0/24'          an IPv4 range
 *   '2001:db8::1'             one IPv6 address
 *   '2001:db8::/32'           an IPv6 range
 *
 * IPv4-mapped IPv6 (`::ffff:203.0.113.7`, which is what Node reports on a
 * dual-stack socket) is compared as the IPv4 address it carries, so one entry
 * covers a client however it happens to connect.
 *
 * Everything is done on the bytes rather than on the text: a prefix comparison
 * of strings would call 203.0.113.7 a match for 203.0.113.70, and matching
 * IPv6 textually is hopeless anyway — ::1, 0:0:0:0:0:0:0:1 and 0::1 are the
 * same address written three ways.
 */

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** IPv4 text → 4 bytes, or null. Rejects 1.2.3.4.5, 256.x, 01.2.3.4, ''. */
function v4Bytes(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i];
    // No leading zeros: some resolvers read 0177.0.0.1 as octal, and a list
    // entry that means one thing here and another elsewhere is a trap.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

/** IPv6 text → 16 bytes, or null. Handles '::' and a trailing IPv4 tail. */
function v6Bytes(text) {
  let str = String(text);
  if (!str.includes(':')) return null;

  // A trailing dotted quad (::ffff:1.2.3.4) becomes its two hex groups.
  const lastColon = str.lastIndexOf(':');
  const tail = str.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = v4Bytes(tail);
    if (!v4) return null;
    const hex = (n) => n.toString(16).padStart(2, '0');
    str = `${str.slice(0, lastColon + 1)}${hex(v4[0])}${hex(v4[1])}:${hex(v4[2])}${hex(v4[3])}`;
  }

  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;

  const groups = [];
  const push = (list) => {
    for (const g of list) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return false;
      groups.push(parseInt(g, 16));
    }
    return true;
  };

  if (rest === null) {
    // No '::' — every group has to be written out.
    if (head.length !== 8 || !push(head)) return null;
  } else {
    if (!push(head)) return null;
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;   // '::' must stand for at least one group
    for (let i = 0; i < fill; i += 1) groups.push(0);
    if (!push(rest)) return null;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    bytes[i * 2] = groups[i] >> 8;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  return bytes;
}

/**
 * Any address text → { bytes, bits }. An IPv4-mapped v6 address comes back as
 * the IPv4 it carries, so the two forms of one client compare equal.
 */
function parseAddress(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const mapped = raw.match(MAPPED_V4);
  const candidate = mapped ? mapped[1] : raw;

  const v4 = v4Bytes(candidate);
  if (v4) return { bytes: v4, bits: 32 };
  const v6 = v6Bytes(candidate);
  if (v6) return { bytes: v6, bits: 128 };
  return null;
}

/** Do the first `prefix` bits of two byte arrays agree? */
function samePrefix(a, b, prefix) {
  const whole = prefix >> 3;
  for (let i = 0; i < whole; i += 1) if (a[i] !== b[i]) return false;
  const spare = prefix & 7;
  if (spare === 0) return true;
  const mask = (0xff << (8 - spare)) & 0xff;
  return (a[whole] & mask) === (b[whole] & mask);
}

/**
 * Is `entry` a usable allow-list entry? Used to refuse a typo at the point
 * somebody types it, rather than at the point it silently fails to match.
 */
function isValidEntry(entry) {
  const text = String(entry || '').trim();
  if (text === '*') return true;
  const slash = text.indexOf('/');
  if (slash === -1) return parseAddress(text) !== null;

  const addr = parseAddress(text.slice(0, slash));
  if (!addr) return false;
  const prefixText = text.slice(slash + 1);
  if (!/^(0|[1-9]\d?|1[01]\d|12[0-8])$/.test(prefixText)) return false;
  return Number(prefixText) <= addr.bits;
}

/** Does `ip` match this one entry? */
function matchesEntry(entry, ip) {
  const text = String(entry || '').trim();
  if (!text) return false;
  if (text === '*') return true;

  const client = parseAddress(ip);
  if (!client) return false;

  const slash = text.indexOf('/');
  if (slash === -1) {
    const target = parseAddress(text);
    if (!target || target.bits !== client.bits) return false;
    return samePrefix(target.bytes, client.bytes, target.bits);
  }

  const network = parseAddress(text.slice(0, slash));
  const prefix = Number(text.slice(slash + 1));
  if (!network || !Number.isInteger(prefix) || prefix < 0) return false;
  // A v4 range never covers a v6 client, or the other way round. The
  // mapped-v4 normalisation above is what makes that the right answer rather
  // than a surprise.
  if (network.bits !== client.bits || prefix > network.bits) return false;
  return samePrefix(network.bytes, client.bytes, prefix);
}

/** Does `ip` match any entry? An empty list allows everything, as before. */
function ipMatches(list, ip) {
  if (!Array.isArray(list) || list.length === 0) return true;
  return list.some((entry) => matchesEntry(entry, ip));
}

module.exports = { ipMatches, matchesEntry, isValidEntry, parseAddress };
