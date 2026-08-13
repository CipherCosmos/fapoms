/**
 * Unit tests for the app's pure logic, deliberately without the React Native runtime.
 *
 * The heavy `jest-expo` preset exists to render components; nothing here does. What needed
 * covering was the offline location queue — the code that decides whether a field worker's
 * movement evidence survives a day without signal — and that is plain TypeScript over a small
 * storage interface, which a node environment runs directly and much faster.
 *
 * Native modules (expo-file-system and friends) are never loaded because the one module that
 * touches them, `services/token-store`, is mocked in the tests that need it. If component tests
 * are added later they will need the jest-expo preset and a separate project entry.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  /**
   * Confine the file crawler to `src`.
   *
   * Not a tidiness preference — without it jest walks the whole package, and this one carries a
   * native `android/` tree with build outputs plus an exported `dist/` web bundle. Crawling those
   * exhausted a 4 GB heap and killed the run before a single test executed. `testMatch` alone does
   * not help: it filters which files are *tests*, after everything has already been scanned.
   */
  roots: ['<rootDir>/src'],
  modulePathIgnorePatterns: ['<rootDir>/android/', '<rootDir>/ios/', '<rootDir>/dist/', '<rootDir>/.expo/'],
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { module: 'commonjs', esModuleInterop: true, strict: true } }],
  },
  clearMocks: true,
};
