/**
 * The privacy and security claims on four pages — Privacy, Security, Contact
 * and the browser-extension feature page — pinned to what the code does.
 *
 * An audit found these pages saying things the product does not do: a paid
 * install that "never" asks for a promo, cookies read "only for that
 * download", a permission the extension never requests, a table whose counts
 * did not match its rows. Each assertion below keeps one of those from coming
 * back. Most read the page source as prose, because several claims only
 * render when a build flag is on; the last block renders the privacy policy
 * to check that those flags really decide what it names.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { render } from '@testing-library/react';

// A variable, not a literal: vitest under jsdom rewrites
// new URL('../pages/x', import.meta.url) into a root-relative URL.
const HERE = import.meta.url;
const read = (path) => readFileSync(new URL(path, HERE), 'utf8');

// Roughly the text a reader sees: tags and {' '} gone, entities and curly
// quotes folded, whitespace collapsed, so a sentence split across lines or
// around a <strong> still matches as one string.
function prose(src) {
  return src
    .replace(/\{' '\}/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&apos;|[‘’]/g, "'")
    .replace(/&ldquo;|&rdquo;|[“”]/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

const SOURCE = {
  privacy: read('../pages/Privacy.jsx'),
  security: read('../pages/Security.jsx'),
  contact: read('../pages/Contact.jsx'),
  extension: read('../pages/features/FeatureBrowserExtension.jsx'),
};
const TEXT = Object.fromEntries(Object.entries(SOURCE).map(([page, src]) => [page, prose(src)]));

describe('claims the audit found false are gone', () => {
  const REMOVED = [
    // Nothing schedules backups yet (no cron runs backup.sh), so none are nightly.
    ['privacy', 'nightly'],
    ['security', 'nightly'],
    // A paid install asks once at launch, before its plan is confirmed.
    ['privacy', 'no request for one is made'],
    ['security', 'do not make this request at all'],
    ['privacy', 'Free plan only'],
    ['security', 'Free plan only'],
    // The promo request also names the placement and the app version.
    ['privacy', 'that is the only thing sent'],
    // Validation runs at launch and every 6 hours, plus a 5-minute heartbeat.
    ['security', 'every few hours'],
    // The extension works in the background and reads provider-wide cookies.
    ['privacy', 'only for that download'],
    ['security', 'does not collect in the background'],
    ['security', 'for the site of the download you just triggered'],
    ['security', 'do not cross the internet'],
    ['extension', 'not harvested in the background'],
    ['extension', 'only for the site of the download you just triggered'],
    ['extension', 'and nowhere else'],
    ['privacy', 'cookies stay on your machine'],
    // It fetches HLS master playlists from the site you are watching.
    ['privacy', 'any other remote host'],
    ['privacy', 'the only channel'],
    ['extension', 'never downloads anything'],
    // There is no webNavigation permission, and no default-quality setting;
    // both browsers use scripting.
    ['security', 'Access browser activity during navigation'],
    ['extension', 'Access browser activity during navigation'],
    ['privacy', 'default quality'],
    ['privacy', 'Chromium only'],
    // Third parties are named, and the site sets more than one cookie.
    ['privacy', 'Our email provider'],
    ['privacy', 'Our hosting provider'],
    ['privacy', 'sets only the cookies it needs'],
    // IPs are kept in sessions and a 90-day security log, not only in a log.
    ['privacy', 'kept short-term'],
    ['security', 'kept short-term'],
    // Contact messages are stored with the sender's IP and browser.
    ['contact', 'nothing else is stored'],
    // Deletion is self-service and immediate; some records outlive it.
    ['privacy', 'to export or delete your account'],
    ['privacy', 'within 30 days'],
    ['security', 'and we will action it'],
    // No card digits are stored.
    ['security', 'last four digits'],
    // The flows table has more rows than the old counts said.
    ['security', 'Three of them reach us'],
    ['security', 'the two places'],
    ['security', 'the two features'],
    // Settings live in the registry on Windows; keys in the OS keychain.
    ['privacy', 'data folder removes them'],
    // The checksum applies to direct file downloads only.
    ['security', 'verification on any download'],
    // A sniffed MP4 gets the button; the bridge starts the app itself.
    ['extension', 'Progressive MP4 videos have no manifest'],
    ['extension', 'has never been launched since the extension was installed'],
    ['extension', 'the quality levels the site actually published'],
  ];

  it.each(REMOVED)('%s no longer says “%s”', (page, phrase) => {
    expect(TEXT[page]).not.toContain(phrase);
  });
});

describe('the pages state what the code does', () => {
  const PRESENT = [
    ['privacy', 'every 6 hours'],
    ['privacy', 'every 5 minutes'],
    ['privacy', '/api/license/heartbeat'],
    ['privacy', '/api/license/release'],
    ['privacy', '/api/device'],
    ['privacy', "the computer's name"],
    ['privacy', 'Hostinger'],
    ['privacy', 'Gmail'],
    ['privacy', 'Google Fonts'],
    ['privacy', 'Have I Been Pwned'],
    ['privacy', 'first five characters'],
    ['privacy', 'ndm_refresh'],
    ['privacy', 'ndm_session'],
    ['privacy', 'ndm_gnonce'],
    ['privacy', 'g_state'],
    ['privacy', 'Credential Manager'],
    ['privacy', 'registry'],
    ['privacy', 'scripts from GitHub'],
    ['privacy', '"Your data"'],
    ['privacy', 'for tax'],
    ['privacy', '90 days'],
    ['privacy', 'backups made before the deletion'],
    ['security', 'every 6 hours'],
    ['security', 'every 5 minutes'],
    ['security', 'computer name'],
    ['security', 'No card digits'],
    ['security', 'direct file downloads'],
    ['security', 'scripts from GitHub'],
    ['security', '"Your data"'],
    ['extension', 'Best available (DASH)'],
    ['extension', 'cross-origin iframe'],
    ['extension', 'top-right corner'],
    ['extension', 'progressive MP4s included'],
    ['extension', 'six seconds'],
    ['contact', 'IP address'],
    ['contact', 'do not delete it automatically'],
  ];

  it.each(PRESENT)('%s says “%s”', (page, phrase) => {
    expect(TEXT[page]).toContain(phrase);
  });

  it('decides Turnstile, Google sign-in and Plausible from the build, not from prose', () => {
    expect(SOURCE.privacy).toContain('turnstileEnabled()');
    expect(SOURCE.privacy).toContain('googleAuthEnabled()');
    expect(SOURCE.privacy).toContain('VITE_PLAUSIBLE_DOMAIN');
  });
});

describe('the permission tables match the extension manifests', () => {
  const manifests = ['extension-chromium', 'extension-firefox']
    .map((dir) => JSON.parse(read(`../../../../${dir}/manifest.json`)));
  const permissions = manifests[0].permissions;

  it('reads the same permissions from both browsers’ manifests', () => {
    expect(permissions.length).toBeGreaterThan(0);
    for (const m of manifests) {
      expect([...m.permissions].sort()).toEqual([...permissions].sort());
      expect(m.host_permissions).toEqual(['<all_urls>']);
    }
  });

  it.each(['privacy', 'security', 'extension'])('%s lists every permission and host access', (page) => {
    for (const permission of permissions) expect(SOURCE[page]).toContain(`'${permission}'`);
    expect(SOURCE[page]).toContain('<all_urls>');
    expect(TEXT[page]).not.toContain('webNavigation');
  });
});

describe('the security page’s counts match its flows table', () => {
  const flows = SOURCE.security.slice(
    SOURCE.security.indexOf('const FLOWS'),
    SOURCE.security.indexOf('const TONE'),
  );
  const count = (tone) => flows.split(`tone: '${tone}'`).length - 1;
  const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const good = count('good');
  const amber = count('warn');
  const reach = count('info') + amber;
  const cap = (word) => word[0].toUpperCase() + word.slice(1);

  it('names how many rows reach us, how many are amber and how many never do', () => {
    expect(TEXT.security).toContain(`${cap(WORDS[reach])} of them reach us`);
    expect(TEXT.security).toContain(`${WORDS[amber]} of those`);
    expect(TEXT.security).toContain(`other ${WORDS[good]} never reach us`);
  });

  it('gives the amber count in the intro and the page description too', () => {
    expect(TEXT.security).toContain(`the ${WORDS[amber]} places`);
    expect(TEXT.security).toContain(`the ${WORDS[amber]} requests`);
  });
});

describe('the privacy policy names build-time services only when the build has them', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // Fresh modules each time: Turnstile and GoogleButton read their keys when
  // they are first imported, so a stubbed variable only counts after a reset.
  async function renderPrivacy(env) {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.resetModules();
    const { MemoryRouter } = await import('react-router-dom');
    const { default: Privacy } = await import('../pages/Privacy.jsx');
    render(createElement(MemoryRouter, null, createElement(Privacy)));
    return document.body.textContent.replace(/\s+/g, ' ');
  }

  it('says nothing of Turnstile or Plausible when the build has neither', async () => {
    const text = await renderPrivacy({ VITE_TURNSTILE_SITE_KEY: '', VITE_PLAUSIBLE_DOMAIN: '' });
    expect(text).not.toMatch(/Turnstile|Cloudflare/);
    expect(text).not.toMatch(/Plausible/);
    expect(text).toContain('runs no analytics');
  });

  it('names Cloudflare Turnstile and Plausible when the build switches them on', async () => {
    const text = await renderPrivacy({
      VITE_TURNSTILE_SITE_KEY: 'test-site-key',
      VITE_PLAUSIBLE_DOMAIN: 'nexadownloadmanager.com',
    });
    expect(text).toContain('Cloudflare Turnstile');
    expect(text).toContain('Plausible');
    expect(text).not.toContain('runs no analytics');
  });

  it('leaves out Google sign-in and its cookies when the build has no client ID', async () => {
    const text = await renderPrivacy({ VITE_GOOGLE_CLIENT_ID: '' });
    expect(text).not.toContain('g_state');
    expect(text).not.toContain('ndm_gnonce');
    expect(text).not.toContain('Continue with Google');
  });

  it('names Google sign-in and its cookies when the build has a client ID', async () => {
    const text = await renderPrivacy({ VITE_GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com' });
    expect(text).toContain('g_state');
    expect(text).toContain('ndm_gnonce');
    expect(text).toContain('Continue with Google');
  });
});
