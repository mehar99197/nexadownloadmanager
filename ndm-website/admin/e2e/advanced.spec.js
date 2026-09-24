import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

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

// The dashboard's two reads, in the shape the API really answers — every
// section of the screen has something to draw.
const STATS = {
  totalUsers: 20, activeSubscriptions: 4, mrr: 20, pendingReviews: 1,
  newSignups: Array.from({ length: 14 }, (_, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, '0')}`, count: ((i * 7) % 5) + 1,
  })),
  revenueSeries: ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((month, i) => ({ month, revenue: 10 + i * 5 })),
  planDistribution: [{ plan: 'free', count: 16 }, { plan: 'pro', count: 3 }, { plan: 'team', count: 1 }],
  recentActivity: [{ id: 1, summary: 'Published v1.2.0', admin_name: 'Staff', created_at: '2026-09-20T10:00:00.000Z' }],
  recentPayments: [],
  contact: { awaiting: 2, unread: 1 },
};
const HEALTH = { database: 'ok', stripe: 'live', email: 'smtp', latencyMs: 12, uptimeSeconds: 3600 };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Session plus whatever the screen asks for. `delayRefresh`, `delayUsers` and
 * `delayStats` hold those answers back.
 */
async function stubApi(page, { delayUsers = 0, delayStats = 0, delayRefresh = 0 } = {}) {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/refresh')) {
      if (delayRefresh) await wait(delayRefresh);
      return route.fulfill(ok({ token: 'test-token' }));
    }
    if (url.includes('/me')) return route.fulfill(ok(ADMIN));
    if (url.includes('/users')) {
      if (delayUsers) await wait(delayUsers);
      return route.fulfill(ok(USERS));
    }
    if (url.includes('/stats') || url.includes('/dashboard')) {
      if (delayStats) await wait(delayStats);
      return route.fulfill(ok(STATS));
    }
    if (url.includes('/health')) return route.fulfill(ok(HEALTH));
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

  // Activated the way a keyboard would, so the only thing that moves the page
  // is the app. (The sidebar is sticky on a desktop now, so a pointer can
  // reach it from anywhere in the list, too.)
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

/*
 * The owner's second report on the panel: "a screen still appears all at
 * once, with only 'Loading' written on it". Opening the panel showed the word
 * "Loading…" alone on an empty screen and then cut to everything; a screen
 * change was a 160ms dissolve (none at all under reduced motion); and the
 * dashboard said "-", "checking", "No data" and "No payments yet" until its
 * numbers arrived, then swapped them in.
 */

test('opening the panel draws it in outline, and its numbers arrive without moving it', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await stubApi(page, { delayRefresh: 700, delayStats: 1500 });
  await page.addInitScript(() => {
    const frames = [];
    window.__frames = frames;
    const t0 = performance.now();
    const tick = () => {
      const heading = [...document.querySelectorAll('main h2')].find((h) => h.textContent.includes('Command center'));
      frames.push({
        t: performance.now() - t0,
        heading: Boolean(heading),
        headingY: heading ? Math.round(heading.getBoundingClientRect().top + window.scrollY) : null,
        // The first four cards under the stats: health, both charts, plan mix.
        sections: [...document.querySelectorAll('main section.admin-card')]
          .slice(0, 4)
          .map((s) => Math.round(s.getBoundingClientRect().top + window.scrollY))
          .join(','),
        outlines: document.querySelectorAll('main .skeleton').length,
      });
      if (performance.now() - t0 < 3600) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.goto('dashboard', { waitUntil: 'commit' });
  await page.waitForTimeout(400);
  // The session is still being checked: the panel in outline, not a word.
  await expect(page.getByRole('status', { name: /loading the control panel/i })).toBeAttached();
  await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);

  await page.waitForTimeout(3400);
  const all = await page.evaluate(() => window.__frames);

  const waiting = all.filter((f) => f.heading && f.outlines > 5);
  expect(waiting.length, 'the dashboard should be outlines while its numbers load').toBeGreaterThan(10);
  // Past the screen's own settle, nothing on it may move — through the
  // numbers arriving and after.
  const after = all.filter((f) => f.heading && f.t > waiting[0].t + 600);
  expect(after.some((f) => f.outlines === 0), 'the numbers should have replaced their outlines').toBe(true);
  expect([...new Set(after.map((f) => f.sections))], 'the dashboard moved when its numbers arrived').toHaveLength(1);
  expect([...new Set(after.map((f) => f.headingY))]).toHaveLength(1);
  await expect(page.getByText('No data')).toHaveCount(0);
});

test('a screen change is a dissolve you can see, and reduced motion keeps it without the settle', async ({ page }) => {
  await page.addInitScript(() => {
    window.__dissolves = [];
    window.__settles = [];
    document.addEventListener('animationstart', (event) => {
      if (event.target.classList && event.target.classList.contains('screen-enter')) window.__settles.push(event.animationName);
    });
    const original = document.startViewTransition;
    if (!original) return;
    document.startViewTransition = function patched(...args) {
      const vt = original.apply(this, args);
      vt.ready.then(
        () => {
          window.__dissolves.push(
            document
              .getAnimations()
              .filter((a) => String(a.effect?.pseudoElement || '').includes('view-transition'))
              .map((a) => ({ pseudo: a.effect.pseudoElement, duration: a.effect.getComputedTiming().duration }))
          );
        },
        () => {}
      );
      return vt;
    };
  });
  await stubApi(page);
  await page.goto('dashboard', { waitUntil: 'load' });
  await expect(page.getByRole('heading', { name: 'Command center' })).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(600);

  const change = async (name, path) => {
    await page.evaluate(() => {
      window.__dissolves.length = 0;
      window.__settles.length = 0;
    });
    await page.getByRole('link', { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await page.waitForTimeout(700);
    return page.evaluate(() => ({ dissolves: window.__dissolves, settles: window.__settles }));
  };
  const rootFade = (dissolves) => dissolves.flat().find((a) => a.pseudo === '::view-transition-new(root)');

  const full = await change('Users', '/users');
  expect(rootFade(full.dissolves)?.duration, 'the screen should dissolve over 300ms').toBe(300);
  expect(full.settles, 'the arriving screen should settle into place').toContain('admin-screen-settle');

  // It used to skip the transition here entirely — a cut.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await change('Releases', '/releases');
  expect(rootFade(reduced.dissolves)?.duration, 'reduced motion should still dissolve, briefly').toBe(180);
  expect(reduced.settles, 'reduced motion should not move the screen').not.toContain('admin-screen-settle');
});

/**
 * The sidebar folds to a rail of icons on a desktop — the ☰ in the topbar —
 * and opens the way it was left. Asked for after the sidebar went sticky: it
 * was always open.
 *
 * What jsdom cannot see is what matters here: that the rail is the width it
 * claims and the screen gets the room back, that nothing in the sidebar's
 * column moves while it folds, that each icon's name appears beside it and is
 * reachable by the pointer and the keyboard, and that the panel opens folded
 * from its outline on, instead of arriving wide and then folding.
 */

/** Where the logo, each icon and the logout mark are centred, across the sidebar. */
const iconColumn = () => {
  const aside = document.getElementById('admin-sidebar');
  const marks = [aside.querySelector('img'), ...aside.querySelectorAll('a.nav-link > span[aria-hidden="true"], button > span[aria-hidden="true"]')];
  return [...new Set(marks.map((el) => {
    const r = el.getBoundingClientRect();
    return Math.round(r.left + r.width / 2);
  }))];
};

const measureSidebar = async (page) => ({
  ...(await page.evaluate(() => ({
    aside: Math.round(document.getElementById('admin-sidebar').getBoundingClientRect().width),
    main: Math.round(document.querySelector('main').getBoundingClientRect().width),
  }))),
  column: await page.evaluate(iconColumn),
});

test('the sidebar folds to a rail of icons and back, and its icons hold still while it does', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 800 });
  await stubApi(page);
  await page.goto('users', { waitUntil: 'load' });
  await expect(page.getByText('customer12@example.test')).toBeVisible({ timeout: 15_000 });

  const open = await measureSidebar(page);
  expect(open.aside).toBe(240);
  expect(open.column, 'the logo, every icon and the logout mark should share one column').toEqual([32]);

  const toggle = page.getByRole('button', { name: 'Collapse sidebar' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  // Every frame of the fold: how wide, and where the first icon is.
  await page.evaluate(() => {
    const frames = [];
    window.__fold = frames;
    const t0 = performance.now();
    const tick = () => {
      const aside = document.getElementById('admin-sidebar');
      const icon = aside.querySelector('a.nav-link > span[aria-hidden="true"]').getBoundingClientRect();
      frames.push({
        width: Math.round(aside.getBoundingClientRect().width),
        icon: Math.round((icon.left + icon.width / 2) * 10) / 10,
      });
      if (performance.now() - t0 < 700) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(800);
  const fold = await page.evaluate(() => window.__fold);

  const folded = await measureSidebar(page);
  expect(folded.aside, 'the rail').toBe(64);
  expect(folded.main - open.main, 'the screen should get the room back').toBe(176);
  expect(folded.column).toEqual([32]);
  expect(new Set(fold.map((f) => f.width)).size, 'the fold should be animated, not a cut').toBeGreaterThan(3);
  expect([...new Set(fold.map((f) => f.icon))], 'an icon moved while the sidebar folded').toEqual([32]);

  // Folded, every link still has its name — hidden from sight, not from the
  // accessibility tree.
  for (const name of ['Dashboard', 'Users', 'Reviews', 'Contact inbox', 'Security']) {
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Logout', exact: true })).toBeVisible();
  const axe = await new AxeBuilder({ page })
    .include('#admin-sidebar')
    .include('header')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`), 'the folded sidebar should pass axe').toEqual([]);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.waitForTimeout(600);
  expect((await measureSidebar(page)).aside).toBe(240);

  // Asked for less motion, it still folds — at once.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await page.evaluate(() => getComputedStyle(document.getElementById('admin-sidebar')).transitionProperty)
  ).toBe('none');
});

test('the folded rail names each icon beside it, for a pointer and for the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 800 });
  await page.addInitScript(() => localStorage.setItem('nexa-admin-sidebar', 'rail'));
  await stubApi(page);
  await page.goto('users', { waitUntil: 'load' });
  await expect(page.getByText('customer12@example.test')).toBeVisible({ timeout: 15_000 });
  const tip = page.locator('.rail-tip');

  await page.getByRole('link', { name: 'Reviews', exact: true }).hover();
  await expect(tip).toHaveText('Reviews');
  const placed = await page.evaluate(() => {
    const t = document.querySelector('.rail-tip').getBoundingClientRect();
    const link = [...document.querySelectorAll('#admin-sidebar a.nav-link')]
      .find((a) => a.textContent.endsWith('Reviews'))
      .getBoundingClientRect();
    return {
      left: Math.round(t.left),
      mid: t.top + t.height / 2,
      linkMid: link.top + link.height / 2,
      rail: Math.round(document.getElementById('admin-sidebar').getBoundingClientRect().right),
      onTop: document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2)?.classList.contains('rail-tip'),
    };
  });
  expect(placed.left, 'the name should sit beside the rail, not under it').toBe(placed.rail + 8);
  expect(Math.abs(placed.mid - placed.linkMid), 'the name should be level with its icon').toBeLessThan(1);
  expect(placed.onTop, 'nothing should cover the name').toBe(true);

  // WCAG 1.4.13: the pointer can move onto the name without losing it, and
  // Escape puts it away.
  await page.mouse.move(placed.left + 12, placed.mid, { steps: 5 });
  await page.waitForTimeout(400);
  await expect(tip).toHaveText('Reviews');
  await page.keyboard.press('Escape');
  await expect(tip).toHaveCount(0);

  // The keyboard gets the same names, link by link.
  await page.mouse.move(900, 500);
  await page.getByRole('link', { name: 'Dashboard', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Users', exact: true })).toBeFocused();
  await expect(tip).toHaveText('Users');
  await page.keyboard.press('Tab');
  await expect(tip).toHaveText('Subscriptions');

  // Following a link takes the name away with it.
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/subscriptions$/);
  await expect(tip).toHaveCount(0);
});

test('the sidebar opens the way it was left, outline and all, and a phone keeps its drawer', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 800 });
  await stubApi(page, { delayRefresh: 900 });
  await page.addInitScript(() => {
    const widths = [];
    window.__asideWidths = widths;
    const t0 = performance.now();
    const tick = () => {
      const aside = document.querySelector('aside');
      if (aside) widths.push(Math.round(aside.getBoundingClientRect().width));
      if (performance.now() - t0 < 2500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto('users', { waitUntil: 'load' });
  await expect(page.getByText('customer12@example.test')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await page.waitForTimeout(400);

  // Opened again: a rail from the outline's first frame, never wide first.
  await page.reload({ waitUntil: 'commit' });
  await expect(page.getByRole('status', { name: /loading the control panel/i })).toBeAttached();
  await expect(page.getByText('customer12@example.test')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(300);
  const widths = await page.evaluate(() => window.__asideWidths);
  expect(widths.length).toBeGreaterThan(10);
  expect([...new Set(widths)], 'the sidebar should be a rail from the first frame it is drawn').toEqual([64]);
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toHaveAttribute('aria-pressed', 'true');

  // A phone has no rail: its drawer carries the labels, whatever a desktop
  // left behind.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeHidden();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.waitForTimeout(300);
  const drawer = await page.evaluate(() => {
    const aside = document.getElementById('admin-sidebar');
    const label = [...aside.querySelectorAll('a.nav-link span')].find((s) => s.textContent === 'Reviews');
    return {
      width: Math.round(aside.getBoundingClientRect().width),
      label: Math.round(label.getBoundingClientRect().width),
    };
  });
  expect(drawer.width).toBe(288);
  expect(drawer.label, 'the drawer should draw its labels').toBeGreaterThan(20);
});
