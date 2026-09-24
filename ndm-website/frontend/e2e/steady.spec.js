import { test, expect } from '@playwright/test';

/**
 * Moving between pages, and data arriving, held to what the owner asked for.
 *
 * Two reports, a day apart, and each one is a set of checks below:
 *
 *   "It jerks on reload and when moving between pages, and the boot loader
 *   no longer shows." Recorded frame by frame on the live site, one click from
 *   a scrolled page to one not yet visited produced a BLANK frame with the
 *   Suspense spinner, the scroll clamping from 700 to 0, and the scrollbar
 *   vanishing (everything centred jumped 5px sideways) and coming back.
 *
 *   "It shifts all at once, and no skeleton shows." The fix for the first had
 *   held the old page, silently, until the new one was ready, then cut to it
 *   under a 200ms dissolve — and data still arrived as a pop.
 *
 * So: never a blank frame, never a spinner, never a change of width; a page
 * that is slow shows its OUTLINE; the change of page is a dissolve long
 * enough to see, with the arriving page rising a few pixels into place; and
 * once a page is up, its heading only ever settles upward into its resting
 * place and stops — it never drops, and never jumps.
 *
 * Every check reads the page once per animation frame, because every one of
 * those faults lasts a frame or three and is invisible to a test that only
 * looks at the end state.
 *
 * Real scrollbars. Playwright's headless Chrome is launched with
 * --hide-scrollbars, which hides exactly the sideways shift being tested for;
 * launchOptions is worker-scoped, so this file gets its own worker and the
 * rest of the suite keeps the default.
 */
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

// One at a time, in one worker. These tests time frames, and seven pages
// animating at once on one machine is a test of the machine: under that load
// a frame took 60ms and a page arrived in the last frames of a recording.
// The rest of the suite still runs in parallel beside this file.
test.describe.configure({ mode: 'default' });

const DESKTOP = { width: 1366, height: 768 };

/** Starts sampling the page once per frame into window.__frames. */
const RECORD = () => {
  const frames = [];
  window.__frames = frames;
  const t0 = performance.now();
  // `frame` is the frame's own timestamp — the clock the page's animations are
  // sampled at — so the distance a heading covers is measured against the time
  // it really had, not against when this callback happened to run.
  const tick = (frame) => {
    const h1 = document.querySelector('main h1');
    const boot = document.getElementById('ndm-boot');
    const header = document.querySelector('header');
    frames.push({
      t: performance.now() - t0,
      at: frame,
      path: window.location.pathname,
      // The header's box, not documentElement.clientWidth: with the gutter
      // reserved, the root still reports the full viewport while overflow is
      // hidden, although nothing on the page has moved.
      width: header ? Math.round(header.getBoundingClientRect().width) : 0,
      scrollY: Math.round(window.scrollY),
      boot: boot ? Number(getComputedStyle(boot).opacity) : 0,
      heading: h1 ? h1.textContent.trim() : null,
      // To a tenth of a pixel: the settle is a transform, and it is sub-pixel.
      headingY: h1 ? Math.round((h1.getBoundingClientRect().top + window.scrollY) * 10) / 10 : null,
      // The outline of a whole page, while its code is on its way.
      outline: !!document.querySelector('main .route-skeleton'),
      // The outline of some data on a page that is otherwise there.
      waiting: !!document.querySelector('main .skeleton'),
      spinner: !!document.querySelector('main [role="status"][aria-label="Loading"]'),
    });
    if (performance.now() - t0 < (window.__recordMs || 2600)) requestAnimationFrame(tick);
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

/** Clicks a header link the way a keyboard would: no hover first, so nothing is fetched ahead of it. */
const pressHeaderLink = (page, name) =>
  page.evaluate((label) => {
    const link = [...document.querySelectorAll('header a')].find((a) => a.textContent.trim() === label);
    window.__tapAt = performance.now();
    link.click();
  }, name);

/** Records every frame from now on, for as long as the test takes to finish with it. */
const startRecording = async (page) => {
  await page.evaluate(() => { window.__recordMs = 15_000; });
  await page.evaluate(RECORD);
};

/**
 * Waits until the page whose heading starts with `heading` is the one on
 * screen — past any outline — and then long enough for its settle to finish,
 * so a recording covers the whole change however busy the machine is. A fixed
 * wait did not: on a loaded machine the page could arrive in the last few
 * frames of it, still rising.
 */
async function untilShown(page, heading) {
  await page.waitForFunction(
    (prefix) => {
      const h1 = document.querySelector('main h1');
      return !document.querySelector('main .route-skeleton') && h1 && h1.textContent.trim().startsWith(prefix);
    },
    heading,
    { timeout: 15_000 }
  );
  await page.waitForTimeout(900);
}

function expectSteady(all, label) {
  const shown = visible(all);
  const widths = [...new Set(all.filter((f) => f.width > 0).map((f) => f.width))];
  expect(widths, `${label}: the page changed width (scrollbar appeared or vanished)`).toHaveLength(1);
  // A page, or the outline of one — never nothing.
  expect(shown.filter((f) => f.heading === null && !f.outline), `${label}: a blank frame was on screen`).toEqual([]);
  expect(shown.filter((f) => f.spinner), `${label}: the loading spinner was on screen`).toEqual([]);
  expectSettles(all, label);
}

/**
 * Once the final page is showing, its heading may only SETTLE: rise a little
 * into its resting place (the arriving page's 14px ease-out), always upward,
 * never faster than the settle itself moves, and then stop. Dropping, or
 * jumping, is a jolt.
 *
 * Judged by speed, not by the step between two recorded frames: on a busy
 * machine a frame can take 60ms, and the settle honestly covers 9px in that
 * time — while a jump covers its distance in one ordinary frame.
 */
function expectSettles(all, label) {
  const last = all[all.length - 1];
  const shown = visible(all).filter((f) => f.path === last.path && f.heading === last.heading);
  expect(shown.length, `${label}: the final page was never on screen`).toBeGreaterThan(10);
  for (let i = 1; i < shown.length; i += 1) {
    const step = shown[i].headingY - shown[i - 1].headingY;
    const ms = Math.max(shown[i].at - shown[i - 1].at, 1);
    expect(step, `${label}: the heading dropped ${step}px between two frames`).toBeLessThanOrEqual(0.5);
    // The settle's fastest moment is ~0.13px/ms (14px, easing out over 560ms).
    expect(-step / ms, `${label}: the heading moved ${-step}px in ${Math.round(ms)}ms — a jump, not a settle`).toBeLessThanOrEqual(0.3);
  }
  const rest = shown.slice(-10).map((f) => f.headingY);
  expect(new Set(rest).size, `${label}: the heading was still moving at the end`).toBe(1);
  expect(shown[0].headingY - rest[0], `${label}: the heading rose further than the settle`).toBeLessThanOrEqual(15);
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

  await startRecording(page);
  await page.locator('header').getByRole('link', { name: 'Docs', exact: true }).first().click();
  await untilShown(page, 'Get set up');
  const all = await frames(page);

  expectSteady(all, 'faq -> docs');
  const last = all[all.length - 1];
  expect(last.path).toBe('/docs');
  expect(last.scrollY, 'a new page should open at its top').toBe(0);

  // The old page must not jump before the new one replaces it.
  const beforeSwap = all.filter((f) => f.heading && f.heading.startsWith('Straight'));
  expect(beforeSwap.every((f) => f.scrollY === 900), 'the page being left moved before it was replaced').toBe(true);
});

test('a page whose code is slow shows its outline at once, then itself', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  // Hold the Docs page's code back until 1.5s after the tap, however early it
  // was asked for — the idle prefetch, a hover, or the click itself.
  let land;
  const held = new Promise((resolve) => { land = resolve; });
  await page.route(/\/assets\/Docs-[\w-]+\.js$/, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/faq', { waitUntil: 'load' });
  await settle(page);

  await startRecording(page);
  await pressHeaderLink(page, 'Docs');
  setTimeout(land, 1500);
  await expect(page.locator('main .route-skeleton'), 'the outline of the page should follow the tap').toHaveCount(1);
  await untilShown(page, 'Get set up');
  const all = await frames(page);
  const tapAt = await page.evaluate(() => window.__tapAt);

  // Before: the old page sat there, untouched, for the whole download.
  const outline = all.filter((f) => f.outline);
  expect(outline.length, 'the outline of the page should be on screen while its code loads').toBeGreaterThan(10);
  expect(outline[0].at - tapAt, 'the outline should come long before the code (1.5s)').toBeLessThan(1000);
  expect(outline.every((f) => f.path === '/docs'), 'the outline is of the page being gone to').toBe(true);

  expectSteady(all, 'faq -> docs, slowly');
  const last = all[all.length - 1];
  expect(last.outline, 'the page should have replaced its outline').toBe(false);
  expect(last.heading).toBeTruthy();
});

test('data that is slow is drawn as its outline, and arriving moves nothing', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.route('**/api/releases/latest', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: { version: '9.8.7', hasWindowsFile: true, windowsSha256: 'a'.repeat(64) } }),
    });
  });
  // Recorded until the release is on screen and has settled, however busy
  // the machine is: the outline has to be SEEN, and then has to be gone.
  await page.addInitScript(() => { window.__recordMs = 12_000; });
  await page.addInitScript(RECORD);
  await page.goto('/download', { waitUntil: 'commit' });
  await expect(page.getByText('Latest release / v9.8.7')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(800);
  const all = await frames(page);

  const shown = visible(all);
  expect(shown.filter((f) => f.waiting).length, 'the release-dependent parts should show their outline').toBeGreaterThan(5);
  expect(shown[shown.length - 1].waiting, 'the outline should be gone once the release is in').toBe(false);
  expectSteady(all, 'download, release arriving late');
});

test('a page change is a dissolve you can see, and reduced motion keeps it without the rise', async ({ page }) => {
  // Each transition's animations, read off the document once it is running.
  await page.addInitScript(() => {
    window.__dissolves = [];
    window.__settles = [];
    document.addEventListener('animationstart', (event) => {
      if (event.target.classList && event.target.classList.contains('page-enter')) window.__settles.push(event.animationName);
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
  await page.setViewportSize(DESKTOP);
  await page.goto('/faq', { waitUntil: 'load' });
  await settle(page);

  const change = async (name, path) => {
    await page.evaluate(() => {
      window.__dissolves.length = 0;
      window.__settles.length = 0;
    });
    await page.locator('header').getByRole('link', { name, exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await page.waitForTimeout(900);
    return page.evaluate(() => ({ dissolves: window.__dissolves, settles: window.__settles }));
  };
  const rootFade = (dissolves) =>
    dissolves.flat().find((a) => a.pseudo === '::view-transition-new(root)');

  const full = await change('Pricing', '/pricing');
  expect(rootFade(full.dissolves)?.duration, 'the page should dissolve over about a third of a second').toBe(340);
  expect(full.settles, 'the arriving page should settle up into place').toContain('page-settle');

  // It used to skip the transition entirely here — a hard cut.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await change('Features', '/features');
  expect(rootFade(reduced.dissolves)?.duration, 'reduced motion should still dissolve, briefly').toBe(200);
  expect(reduced.settles, 'reduced motion should not move the page').not.toContain('page-settle');
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

  await startRecording(page);
  await page.goBack({ waitUntil: 'commit' });
  await untilShown(page, 'Straight');
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
  await startRecording(page);
  await page.locator('.mobile-menu').getByRole('link', { name: /docs/i }).first().click();
  await untilShown(page, 'Get set up');
  const all = await frames(page);

  expectSteady(all, 'phone faq -> docs');
  expect(all[all.length - 1].path).toBe('/docs');
  expect(all[all.length - 1].scrollY).toBe(0);
});
