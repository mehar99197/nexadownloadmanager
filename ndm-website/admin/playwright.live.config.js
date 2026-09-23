import { defineConfig, devices } from '@playwright/test';

/**
 * The panel's specs, pointed at the deployed panel instead of a local preview.
 *
 * For verifying a deploy: this is the only way to see the bytes that are
 * actually served, behind the real CSP and the real .htaccess rewrites that
 * mount one dist at both /admin and /root.
 *
 * The API is stubbed exactly as it is locally, so nothing here signs in,
 * reads a real record or touches the live database — what is under test is
 * the rendering.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: process.env.LIVE_URL || 'https://nexadownloadmanager.com/admin/',
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
  ],
});
