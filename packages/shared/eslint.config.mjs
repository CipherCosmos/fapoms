import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * ESLint for the shared package. Backend and frontend already have this exact pattern
 * (`eslint.config.mjs`, narrow and high-signal); this had none, so the root's `lint
 * --workspaces --if-present` silently skipped the one package both of them import from.
 *
 * No React, no request/response cycle — the rules that matter here are the ones any
 * TypeScript library benefits from: an unhandled promise, an unused import left behind by a
 * refactor. Stylistic noise the existing code would drown in is off or set to warn, same
 * calibration backend and frontend already settled on, so the build starts green.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '**/*.spec.ts', 'eslint.config.mjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── Async correctness ──
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/await-thenable': 'warn',

      // ── Calm the noise the existing code would generate ──
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
);
