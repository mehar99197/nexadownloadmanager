import { test, expect } from '@playwright/test';

/**
 * Responsive layout, checked the one way that is objective: a page must never
 * scroll sideways. Horizontal overflow is what a too-wide table, an unwrapped
 * code block or a fixed-width hero actually produces, and it is invisible on a
 * developer's wide monitor.
 *
 * 320px is the narrowest phone still in use (iPhone SE / small Android); the
 * rest are the ordinary phone, tablet and desktop widths.
 */
const WIDTHS = [
  { name: 'small phone', width: 320, height: 640 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'wide', width: 1920, height: 1080 },
];

const PAGES = [
  '/', '/download', '/pricing', '/reviews', '/compare', '/faq', '/about',
  '/changelog', '/contact', '/terms', '/privacy',
  '/docs', '/docs/install', '/docs/extension', '/docs/youtube',
  '/docs/courses', '/docs/torrents', '/docs/remote', '/docs/license',
  '/login', '/register',
];

for (const vp of WIDTHS) {
  test(`no horizontal overflow at ${vp.width}px (${vp.name})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const offenders = [];
    for (const path of PAGES) {
      // 'load', not 'networkidle': layout is settled once styles and fonts are
      // in, and networkidle waits out the API calls these pages fire — which
      // have no backend here, so it sat through the proxy's connect retries and
      // made the suite both slow and flaky.
      await page.goto(path, { waitUntil: 'load' });
      const r = await page.evaluate(() => {
        const de = document.documentElement;
        const over = de.scrollWidth - de.clientWidth;
        if (over <= 1) return { over };
        // Name what actually sticks out, so a failure is actionable.
        const wide = [...document.querySelectorAll('body *')]
          .filter((el) => {
            const b = el.getBoundingClientRect();
            return b.width > 0 && (b.right > de.clientWidth + 1 || b.left < -1);
          })
          .slice(0, 3)
          .map((el) => `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ').slice(0, 2).join('.') : ''}`);
        return { over, wide };
      });
      if (r.over > 1) offenders.push(`${path}: ${r.over}px over (${(r.wide || []).join(', ')})`);
    }
    expect(offenders, `pages scrolling sideways at ${vp.width}px:\n${offenders.join('\n')}`).toEqual([]);
  });
}

test('the mobile navigation opens and reaches a page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  // The desktop nav is md:hidden at this width; this is the hamburger.
  const toggle = page.getByRole('button', { name: 'Toggle menu' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  const pricing = page.locator('.mobile-menu').getByRole('link', { name: /pricing/i }).first();
  await expect(pricing).toBeVisible();
  await pricing.click();
  await expect(page).toHaveURL(/\/pricing$/);
});
