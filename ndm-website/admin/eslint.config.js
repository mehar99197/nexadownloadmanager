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
];
