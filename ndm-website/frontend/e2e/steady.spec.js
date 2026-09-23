import { test, expect } from '@playwright/test';

/**
 * Reloads and page changes that do not jolt.
 *
 * Reported as "it jerks on reload and when moving between pages, and the boot
 * loader no longer shows". Recorded frame by frame on the live site, a single
 * click from a scrolled page to one not yet visited produced: a BLANK frame
 * with the Suspense spinner, the scroll clamping from 700 to 0, the scrollbar
 * vanishing (everything centred jumped 5px sideways) and coming back. A
 * reload lifted the boot screen onto the shell before the page had arrived.
 *
 * Every check here reads the page once per animation frame, because every one
 * of those faults lasts a frame or three and is invisible to a test that only
 * looks at the end state.
 *
 * Real scrollbars. Playwright's headless Chrome is launched with
 * --hide-scrollbars, which hides exactly the sideways shift being tested for;
 * launchOptions is worker-scoped, so this file gets its own worker and the
 * rest of the suite keeps the default.
 */
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

const DESKTOP = { width: 1366, height: 768 };

/** Starts sampling the page once per frame into window.__frames. */
const RECORD = () => {
  const frames = [];
  window.__frames = frames;
  const t0 = performance.now();
  const tick = () => {
    const h1 = document.querySelector('main h1');
    const boot = document.getElementById('ndm-boot');
    const header = document.querySelector('header');
    frames.push({
      t: performance.now() - t0,
      path: window.location.pathname,
      // The header's box, not documentElement.clientWidth: with the gutter
      // reserved, the root still reports the full viewport while overflow is
      // hidden, although nothing on the page has moved.
      width: header ? Math.round(header.getBoundingClientRect().width) : 0,
      scrollY: Math.round(window.scrollY),
      boot: boot ? Number(getComputedStyle(boot).opacity) : 0,
      heading: h1 ? h1.textContent.trim() : null,
      headingY: h1 ? Math.round(h1.getBoundingClientRect().top + window.scrollY) : null,
      spinner: !!document.querySelector('main [role="status"][aria-label="Loading"]'),
    });
    if (performance.now() - t0 < 2600) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const frames = (page) => page.evaluate(() => window.__frames);

/** The frames a reader could actually see — the boot screen is not covering them. */
const visible = (all) => all.filter((f) => f.boot < 0.05);

async function settle(page) {
  await page
    .waitForFunction(() => !document.documentElement.classList.contains('ndm-booting'), null, { timeout: 15_000 })
    .catch(() => {});
  await page.waitForTimeout(300);
}

function expectSteady(all, label) {
  const shown = visible(all);
  const widths = [...new Set(all.filter((f) => f.width > 0).map((f) => f.width))];
  expect(widths, `${label}: the page changed width (scrollbar appeared or vanished)`).toHaveLength(1);
  expect(shown.filter((f) => f.heading === null), `${label}: a blank frame was on screen`).toEqual([]);
  expect(shown.filter((f) => f.spinner), `${label}: the loading spinner was on screen`).toEqual([]);

  // Once the final page is showing, nothing on it may move.
  const last = all[all.length - 1];
  const settled = all.filter((f) => f.path === last.path && f.heading === last.heading);
  const ys = [...new Set(settled.map((f) => f.headingY))];
  expect(ys, `${label}: the heading moved after the page appeared`).toHaveLength(1);
}

test('the boot screen shows on every full load and lifts only onto a finished page', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/faq', { waitUntil: 'load' });
  await settle(page);

  // A reload is the case that was losing it: warm cache, bundle instantly ready.
  for (const label of ['reload 1', 'reload 2']) {
    await page.addInitScript(RECORD);
    await page.reload({ waitUntil: 'commit' });
    await page.waitForTimeout(2700);
    const all = await frames(page);

    const firstSeen = all.find((f) => f.boot > 0);
    expect(firstSeen && firstSeen.boot, `${label}: the boot screen should be fully on screen from the start`).toBeGreaterThan(0.95);
    // The 700ms floor, less a frame of slack either side.
    const lastFull = [...all].reverse().find((f) => f.boot > 0.95);
    expect(lastFull.t, `${label}: the boot screen should hold for its minimum`).toBeGreaterThan(600);
    // And when it starts to lift, there is a page under it.
    const lifting = all.find((f) => f.boot > 0 && f.boot < 0.95);
    expect(lifting && lifting.heading, `${label}: the boot screen lifted before the page was there`).toBeTruthy();

    expectSteady(all, label);
  }
});

test('moving between pages from a scrolled position does not jolt @desktop', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/faq', { waitUntil: 'load' });
  await settle(page);
  await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' }));
  await page.waitForTimeout(200);

  // Docs has never been visited in this context, so its code has to download
  // first — the case that used to produce the blank frame.
  await page.evaluate(RECORD);
  await page.locator('header').getByRole('link', { name: 'Docs', exact: true }).first().click();
  await page.waitForTimeout(2700);
  const all = await frames(page);

  expectSteady(all, 'faq -> docs');
  const last = all[all.length - 1];
  expect(last.path).toBe('/docs');
  expect(last.scrollY, 'a new page should open at its top').toBe(0);

  // The old page must not jump before the new one replaces it.
  const beforeSwap = all.filter((f) => f.heading && f.heading.startsWith('Straight'));
  expect(beforeSwap.every((f) => f.scrollY === 900), 'the page being left moved before it was replaced').toBe(true);
});

test('Back returns to where the reader was, and a reload keeps the place', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/faq', { waitUntil: 'load' });
  await settle(page);
  await page.evaluate(() => window.scrollTo({ top: 1100, behavior: 'instant' }));
  await page.waitForTimeout(200);

  await page.locator('header').getByRole('link', { name: 'Features', exact: true }).first().click();
  await expect(page).toHaveURL(/\/features$/);
  await page.waitForTimeout(700);

  await page.evaluate(RECORD);
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForTimeout(2700);
  const back = await frames(page);
  expectSteady(back, 'back to faq');
  expect(back[back.length - 1].scrollY, 'Back should return to the same place').toBe(1100);

  await page.reload({ waitUntil: 'load' });
  await settle(page);
  expect(await page.evaluate(() => Math.round(window.scrollY)), 'a reload should keep the place').toBe(1100);
});

test('the phone menu hands over to the next page without a jolt @390', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/faq', { waitUntil: 'load' });
  await settle(page);
  await page.evaluate(() => window.scrollTo({ top: 700, behavior: 'instant' }));
  await page.waitForTimeout(200);

  await page.getByRole('button', { name: 'Toggle menu' }).click();
  await page.evaluate(RECORD);
  await page.locator('.mobile-menu').getByRole('link', { name: /docs/i }).first().click();
  await page.waitForTimeout(2700);
  const all = await frames(page);

  expectSteady(all, 'phone faq -> docs');
  expect(all[all.length - 1].path).toBe('/docs');
  expect(all[all.length - 1].scrollY).toBe(0);
});
