import { defineConfig, devices } from '@playwright/test';

/**
 * The same specs, pointed at the deployed site instead of a local preview.
 *
 * Temporary, for verifying a deploy: it proves the bytes that are actually
 * being served behave the way the build did, which a local run cannot — the
 * CSP, the .htaccess rewrites and the real API are only present here.
 *
 * Only the read-only specs are worth running this way. site.spec.js submits
 * forms.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['advanced.spec.js', 'a11y.spec.js', 'responsive.spec.js'],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: process.env.LIVE_URL || 'https://nexadownloadmanager.com',
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
  ],
});
