/**
 * Test rails for the web app.
 *
 * Until now `packages/frontend` could not test a `.tsx` file at all: jest ran with
 * `testEnvironment: "node"`, `moduleFileExtensions` without `tsx`, and no testing library — so all
 * 15 specs were pure logic and every component shipped unverified. On a repo whose commits
 * auto-deploy to live users within about two minutes, that is the gap that made every UI change a
 * leap of faith.
 *
 * The jest block in package.json also compiles specs with `esModuleInterop`, which the app's own
 * tsconfig leaves off because Vite's bundler does that interop itself. ts-jest emits CommonJS, and
 * without the flag `import React from 'react'` compiles to `react_1.default` — `undefined` against
 * React's CJS build. Type-only uses (`React.FC`) are erased and never notice; the first component
 * to call `React.useEffect` at runtime dies with "Cannot read properties of undefined".
 */
import '@testing-library/jest-dom';

/**
 * `window.matchMedia`, which jsdom does not implement at all.
 *
 * Unlike `fetch` and friends there is no Node copy to hand over (see `jest.jsdom-env.js`), so it
 * has to be stood up here. Several pages read a media query on mount to decide a responsive
 * layout — `Projects`' `useIsNarrow` is one — and against bare jsdom that is not a wrong layout,
 * it is `TypeError: window.matchMedia is not a function` thrown out of an effect before the page
 * has rendered anything at all.
 *
 * It answers `false`, i.e. the desktop layout, and reports no listeners: a component may add and
 * remove them freely, and nothing here ever fires a change. A test that needs the narrow layout
 * should override this for itself rather than widen the default.
 */
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    media: query,
    matches: false,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,      // deprecated, still called by some libraries
    removeListener: () => undefined,   // deprecated, still called by some libraries
    dispatchEvent: () => false,
  });
}
