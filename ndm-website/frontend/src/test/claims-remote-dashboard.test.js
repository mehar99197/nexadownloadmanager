import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * What the remote-dashboard pages say, held to what the app does.
 *
 * The dashboard is a remote control for someone's computer, so the two pages
 * that explain it are security documentation. An audit against src/main.cpp,
 * src/web/WebServer.cpp and src/ui/SettingsDialog.cpp found them describing a
 * token that changed on every start (it is created once and kept), a log file
 * the token never reached (it can), controls the page does not have, a
 * bookmark that cannot work and a flag that starts nothing on its own. Each
 * corrected claim is pinned here so the old wording cannot drift back.
 */
const PAGES = {
  docs: '../pages/docs/DocsRemote.jsx',
  feature: '../pages/features/FeatureRemoteDashboard.jsx',
};

const source = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// JSX breaks a sentence across lines, entities and inline tags. Read it the way
// a visitor does, so a phrase is found however the markup splits it.
const prose = (rel) => source(rel)
  .replace(/\{' '\}/g, ' ')
  .replace(/<\/?(?:Code|strong|em|Link)\b[^>]*>/g, '')
  .replace(/&apos;/g, "'")
  .replace(/&[lr]dquo;/g, '"')
  .replace(/&rarr;/g, '→')
  .replace(/\s+/g, ' ');

const docs = prose(PAGES.docs);
const feature = prose(PAGES.feature);
const both = [['docs', docs], ['feature', feature]];

describe('remote dashboard pages — the access token', () => {
  it.each(both)('%s: no longer says the token changes on every start', (_, text) => {
    expect(text).not.toMatch(/generated on each start/i);
    expect(text).not.toMatch(/random per start/i);
    expect(text).not.toMatch(/generated each time the app starts/i);
    expect(text).not.toMatch(/restart invalidates/i);
    expect(text).not.toMatch(/generated a new random token/i);
    expect(text).not.toMatch(/pin (a|your own) token|unless pinned/i);
  });

  it.each(both)('%s: says the token is created once and kept, so a link survives restarts', (_, text) => {
    expect(text).toMatch(/created once and kept/i);
    expect(text).toMatch(/keeps working after a restart/i);
    expect(text).toMatch(/no button/i);
  });

  it('docs: says --dashboard-token lasts one launch and is never saved', () => {
    expect(docs).toMatch(/--dashboard-token[^.]*that launch only[^.]*never saved/i);
  });

  it('docs: no longer promises the token stays out of log files', () => {
    expect(docs).not.toMatch(/never to log files/i);
    expect(docs).toMatch(/nexa\.log/);
    expect(docs).toMatch(/Save error logs to a file \(for troubleshooting\)/);
    expect(docs).toMatch(/Export logs…/);
  });

  it.each(both)('%s: tells you to keep the link, not a bookmark of the open page', (_, text) => {
    expect(text).not.toMatch(/bookmark the (full|whole) URL/i);
    expect(text).not.toMatch(/opens straight to the queue/i);
    expect(text).toMatch(/token from the address bar/i);
    expect(text).toMatch(/Copy link/);
  });
});

describe('remote dashboard pages — what the phone page can do', () => {
  it.each(both)('%s: lists only the columns and controls the page has', (_, text) => {
    expect(text).not.toMatch(/\bETA\b/);
    expect(text).not.toMatch(/toggle the global speed limit/i);
    expect(text).not.toMatch(/for everything at once/i);
    expect(text).not.toMatch(/aggregate (speed|throughput)/i);
    expect(text).not.toMatch(/total speed and active count at the top/i);
    expect(text).not.toMatch(/pause, resume,? (and )?cancel|resume \/ cancel/i);
    expect(text).not.toMatch(/reordering or pausing from either/i);
  });

  it.each(both)('%s: does not say a download added from the phone starts by itself', (_, text) => {
    expect(text).not.toMatch(/it starts on the desktop/i);
    expect(text).toMatch(/Ask before starting a download/);
  });
});

describe('remote dashboard pages — starting it and reaching it', () => {
  it.each(both)('%s: leads with Settings and the real default port', (_, text) => {
    expect(text).not.toMatch(/8765/);
    expect(text).not.toMatch(/The app prints the URL/i);
    expect(text).not.toMatch(/which is what the flags map to/i);
    expect(text).toMatch(/Run the web dashboard while Nexa is open/);
    expect(text).toMatch(/8088/);
    expect(text).toMatch(/not already running/i);
  });

  it.each(Object.entries(PAGES))('%s: never offers --dashboard-lan alone as a way to start it', (_, rel) => {
    expect(source(rel)).not.toMatch(/^nexa --dashboard-lan\b/m);
    expect(prose(rel)).toMatch(/--dashboard --dashboard-lan/);
  });

  it.each(both)('%s: says LAN mode listens on every interface, not "your LAN address"', (_, text) => {
    expect(text).not.toMatch(/(binds? to|listening on|bind to) (your|the|a) LAN address/i);
    expect(text).toMatch(/every network interface/i);
  });

  it('docs: says LAN mode without TLS does not start at all, rather than being ignored', () => {
    expect(docs).not.toMatch(/is ignored/i);
    expect(docs).toMatch(/does not start at all, not even on 127\.0\.0\.1/);
  });

  it('feature: says LAN mode without TLS does not start at all, rather than being ignored', () => {
    expect(feature).not.toMatch(/ignores the request/i);
    expect(feature).toMatch(/not start the dashboard at all/i);
  });

  it.each(both)('%s: spells it the way the server does ("unauthorized")', (_, text) => {
    expect(text).not.toMatch(/unauthoris/i);
  });
});
