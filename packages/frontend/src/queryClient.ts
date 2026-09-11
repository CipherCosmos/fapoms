import { QueryClient } from '@tanstack/react-query';
import { AppError } from './services/errors';

/**
 * Which failures are worth asking for a second time — and why getting this wrong drew a refusal
 * as a confident zero.
 *
 * ## The defect this closes
 *
 * A custom role with no `SCHEDULING` grant opens `/scheduling`. `GET /schedules` answers 403.
 * `api.ts` throws an `AppError`, exactly as intended. The page has a guard for precisely this
 * ("a failed load must not masquerade as an empty calendar"). It never fired, and the screen
 * reported "0 active schedules · 0 unscheduled confirmed offers", a full calendar, and "No audits
 * scheduled for this date" — five confident, specific, wrong statements on the screen whose whole
 * job is to say what work exists.
 *
 * The mechanism is in TanStack Query's retryer, and it is not obvious. On a failure it does:
 *
 * ```js
 * failureCount++;                                  // fetchFailureCount, NOT an error yet
 * sleep(delay).then(() => canContinue() ? undefined : pause())
 * ```
 *
 * and `canContinue()` is
 *
 * ```js
 * () => focusManager.isFocused() && (networkMode === 'always' || onlineManager.isOnline()) && ...
 * ```
 *
 * `focusManager.isFocused()` is `document.visibilityState !== 'hidden'`. So a query that fails and
 * is due a retry **pauses** — rather than erroring — whenever the tab is not visible. A paused
 * query sits at `status: 'pending'`, `fetchStatus: 'paused'`, `error: null`, `data: undefined`,
 * indefinitely. Therefore `isError` is false, `isLoading` is false (`isPending && isFetching`, and
 * a paused query is not fetching), and every `const { data = [] } = useQuery(...)` in this app
 * renders the refusal as an empty list. Measured live on `/scheduling` as a custom role:
 * `fetchFailureCount: 1`, `fetchFailureReason: "AppError: You do not have permission…"`,
 * `errorUpdateCount: 0`.
 *
 * Note what this is NOT: not a retry window, not a swallowed throw, not a suppressed banner. The
 * error was raised correctly and then withheld from the component by the retry scheduler.
 *
 * ## Why the fix is here
 *
 * Only a RETRY can pause — `canStart()` checks the network but never the focus, so a first attempt
 * always runs. So a failure that is never retried can never pause, and settles into `status:
 * 'error'` immediately, where every page's existing guard already handles it.
 *
 * And a 403 was never going to succeed on a second ask. Neither is a 404, a 400, or a 422: those
 * are the server's definite answer about THIS request, not a hiccup between us and it. Asking
 * again costs a round trip, delays the honest message by the backoff, and — as above — can replace
 * the message with silence. The retry is kept for the failures that genuinely might go the other
 * way next time: nothing reached the server (no status at all), or the server itself fell over
 * (5xx).
 *
 * 429 is deliberately NOT retried here despite being transient. The login throttle answers
 * `Retry-After: 20-26s` and this retryer's first backoff is one second, so retrying inside React
 * Query cannot clear the window — it only spends the budget and adds load. "Too many requests,
 * pause a moment" is the honest thing to put on screen.
 */
const RETRYABLE_STATUS = (status: number) => status >= 500 && status <= 599;

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  if (error instanceof AppError) {
    // No status means the request never got an answer — a dropped connection or our own timeout.
    // That is the case a retry exists for.
    if (error.status === undefined) return true;
    return RETRYABLE_STATUS(error.status);
  }
  // Anything not raised by the API client is unclassified; allow the single retry it used to get
  // rather than changing behaviour for code paths this policy was not written against. The
  // `loadFailed` guard below is what stops such a case rendering as data if it does pause.
  return true;
}

/**
 * Has this query stopped being able to produce data on its own?
 *
 * `isError` alone is not the whole question, and the gap is the one described above: a query that
 * fails and pauses is neither erroring nor loading nor holding data. Every list surface in this app
 * defaults `data` to `[]` or `0`, so a state this predicate misses is a state the operator reads as
 * "there is no work today".
 *
 * The paused arm stays deliberately narrow — `data === undefined`. A paused REFETCH sitting on top
 * of data that loaded fine is not a failure; the screen is showing real, if slightly stale, rows
 * and will refresh itself when the tab comes forward. It is only a paused query with nothing behind
 * it that is drawing a lie.
 *
 * Pass the whole `useQuery` result, not a destructured `data = []` — the default is what hides the
 * `undefined` this reads.
 */
export function loadFailed(result: {
  isError: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  data: unknown;
}): boolean {
  return result.isError || (result.fetchStatus === 'paused' && result.data === undefined);
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: shouldRetryQuery,
      staleTime: 5 * 60 * 1000,
    },
    // Mutations are deliberately left on the library default of no retry. Re-sending a POST whose
    // answer we never saw is how one approval becomes two: the request may well have succeeded on
    // the server before the connection dropped. They cannot pause on a retry that never happens.
  },
});
