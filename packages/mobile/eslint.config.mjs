import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * ESLint for the mobile app. Backend and frontend already have this exact pattern
 * (`eslint.config.mjs`, narrow and high-signal); mobile had none, so the root's `lint
 * --workspaces --if-present` silently skipped it — the one package of the four with zero
 * linting at all.
 *
 * Same two things frontend's config exists for: the React hook rules (stale-closure and
 * conditional-hook bugs), and unhandled promises in a codebase that already found real ones
 * this way (`getRefreshToken()` returning an unawaited Promise, documented in
 * `api.service.ts`'s own comment, is exactly the class of bug `no-floating-promises` exists to
 * catch). Stylistic noise the existing code would drown in is off or set to warn, same
 * calibration the other two packages already settled on, so the build starts green.
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
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // ── React correctness ──
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // ── Async correctness ──
      // 'warn', not 'error', for the same reason frontend's config gives: fire-and-forget in a
      // lifecycle hook or an event handler (`useEffect(() => { loadThing(); }, [])`) is idiomatic
      // React(Native), not a bug — `no-misused-promises` below still catches the case that is
      // actually always wrong (an async function passed where a sync callback is expected).
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/await-thenable': 'warn',

      // ── Calm the noise the existing code would generate ──
      'no-undef': 'off', // TypeScript resolves identifiers; avoids false positives on RN/Hermes globals
      '@typescript-eslint/no-explicit-any': 'off',
      // Every existing site is a deliberate RN pattern, not a mistake to fix: a static asset
      // (`require('./logo.png')`, the only way Metro resolves an image) or a module loaded lazily
      // inside a try/catch because it is optional or platform-specific (`expo-navigation-bar` on
      // Android, `expo-notifications` when the native module isn't in the build) — a static
      // `import` at the top of the file would break exactly the platforms this avoids breaking.
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
);
