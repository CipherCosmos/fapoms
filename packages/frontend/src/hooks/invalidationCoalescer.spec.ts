import { createCoalescer } from './invalidationCoalescer';

/**
 * The socket invalidation window is the difference between "the desk updates" and "the desk
 * refetches its heaviest aggregate 500 times during a bulk import". Both halves of the rule are
 * asserted here because each one, alone, is a real bug that shipped:
 *
 *  - without coalescing, one refetch per event;
 *  - without the max-wait, a continuous event stream starves the flush entirely and the screen
 *    never updates — which looks exactly like "realtime is broken" and is far harder to spot in
 *    review than the storm it replaced.
 */
describe('createCoalescer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('collapses a burst of signals into one flush', () => {
    const flushed: string[][] = [];
    const c = createCoalescer<string>(500, 2000, (keys) => flushed.push(keys));

    for (let i = 0; i < 50; i++) c.schedule('assignments');

    jest.advanceTimersByTime(499);
    expect(flushed).toHaveLength(0);

    jest.advanceTimersByTime(1);
    expect(flushed).toEqual([['assignments']]);
  });

  it('de-duplicates by key value, not by object identity', () => {
    const flushed: unknown[][] = [];
    const c = createCoalescer<string[]>(500, 2000, (keys) => flushed.push(keys));

    // Two separate arrays with the same contents are the same query as far as React Query is
    // concerned, so they must cost one invalidation, not two.
    c.schedule(['planning', 'branches']);
    c.schedule(['planning', 'branches']);
    c.schedule(['dashboard']);

    jest.advanceTimersByTime(500);
    expect(flushed).toEqual([[['planning', 'branches'], ['dashboard']]]);
  });

  it('still flushes under a continuous stream that would starve a plain debounce', () => {
    // A clock the test drives by hand: `jest.advanceTimersByTime` moves the timer queue but not
    // `Date.now`, and the max-wait is measured against wall time.
    let clock = 0;
    const flushed: string[][] = [];
    const c = createCoalescer<string>(500, 2000, (keys) => flushed.push(keys), () => clock);

    // An event every 200 ms forever. A trailing-only debounce would never fire.
    for (let i = 0; i < 20; i++) {
      c.schedule('assignments');
      clock += 200;
      jest.advanceTimersByTime(200);
    }

    // 20 events over 4 s, capped at one flush per 2 s of burst.
    expect(flushed.length).toBeGreaterThanOrEqual(1);
    expect(flushed.length).toBeLessThanOrEqual(3);
    expect(flushed[0]).toEqual(['assignments']);
  });

  it('drops pending work on cancel so a torn-down effect cannot invalidate later', () => {
    const flushed: string[][] = [];
    const c = createCoalescer<string>(500, 2000, (keys) => flushed.push(keys));

    c.schedule('assignments');
    c.cancel();
    jest.advanceTimersByTime(5000);

    expect(flushed).toHaveLength(0);
  });
});
