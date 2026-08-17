/**
 * How long a request may stay in flight, and the one way to enforce it.
 *
 * This lives in its own module rather than in `api.ts` for a concrete reason: `api.ts` imports
 * `clearSession` from `session.ts`, and `session.ts` needs the timeout helper for its logout call.
 * Putting the helper in `api.ts` would close that loop into a cycle which happens to work today
 * (both sides are used at call time, not module-init time) and breaks the moment either file grows
 * a top-level statement that touches the other. A leaf module both can depend on has no such edge.
 *
 * It also gives the budgets a single home. They were previously private to the API client, which
 * is exactly why the four direct-`fetch` call sites listed on `fetchWithTimeout` below never got
 * them.
 */

/**
 * How long any single call may stay in flight before it is given up on.
 *
 * `fetch` has no timeout of its own: a request that reaches a stalled proxy, a backend mid-restart
 * or a Wi-Fi network that accepted the connection and then went quiet simply never settles. React
 * Query keeps that query in `isFetching` for as long as the tab is open, so the screen shows a
 * spinner that will never resolve and a retry that will never fire, and — because the browser caps
 * concurrent connections per origin — six of those are enough to wedge every other request on the
 * page behind them.
 *
 * Thirty seconds is well past any healthy response on this system (the slowest aggregate the desk
 * loads answers in single-digit seconds) and well short of an operator deciding the app is broken.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The exceptions to that budget: work whose size, not the network, decides how long it takes.
 *
 * A document upload is a FormData body of several megabytes over an office uplink, and the Excel
 * report endpoints stream a workbook the server is still generating. Both routinely and legitimately
 * run past thirty seconds, and aborting one loses real work, so they get a much longer leash rather
 * than an exemption — a stuck upload still has to end eventually.
 */
export const LONG_TIMEOUT_MS = 180_000;

/**
 * `fetch` with a deadline, for the calls that legitimately cannot go through `ApiClient`.
 *
 * Four call sites in this app talk to `fetch` directly, and every one of them had no timeout at
 * all until now — the API client was hardened while they were left behind, which is the usual way
 * a "we have timeouts" claim turns out to be false in practice:
 *
 *  - `pages/Login.tsx` — runs *before* there is a session, so it cannot use the client's
 *    401→refresh path. A stall here left the Sign In button spinning forever with no error and no
 *    way back; it is the first screen anyone sees.
 *  - `services/session.ts` (`endSession`) — a stall meant `clearSession()` in its `finally` never
 *    ran, so pressing Sign Out neither signed you out nor told you why.
 *  - `pages/hr/AssayerForms.tsx` — a THIRD-PARTY host (api.postalpincode.in) that we do not
 *    operate and cannot page anyone about, awaited inline from the form's submit handler.
 *  - `pages/Documents.tsx` — the presigned PUT goes straight to object storage, not our API, so
 *    the client's budget never covered it either.
 *
 * Why the API client does not simply call this: its budget deliberately spans *two* fetches (the
 * original plus the one retried after a token refresh) so a refresh cannot silently double the
 * wait. That is a different lifetime from "one fetch, one deadline", and collapsing the two would
 * either break the refresh case or over-complicate this. The timeout *values* are shared, which is
 * the part that must not drift.
 *
 * Deliberately NOT added here: mobile's GET/HEAD retry loop. Mobile needs it because it has no
 * React Query; this app configures `retry: 1` on the QueryClient (src/queryClient.ts), so reads
 * are already retried once at a layer that knows about caching and cancellation. Adding a second
 * loop underneath would multiply rather than replace — 2 in-client attempts × 2 React Query
 * attempts = up to 4 round trips for one stalled read, turning a 30s wait into two minutes. The
 * two direct callers that are mutations (login, logout) must not be retried at all.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const timeoutMs = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const callerSignal = init?.signal ?? undefined;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError')),
    timeoutMs,
  );
  // Composed by hand rather than with `AbortSignal.any`, matching the API client: some desks are
  // still on Chromium builds that do not ship it.
  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) forwardAbort();
    else callerSignal.addEventListener('abort', forwardAbort, { once: true });
  }
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    // Cleared on the failure path too, or a long-lived tab accumulates one pending timer per
    // request it ever made.
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardAbort);
  }
}
