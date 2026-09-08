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
      // Off, after auditing every site it flagged. All 17 that survived the cleanup are the rule's
      // known blind spot: a method whose Promise-returning signature is fixed by a contract it does
      // not control -- `StorageEngine.getFileStream`, `RoutingProvider.calculateRoute`, the planning
      // engine's `calculate(...): Promise<number>` criteria, a ThrottlerGuard override -- whose body
      // happens to be synchronous. Marking those `async` is the idiomatic way to satisfy the
      // signature; the alternative is wrapping every return in `Promise.resolve` for a linter.
      //
      // The bug people actually mean by this rule -- "meant to await, forgot" -- is caught by
      // `no-floating-promises` above, which is an error, not a warning: a forgotten await leaves a
      // floating promise and fails the build. Nothing is lost by switching this one off.
      '@typescript-eslint/require-await': 'off',

      // ── Calm the noise the existing code would otherwise generate ──
      '@typescript-eslint/no-explicit-any': 'off',
      // `ignoreRestSiblings`: `const { passwordHash, ...safe } = user` is how this codebase drops a
      // field it must not return. The named binding is deliberately unused -- that IS the removal --
      // so flagging it would push people to rename the very thing being excluded.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
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
