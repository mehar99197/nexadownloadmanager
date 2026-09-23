import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end checks for the control panel, against a real build.
 *
 * Every screen but the sign-in page sits behind a session, so the specs stub
 * the API with route interception rather than standing up a backend — the
 * question here is what the panel renders and how it behaves on a phone, not
 * whether the server answers, which the backend suite already covers.
 *
 * `base` is /admin/ (see vite.config.js), so the preview server serves the SPA
 * from that path and the baseURL has to include it.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4174/admin/',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
  ],
  webServer: {
    command: 'npm run build && npm run preview -- --port 4174 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4174/admin/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
