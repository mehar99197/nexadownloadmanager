// Flat ESLint config — core rules + react-hooks only (no extra presets/deps).
import reactHooks from 'eslint-plugin-react-hooks';

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Blob: 'readonly',
  Intl: 'readonly',
  confirm: 'readonly',
  alert: 'readonly',
  crypto: 'readonly',
  CSS: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  performance: 'readonly',
  IntersectionObserver: 'readonly',
  ResizeObserver: 'readonly',
  MutationObserver: 'readonly',
  Event: 'readonly',
  HTMLDivElement: 'readonly',
};

// Config and test files run in Node (or the Vitest/Playwright runner), not the
// browser, so they get their own globals rather than being excluded from linting.
const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  __dirname: 'readonly',
  URL: 'readonly',
};

const testGlobals = {
  describe: 'readonly',
  it: 'readonly',
  test: 'readonly',
  expect: 'readonly',
  beforeEach: 'readonly',
  afterEach: 'readonly',
  beforeAll: 'readonly',
  afterAll: 'readonly',
  vi: 'readonly',
};

export default [
  { ignores: ['dist/**', 'node_modules/**', 'test-results/**', 'playwright-report/**'] },
  {
    files: ['**/*.{js,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: browserGlobals,
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-dupe-keys': 'error',
      'no-duplicate-imports': 'warn',
      'no-unreachable': 'error',
      'no-constant-condition': 'warn',
      'no-debugger': 'error',
      'eqeqeq': ['warn', 'smart'],
      'prefer-const': 'warn',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['*.config.js', 'scripts/**/*.{js,mjs}', 'e2e/**/*.js'],
    languageOptions: { globals: { ...browserGlobals, ...nodeGlobals } },
  },
  {
    files: ['src/**/*.test.{js,jsx}', 'src/test/**/*.{js,jsx}', 'e2e/**/*.js'],
    languageOptions: { globals: { ...browserGlobals, ...nodeGlobals, ...testGlobals } },
  },
];
