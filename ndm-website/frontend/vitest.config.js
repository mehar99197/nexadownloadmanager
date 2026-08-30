import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Component tests run in jsdom against the real components; anything touching
// the network is stubbed per test, so a flaky API can never make the suite red.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // jsdom only provides localStorage/sessionStorage for a real origin;
    // without this they are undefined and every teardown throws.
    environmentOptions: { jsdom: { url: 'http://localhost:5173/' } },
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    css: false,
  },
});
