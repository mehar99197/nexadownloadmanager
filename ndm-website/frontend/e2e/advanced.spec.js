import { test, expect } from '@playwright/test';

/**
 * The advanced-platform pass, held to what it claimed.
 *
 * Each of these is here because the feature it covers can fail *silently* and
 * in the direction of hiding content: a scroll-driven animation whose range
 * never completes leaves a section at opacity 0, a view transition that names
 * two elements the same throws and aborts, and content-visibility that never
 * un-skips makes text unreachable. None of those show up in a build, a lint or
 * a unit test, and all three look fine on the developer's own screen.
 */

const PHONE = { width: 390, height: 844 };

async function settle(page) {
  await page
    .waitForFunction(() => !document.documentElement.classList.contains('ndm-booting'), null, {
      timeout: 15_000,
    })
    .catch(() => {});
  await page.waitForTimeout(350);
}

test('a route change runs one view transition, and names nothing twice', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  // Counted from inside the page, before the app loads: React reads
  // document.startViewTransition at the moment of the swap, not at import.
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

  await page.goto('/');
  await settle(page);

  await page.getByRole('link', { name: /pricing/i }).first().click();
  await page.waitForURL(/\/pricing$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForTimeout(600);

  const { calls, supported } = await page.evaluate(() => ({
    calls: window.__vtCalls,
    supported: window.__vtSupported,
  }));

  expect(supported, 'the test browser should have view transitions').toBe(true);
  expect(calls, 'navigating should run a view transition').toBeGreaterThan(0);

  // "Duplicate view-transition-name" is the failure mode of naming a page that
  // also remounts, and the browser reports it by aborting the transition
  // rather than by looking wrong.
  const vtErrors = errors.filter((e) => /view-transition|ViewTransition/i.test(e));
  expect(vtErrors, `view transition errors:\n${vtErrors.join('\n')}`).toEqual([]);
  // There is no backend behind this harness, so the pages' own API calls come
  // back 502. Everything else is the page's own fault and worth failing on.
  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  expect(real, `console errors during navigation:\n${real.join('\n')}`).toEqual([]);
});

test('every revealed section settles in place, rather than part-way', async ({ page }) => {
  // The scroll-driven path replaces an IntersectionObserver that could only
  // ever fail open. A timeline whose range never completes fails CLOSED — the
  // section is left mid-animation, permanently, because a scroll-driven
  // animation holds wherever its range puts it. Both the offset and the
  // opacity are checked: the offset is what the native path animates, the
  // opacity is what the Firefox fallback animates, and either stuck short is
  // the same bug from the reader's side.
  for (const path of ['/', '/features', '/download', '/pricing']) {
    await page.goto(path, { waitUntil: 'load' });
    await settle(page);

    const stuck = await page.evaluate(async () => {
      const step = Math.round(window.innerHeight * 0.75);
      const out = [];
      for (let y = 0; y <= document.documentElement.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (const el of document.querySelectorAll('.reveal-native, .reveal')) {
          const b = el.getBoundingClientRect();
          // Judged only once it has been scrolled past. A section still
          // entering is *meant* to be part-way through, so testing it mid
          // range would pin down a number rather than the behaviour. Once its
          // top edge is above the window it has no reveal left to do, and
          // anything short of opaque there is the failure this test is for.
          if (b.top >= 0) continue;
          const cs = getComputedStyle(el);
          const o = Number(cs.opacity);
          // matrix(a, b, c, d, tx, ty) — ty is the drift that should be spent.
          const ty = Math.abs(Number((cs.transform.match(/matrix\(([^)]+)\)/)?.[1] || '').split(',')[5] || 0));
          if (o < 0.98 || ty > 1) {
            out.push(`${el.className} at scrollY=${Math.round(window.scrollY)} opacity=${o} translateY=${ty}`);
          }
        }
      }
      return [...new Set(out)];
    });

    expect(stuck, `sections still faded out on ${path}:\n${stuck.join('\n')}`).toEqual([]);
  }
});

test('the FAQ skips the rows nobody is near, and un-skips on demand @390', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/faq', { waitUntil: 'load' });
  await settle(page);

  const state = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('details.cv-row')];
    const last = rows[rows.length - 1];
    return {
      count: rows.length,
      declared: getComputedStyle(last).contentVisibility,
      // content-visibility skips an element's CONTENTS, not the element: the
      // row keeps its box and its remembered height, and the question is
      // whether the summary inside it was laid out at all. false === skipped,
      // which is the whole point.
      lastRendered: last.querySelector('summary').checkVisibility({ contentVisibilityAuto: true }),
    };
  });

  expect(state.count).toBeGreaterThan(40);
  expect(state.declared).toBe('auto');
  expect(state.lastRendered, 'the last of 55 rows should be skipped from the top of the page').toBe(false);

  // …and reaching it must still render it, which is the thing
  // content-visibility is famous for getting wrong.
  const found = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll('details.cv-row')];
    const last = rows[rows.length - 1];
    last.scrollIntoView({ block: 'center' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return last.querySelector('summary').checkVisibility({ contentVisibilityAuto: true });
  });
  expect(found, 'scrolling to a skipped row must render it').toBe(true);
});

test('/compare is readable with a thumb rather than nine screens @390', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/compare', { waitUntil: 'load' });
  await settle(page);

  const m = await page.evaluate(() => {
    const de = document.documentElement;
    return {
      screens: de.scrollHeight / window.innerHeight,
      sideways: de.scrollWidth - de.clientWidth,
      // Nothing inside the page may need its own sideways scroll either, and
      // the failure should say which element it was.
      //
      // Only overflow-x auto/scroll counts. Overflowing content under
      // `overflow: hidden` is clipped, not scrollable — and the widest number
      // on this page is a visually-hidden <caption>, which is 1px wide by
      // design and holds a sentence. Measuring scrollWidth alone reports that
      // as a 446px sideways scroll nobody can perform.
      worstScroller: [...document.querySelectorAll('body *')]
        .filter((el) => /^(auto|scroll)$/.test(getComputedStyle(el).overflowX))
        .map((el) => ({
          over: el.scrollWidth - el.clientWidth,
          what: `<${el.tagName.toLowerCase()}> ${String(el.className).slice(0, 70)}`,
        }))
        .sort((a, b) => b.over - a.over)[0] || { over: 0, what: '' },
      picker: !!document.getElementById('cmp-rival'),
      groups: document.querySelectorAll('details').length,
    };
  });

  expect(m.picker, 'the phone build should offer a rival picker').toBe(true);
  expect(m.groups, 'each feature group should fold away').toBeGreaterThan(3);
  expect(m.sideways).toBeLessThanOrEqual(1);
  // 4px, not 0: the pricing table's auto layout lands 2px over its own box at
  // 390px, which is rounding rather than a scroll — nothing moves and no
  // scrollbar appears. The failure this guards against is the matrix, which
  // was 446px over and needed a real gesture to read.
  expect(
    m.worstScroller.over,
    `something still scrolls sideways on a phone: ${m.worstScroller.what}`
  ).toBeLessThanOrEqual(4);
  // 9.19 screens before the phone build, 5.43 after. 6 is a regression guard
  // with room in it, not a target: the page still has to carry a feature
  // matrix, a pricing table and six recommendations, and folding those is as
  // far as folding goes before it starts hiding the point of the page.
  expect(m.screens, `/compare is ${m.screens.toFixed(2)} screens tall`).toBeLessThan(6);
});

test('the fallback font occupies the same space as the real one', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });
  await settle(page);

  const delta = await page.evaluate(async () => {
    await document.fonts.ready;
    const sample =
      'Nexa Download Manager — the internet, pulled into one place. ' +
      'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789';
    const measure = (family) => {
      const el = document.createElement('span');
      el.textContent = sample;
      el.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:400 100px ' + family;
      document.body.appendChild(el);
      const w = el.getBoundingClientRect().width;
      el.remove();
      return w;
    };
    const web = measure('"Instrument Sans"');
    const fallback = measure('"Instrument Sans Fallback"');
    const bare = measure('Arial');
    return {
      adjusted: Math.abs(fallback - web) / web,
      unadjusted: Math.abs(bare - web) / web,
    };
  });

  // Arial was ~1.9% off. The override should put the fallback within a few
  // tenths of a percent, so the swap stops moving every line under it.
  expect(delta.unadjusted).toBeGreaterThan(0.005);
  expect(
    delta.adjusted,
    `metric-matched fallback is ${(delta.adjusted * 100).toFixed(2)}% off (raw Arial: ${(delta.unadjusted * 100).toFixed(2)}%)`
  ).toBeLessThan(0.005);
});
