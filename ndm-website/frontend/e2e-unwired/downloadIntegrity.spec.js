import { test, expect } from '@playwright/test';
import { stubApi, RELEASE } from './support/stub.js';

/**
 * WP-02 / WP-03 — what /download promises about the file it hands over.
 *
 * WP-02  The Windows installer carries no Authenticode signature (the PE
 *        Certificate Table is RVA 0 / size 0), so SmartScreen warns on first
 *        run. There is no certificate yet, so the honest move — and what the
 *        brief asks for — is to say so on the page and give people the
 *        checksum they CAN verify, rather than let the warning look like
 *        evidence of tampering.
 * WP-03  The page must not advertise a version it cannot stand behind. The
 *        version shown comes from the release row, and the publish path now
 *        refuses an installer whose own version disagrees with it
 *        (backend test/releaseVersionInvariant.integration.test.js).
 */

test.describe('WP-02 — unsigned builds are disclosed', () => {
  test('says the builds are not code-signed and how to verify them', async ({ page }) => {
    await stubApi(page);
    await page.goto('/download');

    const note = page.getByText(/not code-signed/i);
    await expect(note).toBeVisible();

    const body = await page.locator('body').innerText();
    expect(body).toMatch(/SmartScreen/i);
    // The disclosure is worthless without the thing the reader can check.
    expect(body).toMatch(/Get-FileHash/);
    expect(body).toMatch(/sha256sum/);
  });

  test('the note sits with the download, not buried at the bottom', async ({ page }) => {
    await stubApi(page);
    await page.goto('/download');

    const note = page.getByText(/not code-signed/i).first();
    await expect(note).toBeVisible();

    const [noteY, cardY] = await Promise.all([
      note.boundingBox().then((b) => b.y),
      page.getByText(/SHA-256/i).first().boundingBox().then((b) => b.y),
    ]);
    // Immediately after the OS cards, not a page-length away from them.
    expect(noteY - cardY).toBeLessThan(900);
  });
});

test.describe('WP-03 — the advertised version and checksum', () => {
  test('shows the release version and its checksum together', async ({ page }) => {
    await stubApi(page);
    await page.goto('/download');

    await expect(page.getByText(new RegExp(RELEASE.version)).first()).toBeVisible();
    await expect(page.getByText(RELEASE.windowsSha256).first()).toBeVisible();
  });

  test('offers no download when the platform has no artifact', async ({ page }) => {
    // hasWindows/hasLinux false must disable the button rather than link to a
    // 404 — the page used to infer availability from an always-empty URL.
    await stubApi(page, {
      release: { ...RELEASE, hasWindows: false, hasLinux: false },
    });
    await page.goto('/download');

    const disabled = page.getByRole('button', { name: /not available yet/i });
    await expect(disabled.first()).toBeVisible();
  });

  test('every download goes through the counting redirect', async ({ page }) => {
    await stubApi(page);
    await page.goto('/download');

    const hrefs = await page.locator('a[href*="releases/download"]').evaluateAll((els) =>
      els.map((el) => el.getAttribute('href')));

    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href, 'a direct artifact URL would bypass the download counter')
        .toMatch(/\/releases\/download\/(windows|linux)$/);
    }
  });
});
