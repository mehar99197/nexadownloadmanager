import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Accessibility and touch ergonomics, at phone width, in both colour schemes.
 *
 * Both themes, because the site follows `prefers-color-scheme` and a dark-first
 * palette is exactly where a light theme goes wrong: a colour that was never
 * inverted reads as invisible text to the person who has light mode on and to
 * nobody else.
 *
 * Two lessons from building this are baked in, and undoing either brings back
 * a false result rather than a failure:
 *
 *  1. **Wait out the boot overlay.** `index.html` shows `#ndm-boot` for a
 *     minimum of 700ms on every full page load. A run that measured at 300ms
 *     reported 46 contrast violations, every one of them a half-applied style
 *     rather than a real defect.
 *  2. **Let axe do the colour maths.** A hand-rolled check that walks up for
 *     the nearest `background-color` reads white-on-a-purple-gradient as
 *     white-on-white, and treats `rgba(…, 0.12)` as opaque — that is where
 *     "Register at 1.78:1" came from, when the composited answer is 6.9:1.
 */

const PAGES = [
  '/', '/download', '/pricing', '/features', '/compare', '/faq', '/docs',
  '/about', '/contact', '/changelog', '/reviews', '/login', '/register',
];

const PHONE = { width: 390, height: 844 };

/** The page is ready to measure once the boot screen has let go. */
async function settle(page) {
  await page.waitForFunction(
    () => !document.documentElement.classList.contains('ndm-booting'),
    null,
    { timeout: 15_000 }
  ).catch(() => { /* a page that never boots is a different test's problem */ });
  await page.waitForTimeout(350);
}

for (const scheme of ['dark', 'light']) {
  test(`no accessibility violations — ${scheme} @390`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize(PHONE);

    const found = [];
    for (const path of PAGES) {
      await page.goto(path, { waitUntil: 'load' });
      await settle(page);
      const res = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      for (const v of res.violations) {
        found.push(`${path}: [${v.impact}] ${v.id} — ${v.help} (${v.nodes.length} node(s), e.g. ${String(v.nodes[0]?.target[0]).slice(0, 60)})`);
      }
    }

    expect(found, `axe violations in ${scheme} mode:\n${found.join('\n')}`).toEqual([]);
  });
}

/**
 * Two bars, because the standard has two and conflating them produces bad
 * design decisions.
 *
 *  - **24x24** is WCAG 2.2 Level AA (2.5.8, Target Size Minimum). It applies
 *    to everything a finger can hit, and failing it is a defect.
 *  - **44x44** is Level AAA (2.5.5) and Apple's HIG. It is the right bar for a
 *    control — a button, a field, a call to action — and the wrong bar for a
 *    dense navigation list, where paying 26px per row twelve times over costs
 *    a screen of scrolling to fix something that was never the problem.
 *
 * A link inline in a sentence is exempt from both, by the standard and by
 * common sense: 44px-tall links would wreck the line height of every
 * paragraph. Exemption decided by meaning, not by a tag list — if the link's
 * parent holds text of its own, the link is inside a sentence. A tag list
 * missed the prose inside <details> answers, which are plain <div>s, and
 * reported a dozen inline links as bugs.
 */
const PROBE = `
  const SEL = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"]';
  const out = [];
  for (const el of document.querySelectorAll(SEL)) {
    // checkVisibility, not a display check: a control inside a subtree the
    // browser is skipping for content-visibility still answers
    // getBoundingClientRect with a box, and answers innerText with nothing —
    // so the FAQ's closed rows reported an unnamed 63x43.7 button that no
    // finger can reach because it is not being rendered at all. This is the
    // one predicate that covers display, visibility AND content-visibility.
    if (!el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (el.tagName === 'A') {
      const p = el.parentElement;
      const own = p ? (p.textContent || '').replace(el.textContent || '', '').trim() : '';
      if (own.length > 2) continue;
    }
    const label = (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 30);
    const isControl = el.tagName !== 'A' || el.classList.contains('btn');
    const min = isControl ? 44 : 24;
    if (r.width < min || r.height < min) {
      out.push(Math.round(r.width) + 'x' + Math.round(r.height) + ' (needs ' + min + ') <' + el.tagName.toLowerCase() + '> "' + label + '"');
    }
  }
  return out;
`;

test('tap targets meet WCAG 2.2 AA, and controls meet the 44px bar @390', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize(PHONE);

  const small = [];
  for (const path of PAGES) {
    await page.goto(path, { waitUntil: 'load' });
    await settle(page);
    const offenders = await page.evaluate(new Function(PROBE));
    for (const o of new Set(offenders)) small.push(`${path}: ${o}`);
  }

  expect(small, `tap targets below their bar:\n${small.join('\n')}`).toEqual([]);
});
