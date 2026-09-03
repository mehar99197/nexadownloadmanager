'use strict';

/**
 * The server side of the desktop app's AI helpers.
 *
 * Why this exists: the app used to call api.anthropic.com directly with a key
 * read from $ANTHROPIC_API_KEY. That made the `aiRename` entitlement pure
 * decoration — the gate was a client-side boolean over an API the client
 * reached by itself — so AI rename could not honestly be sold as a paid
 * feature. Moving the call here means a patched client with `aiRename: true`
 * gains nothing: the request still has to satisfy this server, holding a token
 * this server signed, for a plan this server says includes it.
 *
 * The prompts live HERE, not in the request body, and that is the whole point.
 * A proxy that forwarded a client-supplied prompt would be a free Claude
 * gateway for anyone who extracted a licence token — the entitlement check
 * would gate *who* pays nothing, not *what* they can ask. Each endpoint is
 * narrow, its prompt fixed, and its max_tokens small.
 */

const config = require('./../config/env');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Small on purpose: these tasks produce a filename or a short JSON object, and
// a low cap is what stops a crafted input from running up a bill.
const RENAME_MAX_TOKENS = 64;
const COMMAND_MAX_TOKENS = 512;

// Bounds on what a client may send. Long inputs cost money and buy nothing.
const MAX_FILENAME_CHARS = 300;
const MAX_URL_CHARS = 2048;
const MAX_COMMAND_CHARS = 2000;

function isConfigured() {
  return Boolean(config.ANTHROPIC_API_KEY);
}

function clamp(value, max) {
  return String(value === undefined || value === null ? '' : value).slice(0, max);
}

/**
 * One call to Anthropic. Returns the assistant's text, or '' on any failure —
 * callers fall back to leaving the filename alone, exactly as the desktop app
 * did when it had no key.
 */
async function ask(systemPrompt, userMessage, maxTokens) {
  if (!isConfigured()) return '';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: config.AI_MODEL,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    if (!response.ok) return '';
    const body = await response.json();
    if (!body || body.type === 'error' || !Array.isArray(body.content)) return '';
    return body.content
      .filter((block) => block && block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
  } catch {
    return '';               // network error, timeout, bad JSON — all the same
  } finally {
    clearTimeout(timeout);
  }
}

const RENAME_SYSTEM = 'You rename downloaded files to clean, descriptive, human-readable names. '
  + 'Rules: keep the original file extension; use spaces or hyphens, no slashes '
  + 'or illegal filename characters; be concise; reply with ONLY the new '
  + 'filename and nothing else.';

/**
 * Suggest a filename. Returns '' when nothing usable came back.
 *
 * The result is sanitised here as well as on the client. The model's output is
 * untrusted input that ends up as a path on someone's disk, so a path
 * separator or a traversal segment must not survive — and the client checking
 * too is not a reason for the server to skip it.
 */
async function suggestFilename({ filename, url, contentType }) {
  const name = clamp(filename, MAX_FILENAME_CHARS);
  if (!name) return '';
  const user = `Original filename: ${name}\n`
    + `Source URL: ${clamp(url, MAX_URL_CHARS)}\n`
    + `Content-Type: ${clamp(contentType, 100) || 'unknown'}\n`
    + 'Give a better filename (keep the extension).';

  const text = await ask(RENAME_SYSTEM, user, RENAME_MAX_TOKENS);
  return sanitiseFilename(text);
}

function sanitiseFilename(raw) {
  let name = String(raw || '').split('\n')[0].trim();
  name = name.replace(/["'`]/g, '');
  // Drop any directory part the model invented, then anything that is not
  // legal in a filename on the platforms this ships to.
  name = name.split(/[\\/]/).pop() || '';
  // The same set the desktop client strips. Spaces and hyphens deliberately
  // survive - the prompt asks for them and they are legal on every platform
  // this ships to; a class that ate them would mangle every name.
  name = name.replace(/[\\/:*?"<>|]/g, '')
    // Control characters have no business in a filename and would not
    // survive a round trip through the client's own checks anyway.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  // A name that is only dots would be a traversal segment.
  if (/^\.+$/.test(name)) return '';
  return name.length > 0 && name.length <= 200 ? name : '';
}

const COMMAND_SYSTEM = 'You convert a user\'s download request into strict JSON with this shape: '
  + '{"downloads":[{"url":"..."}],"schedule":{"atIso":"<ISO8601 or empty>",'
  + '"recurrence":"<none|daily|weekly>"}}. '
  + 'Extract every URL or magnet link. If the user names a time, set atIso to an '
  + 'absolute ISO-8601 timestamp; otherwise leave it empty. Reply with ONLY the JSON.';

/**
 * Turn a natural-language request into {downloads, schedule}.
 * Returns null when the model produced nothing parseable.
 */
async function interpretCommand({ text }) {
  const message = clamp(text, MAX_COMMAND_CHARS);
  if (!message) return null;

  const out = await ask(COMMAND_SYSTEM, message, COMMAND_MAX_TOKENS);
  if (!out) return null;
  // The model may wrap the JSON in prose or fences.
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(out.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object') return null;
    // Hand back only the shape the client expects. The client re-validates every
    // URL's scheme regardless — the model's output is never trusted to name a
    // file:// target — but there is no reason to relay anything else either.
    const downloads = Array.isArray(parsed.downloads)
      ? parsed.downloads
        .filter((d) => d && typeof d.url === 'string')
        .slice(0, 50)
        .map((d) => ({ url: clamp(d.url, MAX_URL_CHARS) }))
      : [];
    const schedule = parsed.schedule && typeof parsed.schedule === 'object' ? parsed.schedule : {};
    return {
      downloads,
      schedule: {
        atIso: clamp(schedule.atIso, 40),
        recurrence: ['none', 'daily', 'weekly'].includes(schedule.recurrence)
          ? schedule.recurrence : 'none',
      },
    };
  } catch {
    return null;
  }
}

module.exports = {
  isConfigured, suggestFilename, interpretCommand, sanitiseFilename,
  RENAME_MAX_TOKENS, COMMAND_MAX_TOKENS,
  MAX_FILENAME_CHARS, MAX_URL_CHARS, MAX_COMMAND_CHARS,
};
