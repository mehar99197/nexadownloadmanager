import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // Storage can be unavailable (no origin, or blocked); teardown must not throw.
  try { window.localStorage?.clear(); } catch { /* nothing to clear */ }
  try { window.sessionStorage?.clear(); } catch { /* nothing to clear */ }
});

// jsdom has no matchMedia; several components ask for it.
if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  });
}
