import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import globals from 'globals';

export default defineConfig([
  {
    ignores: [
      '**/node_modules/**',
      '**/.git/**',
      '**/.worktrees/**',
      '**/.claude/worktrees/**',
      '**/.cache/**',
      '**/.parallax-artifact/**',
      '**/verify-out/**',
      '**/coverage/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    rules: {
      'no-unused-vars': 'warn',
    },
  },
  {
    files: ['src/**/*.js', 'ui/**/*.js'],
    ignores: ['**/*.test.js', '**/*.spec.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: [
      '**/*.test.{js,mjs,cjs}',
      '**/*.spec.{js,mjs,cjs}',
      'scripts/**/*.{js,mjs,cjs}',
      '.claude/hooks/**/*.{js,mjs,cjs}',
      'eslint.config.js',
      'test/**/*.js',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    // These Node scripts also contain callbacks executed in the browser.
    files: [
      'scripts/capture-wizard.mjs',
      'scripts/public-url-browser-contract.mjs',
      'scripts/verify.mjs',
      'scripts/wizard-browser-contract.mjs',
      'scripts/goals-presentation-browser-contract.mjs',
      'scripts/browser/**/*.mjs',
    ],
    languageOptions: { globals: globals.browser },
  },
]);
