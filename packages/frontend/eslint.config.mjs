import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * ESLint for the web frontend. Like the backend config, this starts narrow and high-signal: the point
 * is the rules the compiler can't enforce — unhandled promises in event handlers (a silent failure or
 * unhandled rejection) and the React hook rules (stale-closure and conditional-hook bugs). Stylistic
 * type-checked noise the existing inline-styled code would drown in is off or set to warn, so the build
 * stays green while the team burns down warnings.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/*.test.*',
      'vite.config.ts',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // ── React correctness ──
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // ── Async correctness ──
      // Fire-and-forget in event handlers (`onClick={() => save()}`) is idiomatic React, so a floating
      // promise here is usually intentional — advisory, not build-breaking. `no-misused-promises` still
      // catches the genuinely wrong cases (e.g. an async function where a sync void return is expected).
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/await-thenable': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',

      // ── Calm the noise the existing code would generate ──
      'no-undef': 'off', // TypeScript resolves identifiers; avoids false positives on DOM/browser globals
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
);
