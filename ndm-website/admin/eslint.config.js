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
  Event: 'readonly',
  CustomEvent: 'readonly',
};

// Test files run in the Vitest runner rather than the browser, so they get the
// runner's globals on top of the browser ones. Mirrors frontend/eslint.config.js
// rather than excluding the tests from linting, which would let a typo in a
// mock sit there unnoticed.
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
  { ignores: ['dist/**', 'node_modules/**'] },
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
    files: ['src/**/*.test.{js,jsx}', 'src/test/**/*.{js,jsx}', 'vitest.config.js'],
    languageOptions: { globals: { ...browserGlobals, ...testGlobals } },
  },
  {
    // Playwright specs run in Node but evaluate code inside the page, so they
    // legitimately name both sets of globals in one file.
    files: ['e2e/**/*.{js,jsx}', 'playwright.config.js', 'playwright.live.config.js'],
    languageOptions: {
      globals: {
        ...browserGlobals,
        ...testGlobals,
        getComputedStyle: 'readonly',
        innerWidth: 'readonly',
        innerHeight: 'readonly',
        process: 'readonly',
      },
    },
  },
];
