import { test, expect } from '@playwright/test';

// Every test stubs the API, so these never depend on a backend being up.
const RELEASE = {
  version: '0.2.0',
  windowsUrl: 'https://cdn.example.test/nexa.exe',
  linuxUrl: 'https://cdn.example.test/nexa.deb',
  windowsSha256: 'a'.repeat(64),
  linuxSha256: 'b'.repeat(64),
  changelog: 'Faster everything',
  publishedAt: '2026-08-30T00:00:00.000Z',
  downloadCount: 42,
};

async function stubApi(page, { stats = { users: 5, downloads: 42 }, release = RELEASE } = {}) {
  // Playwright matches routes in REVERSE registration order, so the catch-all
  // has to be registered FIRST or it would swallow every specific stub below.
  await page.route('**/api/**', (r) => r.fulfill({ json: { ok: true, data: {} } }));

  // Signed out: the session endpoints must refuse, or ProtectedRoute would let
  // the visitor through and the redirect test would be meaningless.
  await page.route('**/api/auth/refresh', (r) =>
    r.fulfill({ status: 401, json: { ok: false, error: { code: 'NO_REFRESH_TOKEN', message: 'no session' } } }));
  await page.route('**/api/user/me', (r) =>
    r.fulfill({ status: 401, json: { ok: false, error: { code: 'UNAUTHORIZED', message: 'no session' } } }));

  await page.route('**/api/stats', (r) =>
    r.fulfill({ json: { ok: true, data: stats } }));
  await page.route('**/api/releases/latest', (r) =>
    release
      ? r.fulfill({ json: { ok: true, data: release } })
      : r.fulfill({ status: 404, json: { ok: false, error: { code: 'NO_RELEASE', message: 'none' } } }));
  await page.route('**/api/subscription/plans', (r) =>
    r.fulfill({ json: { ok: true, data: {
      free: { id: 'free', name: 'Free', price: 0, features: ['3 concurrent downloads'] },
      pro: { id: 'pro', name: 'Pro', monthly: 5, yearly: 45, features: ['Unlimited downloads'] },
      team: { id: 'team', name: 'Team', monthly: 15, yearly: 135, seats: 5, features: ['5 seats'] },
    } } }));
  await page.route('**/api/reviews**', (r) =>
    r.fulfill({ json: { ok: true, data: { reviews: [], total: 0, average: 0, breakdown: {} } } }));
}

test('home renders and shows only real statistics', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');

  await expect(page).toHaveTitle(/Nexa Download Manager/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // The figures the old build invented must not be present anywhere.
  const body = await page.locator('body').innerText();
  for (const fake of ['50K+', '10x faster', '99.9%', 'v2.1']) {
    expect(body).not.toContain(fake);
  }
  await expect(page.getByText('42')).toBeVisible();
});

test('the primary navigation reaches every public page', async ({ page }) => {
  await stubApi(page);
  const routes = [
    ['/download', /Download/],
    ['/pricing', /Pricing/],
    ['/compare', /Compare|vs/i],
    ['/faq', /FAQ|Questions/i],
    ['/docs', /Docs|Guides/i],
    ['/about', /About/],
    ['/terms', /Terms/],
    ['/privacy', /Privacy/],
    ['/changelog', /Changelog/],
    ['/contact', /Contact/],
  ];
  for (const [path, titlePattern] of routes) {
    await page.goto(path);
    await expect(page, `${path} should render`).toHaveTitle(titlePattern);
    // A blank page or an error boundary means the route is broken.
    await expect(page.locator('body')).not.toHaveText(/Something went wrong/i);
    expect((await page.locator('body').innerText()).length).toBeGreaterThan(80);
  }
});

test('download page points at the counting redirect and shows checksums', async ({ page }) => {
  await stubApi(page);
  await page.goto('/download');

  await expect(page.getByText(/0\.2\.0/).first()).toBeVisible();
  const hrefs = await page.locator('a[href*="releases/download"]').evaluateAll(
    (nodes) => nodes.map((n) => n.getAttribute('href'))
  );
  expect(hrefs.some((h) => h.includes('/releases/download/windows'))).toBeTruthy();
  expect(hrefs.some((h) => h.includes('/releases/download/linux'))).toBeTruthy();
  await expect(page.getByText(/SHA-256/i).first()).toBeVisible();
});

test('an unpublished release says so instead of showing a stale version', async ({ page }) => {
  await stubApi(page, { release: null });
  await page.goto('/download');

  await expect(page.getByText(/not published yet/i).first()).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('v0.1.0');
});

test('a protected route sends a signed-out visitor to sign in', async ({ page }) => {
  await stubApi(page);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login/);
});

test('404 renders for an unknown path', async ({ page }) => {
  await stubApi(page);
  await page.goto('/definitely-not-a-page');
  await expect(page.locator('body')).toContainText(/404|not found/i);
});

test('legal pages are reachable from the footer', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  // These were dead links to /pricing in the previous build.
  const terms = page.locator('footer a[href="/terms"]');
  const privacy = page.locator('footer a[href="/privacy"]');
  await expect(terms).toHaveCount(1);
  await expect(privacy).toHaveCount(1);
  await terms.click();
  await expect(page).toHaveURL(/\/terms$/);
});

test('prerendered shells carry per-route metadata for social cards', async ({ request }) => {
  // Fetched as raw HTML (no JS), which is exactly what a social crawler sees.
  const res = await request.get('/pricing/');
  expect(res.ok()).toBeTruthy();
  const html = await res.text();
  expect(html).toContain('<title>Pricing · Nexa Download Manager</title>');
  expect(html).toMatch(/og:url"\s*\n?\s*content="[^"]*\/pricing"/);
});

test('signing in honours ?next= (a team invitation lands on the join page, not the dashboard)', async ({ page }) => {
  await stubApi(page);
  // Signed-out session endpoints stay 401 until login succeeds.
  let signedIn = false;
  await page.route('**/api/auth/login', (r) => {
    signedIn = true;
    r.fulfill({ json: { ok: true, data: { token: 'tok', user: { id: '1', name: 'Ada', email: 'ada@example.test', role: 'user' } } } });
  });
  await page.route('**/api/user/me', (r) => (signedIn
    ? r.fulfill({ json: { ok: true, data: { user: { id: 1, name: 'Ada', email: 'ada@example.test', role: 'user' }, subscription: { plan: 'free', status: 'active', seats: 1 }, team: null } } })
    : r.fulfill({ status: 401, json: { ok: false, error: { code: 'UNAUTHORIZED', message: 'no session' } } })));
  await page.route('**/api/team/invites/**', (r) =>
    r.fulfill({ json: { ok: true, data: { ownerName: 'Grace', email: 'ada@example.test', plan: 'team' } } }));

  const next = '/team/join?token=' + 'A'.repeat(43);
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.fill('input[name="email"]', 'ada@example.test');
  await page.fill('input[name="password"]', 'password-123');
  await page.click('button[type="submit"]');

  // The old build bounced every login to /dashboard the instant the session
  // appeared, so ?next= never worked.
  await expect(page).toHaveURL(/\/team\/join\?token=/);
  await expect(page.getByRole('button', { name: /accept invitation/i })).toBeVisible();
});

test('a two-factor account gets the code step, and the profile shows 2FA and sessions', async ({ page }) => {
  await stubApi(page);
  const me = { user: { id: 1, name: 'Ada', email: 'ada@example.test', role: 'user', hasPassword: true }, subscription: { plan: 'free', status: 'active', seats: 1 }, team: null };
  let signedIn = false;
  // The password checks out but the account has TOTP on: no session yet,
  // only a challenge that POST /auth/login/2fa turns into one.
  await page.route('**/api/auth/login', (r) =>
    r.fulfill({ json: { ok: true, data: { requiresTwoFactor: true, challenge: 'c'.repeat(40) } } }));
  await page.route('**/api/auth/login/2fa', (r) => {
    const body = r.request().postDataJSON();
    if (body.code !== '246810' || body.challenge !== 'c'.repeat(40))
      return r.fulfill({ status: 401, json: { ok: false, error: { code: 'INVALID_CODE', message: 'That code is not valid' } } });
    signedIn = true;
    return r.fulfill({ json: { ok: true, data: { token: 'tok', user: me.user } } });
  });
  await page.route('**/api/user/me', (r) => (signedIn
    ? r.fulfill({ json: { ok: true, data: me } })
    : r.fulfill({ status: 401, json: { ok: false, error: { code: 'UNAUTHORIZED', message: 'no session' } } })));
  await page.route('**/api/auth/2fa', (r) =>
    r.fulfill({ json: { ok: true, data: { enabled: true, pending: false, recoveryCodesLeft: 7 } } }));
  await page.route('**/api/user/sessions', (r) =>
    r.fulfill({ json: { ok: true, data: { sessions: [
      { id: 1, current: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/128.0 Safari/537.36', ip: '203.0.113.5', lastUsedAt: new Date().toISOString() },
      { id: 2, current: false, userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/128.0 Mobile Safari/537.36', ip: '198.51.100.7', lastUsedAt: new Date().toISOString() },
    ] } } }));

  await page.goto('/login?next=%2Fprofile');
  await page.fill('input[name="email"]', 'ada@example.test');
  await page.fill('input[name="password"]', 'password-123');
  await page.click('button[type="submit"]');

  await expect(page.getByRole('heading', { name: /enter your verification code/i })).toBeVisible();
  await page.fill('input[name="code"]', '111111');
  await page.click('button[type="submit"]');
  await expect(page.getByRole('alert')).toContainText(/not valid/i);
  await page.fill('input[name="code"]', '246810');
  await page.click('button[type="submit"]');

  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByTestId('two-factor-status')).toHaveText('On');
  await expect(page.getByText(/7 recovery codes left/i)).toBeVisible();
  const rows = page.getByTestId('session-list').getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('This browser');
  await expect(rows.nth(1)).toContainText('Chrome on Android');
});

test('an invalid team invitation says so instead of a blank page', async ({ page }) => {
  await stubApi(page);
  await page.route('**/api/team/invites/**', (r) =>
    r.fulfill({ status: 404, json: { ok: false, error: { code: 'INVITE_NOT_FOUND', message: 'This invitation is no longer valid' } } }));
  await page.goto('/team/join?token=' + 'B'.repeat(43));
  await expect(page.getByText(/invitation not found/i)).toBeVisible();
  await expect(page.getByText(/no longer valid/i)).toBeVisible();
});

test('sign-in and sign-up drop the footer; every other page keeps it', async ({ page }) => {
  await stubApi(page);

  // The auth shell (AuthLayout) keeps the navbar — the logo, nav and theme
  // toggle stay reachable — but renders no footer.
  for (const path of ['/login', '/register']) {
    await page.goto(path);
    await expect(page.locator('header')).toHaveCount(1);
    await expect(page.locator('footer'), `${path} must not render a footer`).toHaveCount(0);
    // The form must be visible without hunting for it.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }

  // Everything else still uses the ordinary shell, 404 included.
  for (const path of ['/', '/pricing', '/forgot-password', '/definitely-not-a-page']) {
    await page.goto(path);
    await expect(page.locator('footer'), `${path} must keep its footer`).toHaveCount(1);
  }
});
