import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The control panel on a phone, and to WCAG.
 *
 * This surface had no automated checks of any kind until T-06 added component
 * tests, and none of those can see layout — jsdom has no box model, so tap
 * targets and contrast were still unmeasured. The panel is the screen staff
 * actually work in, often from a phone when something is wrong at an awkward
 * hour, which is the worst time to be hunting for a 20px button.
 *
 * Every screen but sign-in needs a session, so the API is stubbed. That is the
 * point: what is being checked is the rendering, not the server.
 */

const PHONE = { width: 390, height: 844 };

const ADMIN = {
  id: 1, name: 'Staff', email: 'staff@example.test', role: 'admin',
  twoFactorRequired: false, twoFactorEnabled: true,
};

const ok = (data) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });

/** Enough of the API for every panel screen to render with content in it. */
async function stubApi(page) {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const has = (s) => url.includes(s);

    if (has('/refresh')) return route.fulfill(ok({ token: 'test-token' }));
    if (has('/me')) return route.fulfill(ok(ADMIN));
    if (has('/stats') || has('/dashboard')) {
      return route.fulfill(ok({
        users: 128, activeSubscriptions: 17, downloads: 5321, revenue: 0,
        signups: [{ date: '2026-09-20', count: 4 }, { date: '2026-09-21', count: 7 }],
      }));
    }
    if (has('/users')) {
      return route.fulfill(ok({
        users: Array.from({ length: 8 }, (_, i) => ({
          id: i + 1, name: `Customer ${i + 1}`, email: `customer${i + 1}@example.test`,
          role: 'user', banned: false, emailVerified: true,
          createdAt: '2026-01-01T00:00:00.000Z', subscription: { plan: i % 3 ? 'free' : 'pro', status: 'active' },
        })),
        totalCount: 8, page: 1, limit: 20,
      }));
    }
    if (has('/subscriptions')) {
      return route.fulfill(ok({
        subscriptions: Array.from({ length: 5 }, (_, i) => ({
          id: i + 1, userId: i + 1, userEmail: `customer${i + 1}@example.test`,
          plan: 'pro', status: 'active', seats: 1,
          startDate: '2026-01-01T00:00:00.000Z', expiryDate: '2027-01-01T00:00:00.000Z',
        })),
        totalCount: 5, page: 1, limit: 20,
      }));
    }
    if (has('/reviews')) {
      return route.fulfill(ok({
        reviews: Array.from({ length: 4 }, (_, i) => ({
          id: i + 1, userName: `Customer ${i + 1}`, rating: 5 - (i % 3),
          comment: 'It works well and the queue is genuinely fast.', status: 'pending',
          createdAt: '2026-09-01T00:00:00.000Z',
        })),
        totalCount: 4, page: 1, limit: 20,
      }));
    }
    if (has('/ads')) {
      return route.fulfill(ok({
        ads: [{ id: 1, title: 'Nexa Pro', body: 'Go faster', targetUrl: 'https://example.test',
          ctaLabel: 'Learn more', placement: 'app_banner', active: true, weight: 1,
          impressions: 120, clicks: 8 }],
        totalCount: 1,
      }));
    }
    if (has('/releases')) {
      return route.fulfill(ok({
        releases: [{ id: 1, version: '0.2.0', changelog: 'First public build.', isLatest: true,
          publishedAt: '2026-09-01T00:00:00.000Z', downloadCount: 42,
          hasWindows: true, hasLinux: true }],
        totalCount: 1,
      }));
    }
    if (has('/contact')) {
      return route.fulfill(ok({
        messages: [{ id: 1, name: 'A Person', email: 'person@example.test', topic: 'bug',
          message: 'The extension button does not appear on that site.',
          status: 'new', createdAt: '2026-09-20T00:00:00.000Z', replies: [] }],
        totalCount: 1, stats: { new: 1, open: 0, replied: 0, closed: 0 },
      }));
    }
    if (has('/activity') || has('/audit')) {
      return route.fulfill(ok([
        { id: 1, action: 'admin.login', actorEmail: 'staff@example.test', targetType: 'session',
          detail: 'Signed in', createdAt: '2026-09-23T00:00:00.000Z' },
      ]));
    }
    if (has('/2fa')) return route.fulfill(ok({ enabled: true, pending: false, recoveryCodesLeft: 8, recoveryCodesLegacy: false }));
    if (has('/security') || has('/token-rejections')) return route.fulfill(ok({ rejections: [], events: [] }));
    return route.fulfill(ok({}));
  });
}

const SCREENS = [
  ['', 'sign-in / dashboard'],
  ['users', 'users'],
  ['subscriptions', 'subscriptions'],
  ['reviews', 'reviews'],
  ['ads', 'ads'],
  ['releases', 'releases'],
  ['contact', 'contact'],
  ['activity', 'activity'],
  ['security', 'security'],
];

for (const scheme of ['dark', 'light']) {
  test(`panel has no accessibility violations — ${scheme} @390`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize(PHONE);
    await stubApi(page);

    const found = [];
    for (const [path, label] of SCREENS) {
      await page.goto(path, { waitUntil: 'load' });
      await page.waitForTimeout(600);
      const res = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      for (const v of res.violations) {
        found.push(`${label}: [${v.impact}] ${v.id} — ${v.help} (${v.nodes.length}x, e.g. ${String(v.nodes[0]?.target[0]).slice(0, 60)} :: ${String(v.nodes[0]?.html).replace(/\s+/g, ' ').slice(0, 80)})`);
      }
    }
    expect(found, `axe violations in the panel (${scheme}):\n${found.join('\n')}`).toEqual([]);
  });
}

test('panel tap targets meet their bar @390', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize(PHONE);
  await stubApi(page);

  const small = [];
  for (const [path, label] of SCREENS) {
    await page.goto(path, { waitUntil: 'load' });
    await page.waitForTimeout(600);
    const offenders = await page.evaluate(() => {
      const SEL = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"]';

      /**
       * Does a tap at (x, y) reach this control?
       *
       * The box is not the answer. A 28px chip with a transparent pseudo-
       * element reaching past it, or a 16px checkbox inside a 44px <label>,
       * is genuinely tappable across the full area while
       * getBoundingClientRect still reports the small number. Measuring the
       * box alone reported both as failures and would have pushed the fix
       * towards inflating a dense table instead.
       */
      const reaches = (el, x, y) => {
        const hit = document.elementFromPoint(x, y);
        if (!hit) return false;
        if (hit === el || el.contains(hit) || hit.contains(el)) return true;
        // A <label> activates the control it wraps or points at.
        const lab = hit.closest('label');
        if (lab && (lab.contains(el) || lab.control === el)) return true;
        return false;
      };

      const out = [];
      for (const el of document.querySelectorAll(SEL)) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        // elementFromPoint answers null for anything outside the viewport, so
        // a control below the fold would "fail" for being off screen. Bring
        // each one into view before probing it.
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // Still off screen after that means it is parked off-canvas — the
        // sidebar's contents while the mobile drawer is shut. Nothing can tap
        // it there, and that is not a target-size defect. (Whether the drawer
        // opens is a different test's job: guards.test.jsx.)
        if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
        if (el.tagName === 'A') {
          const p = el.parentElement;
          const own = p ? (p.textContent || '').replace(el.textContent || '', '').trim() : '';
          if (own.length > 2) continue;
        }
        // 24px is WCAG 2.2 AA (2.5.8); 44px is AAA/HIG and the right bar for a
        // control. See the site's own e2e/a11y.spec.js for the reasoning.
        const isControl = el.tagName !== 'A' || el.classList.contains('btn');
        const min = isControl ? 44 : 24;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const half = min / 2 - 1;
        const covered =
          reaches(el, cx, cy) &&
          reaches(el, cx, cy - half) && reaches(el, cx, cy + half) &&
          reaches(el, cx - half, cy) && reaches(el, cx + half, cy);
        if (!covered) {
          out.push(`${Math.round(r.width)}x${Math.round(r.height)} (needs ${min} of reachable area) <${el.tagName.toLowerCase()}> "${(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`);
        }
      }
      return out;
    });
    for (const o of new Set(offenders)) small.push(`${label}: ${o}`);
  }
  expect(small, `panel tap targets below their bar:\n${small.join('\n')}`).toEqual([]);
});

test('no screen scrolls sideways @390', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize(PHONE);
  await stubApi(page);

  const over = [];
  for (const [path, label] of SCREENS) {
    await page.goto(path, { waitUntil: 'load' });
    await page.waitForTimeout(600);
    const r = await page.evaluate(() => {
      const de = document.documentElement;
      const amount = de.scrollWidth - de.clientWidth;
      if (amount <= 0) return null;
      // Name the widest thing, so the failure points somewhere.
      let worst = null;
      for (const el of document.querySelectorAll('body *')) {
        const b = el.getBoundingClientRect();
        if (b.right > de.clientWidth + 1 && (!worst || b.right > worst.right)) {
          worst = { right: Math.round(b.right), tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 50) };
        }
      }
      return { amount, worst };
    });
    if (r) over.push(`${label}: ${r.amount}px too wide — widest: <${r.worst?.tag}> ${r.worst?.cls}`);
  }
  expect(over, `horizontal overflow:\n${over.join('\n')}`).toEqual([]);
});
