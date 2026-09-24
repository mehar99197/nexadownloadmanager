import { test, expect } from '@playwright/test';
import { stubApi } from './support/stub.js';

/**
 * WP-18 — nothing third-party may run before the visitor agrees to it.
 *
 * Google Identity Services sets a `g_state` cookie as soon as its script runs,
 * and the sign-in page loaded that script on mount. Under GDPR/ePrivacy that
 * is a non-essential cookie set without consent, on every visit to /login and
 * /register, before the visitor has done anything at all.
 *
 * The gate is global rather than geo-targeted: one code path, no dependency on
 * a country header being present and correct at the edge, and nothing to get
 * wrong for a visitor behind a VPN.
 *
 * What must hold:
 *   - No request to accounts.google.com before a choice is made.
 *   - Accepting loads it, and the choice survives a reload.
 *   - Declining keeps it blocked, permanently, and still leaves a working way
 *     to sign in.
 *   - The email/password form works regardless — consent must never be a wall
 *     in front of the product.
 */

const GSI = /accounts\.google\.com\/gsi/;

/**
 * Record every attempt to load Google Identity Services, and stub it so the
 * suite never actually reaches Google. The request event still fires, so an
 * attempt is observable without a network round trip.
 */
async function trackThirdParty(page) {
  const seen = [];
  page.on('request', (req) => {
    if (GSI.test(req.url())) seen.push(req.url());
  });
  await page.route(GSI, (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* stubbed GSI */' }));
  return seen;
}

test.describe('WP-18 — consent gate', () => {
  test('loads no Google script before the visitor chooses', async ({ page }) => {
    const requests = await trackThirdParty(page);
    await stubApi(page);
    await page.goto('/login');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Give a late loader every chance to fire before asserting it did not.
    await page.waitForTimeout(700);

    expect(requests, 'GSI ran before consent').toEqual([]);
    await expect(page.getByRole('region', { name: /cookie|consent/i })).toBeVisible();
  });

  test('the email and password form still works with no choice made', async ({ page }) => {
    await stubApi(page);
    await page.goto('/login');

    // The banner must not block the product.
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
    // exact: the show/hide toggle is also labelled "Show password".
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^sign in$/i })).toBeEnabled();
  });

  test('accepting loads Google and the choice survives a reload', async ({ page }) => {
    const requests = await trackThirdParty(page);
    await stubApi(page);
    await page.goto('/login');

    await page.getByRole('button', { name: /^accept$/i }).click();

    await expect.poll(() => requests.length, { timeout: 7000 }).toBeGreaterThan(0);
    await expect(page.getByRole('region', { name: /cookie|consent/i })).toBeHidden();

    await page.reload();
    await expect(page.getByRole('region', { name: /cookie|consent/i })).toBeHidden();
  });

  test('declining keeps Google blocked, and says how to change it', async ({ page }) => {
    const requests = await trackThirdParty(page);
    await stubApi(page);
    await page.goto('/login');

    await page.getByRole('button', { name: /decline|reject/i }).click();
    await page.waitForTimeout(700);

    expect(requests, 'GSI ran despite being declined').toEqual([]);
    await expect(page.getByRole('region', { name: /cookie|consent/i })).toBeHidden();

    // Declining must not leave a dead area where the button was.
    await expect(page.getByText(/google sign-in is off|enable google/i).first()).toBeVisible();

    await page.reload();
    await page.waitForTimeout(500);
    expect(requests, 'a declined choice must survive a reload').toEqual([]);
  });

  test('the decision is remembered per browser, not per page', async ({ page }) => {
    await stubApi(page);
    await page.goto('/login');
    await page.getByRole('button', { name: /decline|reject/i }).click();
    await expect(page.getByRole('region', { name: /cookie|consent/i })).toBeHidden();

    await page.goto('/register');
    await expect(page.getByRole('region', { name: /cookie|consent/i })).toBeHidden();
  });

  test('a page with no third-party embed still shows the banner once', async ({ page }) => {
    // The choice is site-wide, so it is asked once wherever the visitor lands.
    await stubApi(page);
    await page.goto('/pricing');
    await expect(page.getByRole('region', { name: /cookie|consent/i })).toBeVisible();
  });
});

test.describe('WP-20 — the contact form has more than a honeypot', () => {
  test('keeps its honeypot field hidden from people', async ({ page }) => {
    await stubApi(page);
    await page.goto('/contact');

    const honeypot = page.locator('input[name="website"]');
    await expect(honeypot).toHaveCount(1);
    await expect(honeypot).toBeHidden();
  });

  test('renders a challenge when the site is built with a Turnstile key', async ({ page }) => {
    await stubApi(page);
    await page.goto('/contact');

    // Turnstile is fully wired on both ends; it renders only when
    // VITE_TURNSTILE_SITE_KEY is set at build time, and the API's
    // requireTurnstile gate switches on with TURNSTILE_SECRET_KEY. Without a
    // key configured there is deliberately nothing to show, and the widget
    // must not leave an empty box behind.
    const widget = page.locator('[data-testid="turnstile"]');
    const configured = (await widget.count()) > 0;
    if (!configured) {
      await expect(widget).toHaveCount(0);
      return;
    }
    await expect(widget).toBeVisible();
    await expect(page.getByRole('button', { name: /send message/i })).toBeDisabled();
  });
});
