import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * ESLint for the backend. The monorepo had no linter at all (documented in
 * infrastructure/persistence/persistence-boundary.spec.ts), so this starts deliberately narrow: the
 * point is the **async-safety** rules that the compiler cannot catch and that matter most in a codebase
 * moving money through queues and transactions — an un-awaited promise is a silent failure or an
 * unhandled rejection. The stylistic type-checked rules that the existing code would drown in are left
 * off or set to warn, so the signal is real and the build stays green while the team burns down warnings.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '**/*.spec.ts',
      '**/*.e2e-spec.ts',
      'src/infrastructure/database/migrations/**',
      'eslint.config.mjs',
      'jest.config.js',
    ],
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
      // ── The reason this config exists: async correctness ──
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      // Awaiting a non-Promise is harmless (resolves immediately) — advisory, not a build-breaker.
      '@typescript-eslint/await-thenable': 'warn',
      'require-await': 'off',
      '@typescript-eslint/require-await': 'warn',

      // ── Calm the noise the existing code would otherwise generate ──
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    // Hand-run ESM utility scripts. They live under src/ for discoverability but are not part of
    // the compiled application, so they are in no tsconfig — and the type-aware project service
    // fails outright on a file it cannot resolve to a project ("was not found by the project
    // service"), which is an error, not a warning, and takes the whole lint run down with it.
    //
    // Linted with the plain JS rules rather than excluded, so a genuine mistake in one — an
    // undefined variable, an unreachable branch — is still caught. The type-aware rules are the
    // only thing switched off, because there are no types here to check against.
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: { projectService: false },
      globals: globals.node,
    },
  },
);
