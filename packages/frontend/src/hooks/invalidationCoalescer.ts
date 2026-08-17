/**
 * Collapses a burst of "this key is stale" signals into one flush.
 *
 * Extracted from `useSocketInvalidation` so the timing rule — the part that is easy to get subtly
 * wrong and impossible to eyeball — can be tested directly. This package's jest runs on
 * `testEnvironment: node` and cannot render a hook, so behaviour that lives inside `useEffect` is
 * behaviour nothing verifies.
 *
 * Two windows, because a debounce with only one is wrong in one direction or the other:
 *
 *  - `waitMs` is the quiet period after the last signal. It is what turns 50 socket events from a
 *    bulk transition into a single refetch.
 *  - `maxWaitMs` is the longest a flush may be postponed regardless. Without it a plain trailing
 *    debounce STARVES: a bulk import emitting an event every 200 ms resets a 500 ms timer forever,
 *    so the screen never refreshes at all — a worse failure than the storm the debounce was added
 *    to prevent, and one that only appears under exactly the load that matters.
 *
 * Keys are de-duplicated by their JSON form, so ten events naming the same query key cost one
 * invalidation, and the ORIGINAL key object is what gets flushed (React Query matches on value,
 * but handing back the caller's own array keeps `queryKey` identity meaningful in a debugger).
 */
export interface Coalescer<T> {
  /** Queue a key for the next flush, (re)arming the timer. */
  schedule: (key: T) => void;
  /** Drop the pending timer without flushing — for effect teardown. */
  cancel: () => void;
}

export function createCoalescer<T>(
  waitMs: number,
  maxWaitMs: number,
  onFlush: (keys: T[]) => void,
  /** Injectable only so the spec can drive time without real timers. */
  now: () => number = Date.now,
): Coalescer<T> {
  const pending = new Map<string, T>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** When the current burst started, so the flush can be forced once it has run long enough. */
  let firstQueuedAt = 0;

  const flush = () => {
    timer = null;
    firstQueuedAt = 0;
    const keys = [...pending.values()];
    pending.clear();
    if (keys.length > 0) onFlush(keys);
  };

  return {
    schedule(key: T) {
      pending.set(JSON.stringify(key), key);
      const at = now();
      if (firstQueuedAt === 0) firstQueuedAt = at;
      // The remaining budget caps the restarted timer, which is what stops a continuous stream
      // from pushing the flush past `maxWaitMs`.
      const remainingBudget = Math.max(0, maxWaitMs - (at - firstQueuedAt));
      const delay = Math.min(waitMs, remainingBudget);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, delay);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
      firstQueuedAt = 0;
    },
  };
}
