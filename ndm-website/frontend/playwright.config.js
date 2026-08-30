import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against a real build served by `vite preview`.
 *
 * The API is stubbed per test with route interception, so these prove the built
 * bundle routes, renders and links correctly without needing a backend or a
 * database. Uses the system Chrome, so CI does not download a browser.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
  ],
  webServer: {
    // --host 127.0.0.1: vite preview otherwise binds "localhost", which can
    // resolve to ::1 only, and the IPv4 baseURL then never connects.
    command: 'npm run build && npm run preview -- --port 4173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
