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
import { configure } from '@testing-library/react';

/**
 * Two async budgets, raised together, because both defaults are wall-clock numbers chosen for a
 * machine running one test at a time and this suite runs 74 files across every core on the box.
 *
 * The symptom was three suites that passed alone and failed in the full run — `Rules.spec.tsx`,
 * `HrPayPage.spec.tsx` and `record-deep-link.spec.tsx` — with two different errors, which is what
 * gave the cause away. Measured alone, with `--runInBand`:
 *
 *   HrPayPage  "counts and lists all 1,155 people"      3884 ms   (its other 8 tests: 37–65 ms)
 *   Rules      "offers a branch past the first 200"     2272 ms   (its other 3 tests: 19–22 ms)
 *   record-deep-link, slowest of its five                413 ms
 *
 * The first two sit under jest's 5000 ms `testTimeout` with barely a second of headroom and fail
 * with "Exceeded timeout of 5000 ms" once workers contend; the third is nowhere near 5000 ms and
 * failed differently, with testing-library's "Unable to find an element", because `waitFor`'s own
 * default budget is 1000 ms and 413 ms of work does not survive a 3–5x slowdown either.
 *
 * Neither is a hung test and no amount of retrying is being papered over. The cost is real,
 * synchronous, CPU-bound rendering: HrPayPage's slow test differs from its fast ones only in
 * rendering 1,155 table rows instead of six, and it must, because the number the test exists to
 * catch is the 1,000-row page size the page used to stop at. Fake timers were the other candidate
 * and are the wrong tool here for the same reason — there is no timer to advance. The time goes
 * into React committing DOM in jsdom and into promises the mocked `api.request` resolves
 * immediately; installing fake timers would leave every one of those milliseconds exactly where it
 * is, while breaking react-query's scheduler, which is what the comment in HrPayPage.spec.tsx
 * records already having gone wrong once here.
 *
 * The ordering below is deliberate and is the part worth preserving. `asyncUtilTimeout` must stay
 * comfortably under `testTimeout` so that a genuinely broken assertion is reported by
 * testing-library — "Unable to find an element with the text: …", plus the DOM dump that says what
 * WAS rendered — rather than by jest, whose "Exceeded timeout of 30000 ms" names no element, no
 * query and no markup. Inverting them turns every future UI failure into a 30-second guess.
 *
 * These are ceilings, not waits: a passing test still finishes in the milliseconds it always did,
 * so nothing here slows the suite down. What it does cost is the report time on a test that hangs
 * for real, which now takes 30 s to say so. That is the trade, and it is the right way round for a
 * suite whose failures are currently drowning in false ones.
 */
jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

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
