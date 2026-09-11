import React from 'react';
import { AlertBanner } from './ui';
import { loadFailed } from '../queryClient';
import { classifyError, userMessage } from '../services/errors';

/**
 * The banner a screen shows instead of drawing a refused fetch as an empty list.
 *
 * Every list surface in this app defaults its data to `[]` or `0`, so the difference between "there
 * is no work today" and "you were not allowed to ask" is one `isError` check per page — written by
 * hand, differently, on each of them. Three ways that went wrong, all measured:
 *
 *  - `/scheduling` checked `isError` and it was never true (see `loadFailed` in queryClient.ts),
 *    so a 403 rendered as "0 active schedules", a full calendar and "No audits scheduled".
 *  - `/hr` did fire, and said "An unknown problem occurred. Please try again." — honest that
 *    something failed, wrong about what, and it offered a retry that could only fail identically.
 *  - `/billing` and `/documents` drew full chrome and no data, silently.
 *
 * So this component owns three decisions the pages kept getting differently:
 *
 * 1. **What counts as failed** — `loadFailed`, which includes the paused-with-no-data state that
 *    plain `isError` misses.
 * 2. **What to say** — the error's own sentence. A permission denial says so; it does not say
 *    "check your connection", which sends someone to their network for a problem only an
 *    administrator can fix.
 * 3. **Whether to offer Retry** — not for a refusal or a missing record. A button whose only
 *    possible outcome is the same message again is worse than no button: it reads as "this is
 *    flaky, keep trying".
 */
export type MonitoredLoad = {
  /**
   * What could not be loaded, as a noun phrase that finishes "Could not load …" — "schedules",
   * "the unscheduled queue", "the workforce figures".
   */
  label: string;
  query: {
    isError: boolean;
    fetchStatus: 'fetching' | 'paused' | 'idle';
    data: unknown;
    error: unknown;
    /** React Query keeps the reason of a failure that has not settled into `error` yet. */
    failureReason?: unknown;
    refetch: () => unknown;
  };
};

/**
 * The same thing, for a screen that fetches with `useState` + `useEffect` rather than React Query.
 *
 * A good half of this app predates the query client: `DataEntryOverview`, `ExpenseReview`,
 * `Branches`, `Holidays` and others hold their rows in state and their failures in a `catch`.
 * Those screens still owe the reader the same four states, and they should owe them through this
 * component rather than through a private red `<div>` each — that divergence is the defect.
 *
 * So this adapts a caught error into the shape `LoadFailure` reads. Pass the error you caught and
 * the function that would try again; pass `null` and the load is simply not failing.
 *
 * It is deliberately NOT a way to opt out of `loadFailed`. There is no paused state to miss here:
 * a promise either resolved or it threw, and the screen knows which.
 */
export function caughtLoad(error: unknown, refetch: () => unknown): MonitoredLoad['query'] {
  return { isError: error != null, fetchStatus: 'idle', data: undefined, error, refetch };
}

/** The error to describe: the settled one, or the one a paused retry is sitting on. */
function reasonOf(query: MonitoredLoad['query']): unknown {
  return query.error ?? query.failureReason ?? null;
}

export const LoadFailure: React.FC<{
  loads: MonitoredLoad[];
  style?: React.CSSProperties;
}> = ({ loads, style }) => {
  const failed = loads.filter((l) => loadFailed(l.query));
  if (failed.length === 0) return null;

  const reasons = failed.map((l) => reasonOf(l.query));
  const refused = reasons.some((r) => r !== null && classifyError(r).category === 'permission-required');
  /**
   * Nothing has been tried yet.
   *
   * A query pauses before its FIRST attempt when the browser reports itself offline, so there is no
   * error to quote. Left to the generic path this became "An unknown problem occurred", which is
   * the least useful true sentence available — the problem is known and is the network.
   */
  const untried = reasons.every((r) => r === null);
  // Retry is offered only where it could change the answer. `classifyError` reports a 403 or a 404
  // as non-retryable; a dropped connection, a timeout and a 5xx as retryable.
  const canRetry = !refused && !untried && reasons.some((r) => classifyError(r).isRetryable);

  const what = failed.map((l) => l.label).join(' or ');
  // One sentence for the cause, taken from the first failure rather than invented here. Where two
  // loads failed for the same reason (the usual case — one role, one refusal) they carry the same
  // sentence anyway.
  const why = untried
    ? 'Your browser is reporting no network connection. This will load by itself once the connection is back.'
    : userMessage(reasons.find((r) => r !== null) ?? reasons[0]);

  return (
    <AlertBanner type="error" style={style}>
      <span style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span>
          <strong>Could not load {what}.</strong> {why}
          {refused && ' This screen is showing nothing rather than a partial or misleading view.'}
        </span>
        {canRetry && (
          <button
            onClick={() => failed.forEach((l) => { void l.query.refetch(); })}
            className="btn btn-secondary"
            style={{ padding: '3px 10px', fontSize: '11px' }}
          >
            Retry
          </button>
        )}
      </span>
    </AlertBanner>
  );
};
