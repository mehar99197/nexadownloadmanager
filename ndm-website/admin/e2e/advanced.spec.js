import { test, expect } from '@playwright/test';

/**
 * The panel's half of the advanced pass.
 *
 * Both of these cover a failure that is invisible unless it is measured. A
 * view transition that names two elements the same throws and silently aborts,
 * leaving the swap looking exactly as it did before. And a loading state that
 * is the wrong shape does not look wrong at all — it looks fine, and then the
 * data lands and the button somebody was reaching for is somewhere else.
 */

const ADMIN = {
  id: 1, name: 'Staff', email: 'staff@example.test', role: 'admin',
  twoFactorRequired: false, twoFactorEnabled: true,
};

const ok = (data) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });

// Twelve, because Users.jsx asks for twelve. The point of the test below is
// that the table learns that number rather than being told it.
const USERS = {
  users: Array.from({ length: 12 }, (_, i) => ({
    id: i + 1, name: `Customer ${i + 1}`, email: `customer${i + 1}@example.test`,
    role: 'user', banned: false, emailVerified: true,
    createdAt: '2026-01-01T00:00:00.000Z', subscription: { plan: 'pro', status: 'active' },
  })),
  totalCount: 40, page: 1, limit: 12,
};

/** Session plus whatever the screen asks for; `delayUsers` holds /users back. */
async function stubApi(page, { delayUsers = 0 } = {}) {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/refresh')) return route.fulfill(ok({ token: 'test-token' }));
    if (url.includes('/me')) return route.fulfill(ok(ADMIN));
    if (url.includes('/users')) {
      if (delayUsers) await new Promise((r) => setTimeout(r, delayUsers));
      return route.fulfill(ok(USERS));
    }
    if (url.includes('/stats') || url.includes('/dashboard')) {
      return route.fulfill(ok({ users: 20, activeSubscriptions: 4, downloads: 91, revenue: 0, signups: [] }));
    }
    return route.fulfill(ok({}));
  });
}

test('a screen change runs a view transition, and names nothing twice', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.addInitScript(() => {
    window.__vtCalls = 0;
    const original = document.startViewTransition;
    window.__vtSupported = typeof original === 'function';
    if (original) {
      document.startViewTransition = function patched(...args) {
        window.__vtCalls += 1;
        return original.apply(this, args);
      };
    }
  });

  await stubApi(page);
  await page.goto('dashboard', { waitUntil: 'load' });
  await page.waitForTimeout(700);

  // exact: the dashboard also carries a "Manage users" link to the same place.
  await page.getByRole('link', { name: 'Users', exact: true }).click();
  await expect(page).toHaveURL(/\/users$/);
  await page.waitForTimeout(600);

  const { calls, supported } = await page.evaluate(() => ({
    calls: window.__vtCalls,
    supported: window.__vtSupported,
  }));

  expect(supported, 'the test browser should have view transitions').toBe(true);
  expect(calls, 'moving between screens should run a view transition').toBeGreaterThan(0);

  const vtErrors = errors.filter((e) => /view-transition|ViewTransition/i.test(e));
  expect(vtErrors, `view transition errors:\n${vtErrors.join('\n')}`).toEqual([]);
});

test('moving between screens from a scrolled list does not jolt, and Back returns to it', async ({ page }) => {
  // Short enough that twelve rows scroll.
  await page.setViewportSize({ width: 1280, height: 520 });
  await stubApi(page);
  await page.goto('users', { waitUntil: 'load' });
  await expect(page.getByText('customer12@example.test')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => window.scrollTo({ top: 300, behavior: 'instant' }));
  await page.waitForTimeout(200);

  const record = () =>
    page.evaluate(() => {
      const frames = [];
      window.__frames = frames;
      const t0 = performance.now();
      const tick = () => {
        const h = document.querySelector('main h1, main h2');
        frames.push({ scrollY: Math.round(window.scrollY), heading: h ? h.textContent.trim() : null });
        if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

  // Activated the way a keyboard would, without Playwright scrolling the page
  // up to reach it first — the sidebar is not sticky, so a real pointer has to
  // scroll too, but that is the reader's scroll, not the app's.
  await record();
  await page.evaluate(() =>
    [...document.querySelectorAll('a.nav-link')].find((a) => a.textContent.trim().endsWith('Dashboard')).click()
  );
  await page.waitForTimeout(1600);
  const away = await page.evaluate(() => window.__frames);

  // Recorded before the fix: the URL changed, the USERS list leapt from its
  // scroll position to the top, and the next screen arrived ~300ms later.
  const leaving = away.filter((f) => f.heading === 'Users');
  expect(leaving.every((f) => f.scrollY === 300), 'the list moved before it was replaced').toBe(true);
  expect(away[away.length - 1].heading).not.toBe('Users');
  expect(away[away.length - 1].scrollY, 'the next screen should open at its top').toBe(0);

  await page.goBack();
  await expect(page).toHaveURL(/\/users$/);
  await page.waitForTimeout(600);
  expect(
    await page.evaluate(() => Math.round(window.scrollY)),
    'Back should return to where the list was'
  ).toBe(300);
});

test('the table holds its height once it knows how many rows to expect', async ({ page }) => {
  await stubApi(page, { delayUsers: 1200 });
  await page.goto('users', { waitUntil: 'commit' });

  const measure = () =>
    page.evaluate(() => {
      const t = document.querySelector('table.admin-table');
      return {
        busy: !!document.querySelector('[role="region"][aria-busy="true"]'),
        rows: t ? t.tBodies[0].rows.length : 0,
        height: t ? Math.round(t.getBoundingClientRect().height) : 0,
      };
    });

  await expect(page.locator('table.admin-table')).toBeVisible({ timeout: 15_000 });

  // First load: the table has never seen a row, so it draws a screenful. What
  // matters here is that it is a table at all — this used to be the single
  // line "Loading…", and the arriving rows moved everything under it.
  const first = await measure();
  expect(first.busy, 'the table region should say it is busy').toBe(true);
  expect(first.rows, 'the loading state should be rows, not one centred word').toBeGreaterThan(3);

  await expect(page.getByText('customer1@example.test')).toBeVisible({ timeout: 15_000 });
  const settled = await measure();
  expect(settled.rows).toBe(12);

  // Second load: it now knows the page size, so the stand-in is the same shape
  // as what is coming back and the table does not move at all.
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.waitForTimeout(250);
  const refetching = await measure();

  expect(refetching.busy, 'a refetch should also mark the region busy').toBe(true);
  expect(refetching.rows, 'the stand-in should match the page size it learned').toBe(settled.rows);

  const moved = Math.abs(refetching.height - settled.height);
  expect(
    moved,
    `the table moved ${moved}px on a refetch (settled ${settled.height}px, loading ${refetching.height}px)`
  ).toBeLessThanOrEqual(8);
});
