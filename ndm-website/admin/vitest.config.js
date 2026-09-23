import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Mirrors frontend/vitest.config.js on purpose: two suites in one repository
// should not need two sets of habits. Component tests run in jsdom against the
// real components, and anything touching the network is stubbed per test.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // jsdom only provides localStorage/sessionStorage for a real origin;
    // without this they are undefined and every teardown throws. The panel
    // reads localStorage for its bearer, so this is load-bearing here.
    environmentOptions: { jsdom: { url: 'http://localhost:5174/' } },
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    css: false,
  },
});
