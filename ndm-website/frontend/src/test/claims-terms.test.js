import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The Terms of Service and the "Signing in & seats" guide, held to what the app
 * and the license server do.
 *
 * Each old sentence below was checked against the code and found false:
 *
 *  - Terms said Free is "limited to 3 concurrent downloads" and Pro "removes the
 *    concurrency cap". Only direct file downloads are counted
 *    (DownloadEngine::activeCount); video-site, stream, MEGA and torrent jobs
 *    are not. On Pro the cap is the "Max simultaneous downloads" setting, which
 *    stops at 32 (SettingsDialog.cpp).
 *  - Terms promised "priority support". There is none.
 *  - Terms priced plans "exclusive of any taxes we are required to collect".
 *    Checkout collects no tax (no automatic_tax in utils/stripe.js).
 *  - Terms said shared keys "may be revoked". What happens is automatic: a
 *    license on far more machines than it has seats is suspended
 *    (routes/license.js, LICENSE_AUTO_SUSPEND on by default), the app shows
 *    every seat as in use, and support can lift it.
 *  - Terms said you delete your account by emailing support. It is
 *    self-service and immediate under Profile → Your data (routes/user.js).
 *  - The guide said a seat frees itself 15 minutes after the app closes.
 *    Quitting releases it at once (main.cpp → releaseSeat); closing the window
 *    hides Nexa to the tray and keeps it; only a crash or lost connection waits
 *    out the 15-minute lease. A refused computer stops heartbeating and asks
 *    again only at its six-hourly check, on a restart, or when a key is entered
 *    again (a key refused on first entry is never saved), so "stays on Free
 *    until one is free" was not true either.
 *  - The guide said nothing leaves the machine but a hashed fingerprint. The app
 *    also sends the computer's name and the app version, and the server keeps
 *    them with the IP address of each sign-in (routes/device.js).
 *  - The guide said `expired`/`cancelled` mean the plan or trial ended, and
 *    `invalid` means a badly formatted key. A plan or trial that ends answers as
 *    a valid Free plan; those two statuses are set only by hand; and a
 *    malformed key is refused by the app before any request.
 */
const PAGES = {
  terms: '../pages/Terms.jsx',
  license: '../pages/docs/DocsLicense.jsx',
};

// The path goes through a variable: Vite rewrites a literal
// `new URL('…', import.meta.url)` into a root-relative asset URL under jsdom.
const source = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// JSX splits a sentence across lines, entities and inline tags. Read it the way
// a visitor does, so a phrase is found however the markup breaks it.
const prose = (rel) => source(rel)
  .replace(/\{' '\}/g, ' ')
  .replace(/<\/?>|<\/?(?:Code|strong|em|Link|a)\b[^>]*>/g, '')
  .replace(/&apos;|&rsquo;/g, "'")
  .replace(/&[lr]dquo;/g, '"')
  .replace(/&rarr;/g, '→')
  .replace(/&mdash;/g, '—')
  .replace(/\s+/g, ' ');

const terms = prose(PAGES.terms);
const license = prose(PAGES.license);

describe('Terms of Service — plans', () => {
  it('no longer promises priority support', () => {
    expect(terms).not.toMatch(/priority support/i);
  });

  it('does not call Pro unlimited or uncapped', () => {
    expect(terms).not.toMatch(/unlimited/i);
    expect(terms).not.toMatch(/removes the concurrency cap/i);
    expect(terms).toMatch(/Pro lets you run up to 32 at once/);
  });

  it("says Free's limit of 3 counts direct file downloads only", () => {
    expect(terms).not.toMatch(/limited to 3 concurrent downloads/i);
    expect(terms).toMatch(/runs up to 3 direct file downloads at once/);
    expect(terms).toMatch(/video-site, stream, MEGA and torrent downloads don't count toward that limit/);
  });

  it('does not claim to collect taxes the checkout never collects', () => {
    expect(terms).not.toMatch(/required to collect/i);
    expect(terms).toMatch(/Prices do not include any taxes that may apply\./);
  });
});

describe('Terms of Service — key sharing and account deletion', () => {
  it('describes the automatic suspension and what the app shows', () => {
    expect(terms).not.toMatch(/revoke keys that are being shared/i);
    expect(terms).toMatch(/far more computers than it has seats can be suspended automatically/);
    expect(terms).toMatch(/reports that all of its seats are in use/);
    expect(terms).toMatch(/we can lift the suspension/);
  });

  it('points at self-service deletion instead of an email to support', () => {
    expect(terms).not.toMatch(/delete your account by emailing support/i);
    expect(terms).toMatch(/delete your account yourself at any time from "Your data"/);
    expect(source(PAGES.terms)).toMatch(/<Link to="\/profile"/);
    expect(terms).toMatch(/Deletion takes effect immediately/);
    expect(terms).toMatch(/We keep payment records for tax purposes/);
  });
});

describe('Signing in & seats — when a seat frees', () => {
  it('no longer says a seat frees 15 minutes after the app closes', () => {
    expect(license).not.toMatch(/15 minutes after the app closes/i);
  });

  it('says quitting frees the seat and closing the window does not', () => {
    expect(license).toMatch(/File → Quit Nexa/);
    expect(license).toMatch(/gives the seat back right away/);
    expect(license).toMatch(/closing the window does not quit/);
    expect(license).toMatch(/15 minutes after the app last checked in/);
  });

  it('says a refused computer does not pick up a freed seat by itself', () => {
    expect(license).not.toMatch(/stays on Free until one is free/i);
    expect(license).not.toMatch(/Close the app elsewhere/i);
    expect(license).toMatch(/does not ask again on its own until its next full check, up to 6 hours later/);
    expect(license).toMatch(/restart Nexa on it if it is signed in, or enter the key and click Activate again/);
  });
});

describe('Signing in & seats — what the app sends', () => {
  it('lists the computer name, the app version and the stored IP address', () => {
    expect(license).not.toMatch(/except a hashed fingerprint/i);
    expect(license).toMatch(/the computer's name and operating system, and the app version/);
    expect(license).toMatch(/the IP address each sign-in came from/);
  });

  it('says how often the app talks to the license server', () => {
    expect(license).toMatch(/checks in when it starts, every 6 hours, every 5 minutes while it holds a seat/);
    expect(license).toMatch(/when you quit/);
  });
});

describe('Signing in & seats — status messages', () => {
  it('does not tie expired/cancelled to a plan or trial that ended', () => {
    expect(license).not.toMatch(/the paid plan or trial ended/i);
    expect(license).toMatch(/we stopped this license by hand/);
    expect(license).toMatch(/including one you cancelled, shows neither/);
  });

  it('does not say `invalid` means a badly formatted key', () => {
    expect(license).not.toMatch(/the key format is wrong/i);
    expect(license).toMatch(/Invalid license key format/);
  });

  it('says a suspended license answers seat_limit', () => {
    expect(license).toMatch(/suspended for being used on far more computers than it has seats answers the same way/);
  });
});
