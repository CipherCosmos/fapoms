import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { queryClient, shouldRetryQuery, loadFailed } from './queryClient';
import { AppError, fromResponse, fromNetwork } from './services/errors';

/**
 * The defect these hold shut, in one sentence: a refused fetch used to draw as a confident zero.
 *
 * Measured on `/scheduling` signed in as a role built in Admin → Roles with no scheduling grant.
 * `GET /schedules` answered 403; the screen said "0 active schedules · 0 unscheduled confirmed
 * offers", drew a full empty calendar, "No unscheduled confirmed offers", "0 Jobs" and "No audits
 * scheduled for this date". Five specific, confident, wrong statements, and no error anywhere in
 * the DOM — on the screen whose entire job is to say what work exists.
 *
 * The page's own guard was correct and never fired. React Query's retryer, on a failure it intends
 * to retry, does `sleep(delay).then(() => canContinue() ? undefined : pause())`, and `canContinue`
 * begins `focusManager.isFocused() && …` — which is `document.visibilityState !== 'hidden'`. So a
 * query that fails while the tab is in the background PAUSES rather than erroring, and a paused
 * query reports `status: 'pending'`, `fetchStatus: 'paused'`, `error: null`, `data: undefined`
 * indefinitely. `isError` false, `isLoading` false, `data = []` — an empty list.
 */
describe('shouldRetryQuery', () => {
  it('never asks a second time for an answer the server already gave', () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      expect(shouldRetryQuery(0, fromResponse(status, { message: 'no' }))).toBe(false);
    }
  });

  it('asks again when nothing reached the server', () => {
    // `fromNetwork` is what the API client raises for a dropped connection; a timeout raises an
    // AppError with no status the same way. Both are "we never got an answer", which is the one
    // case a retry exists for.
    expect(shouldRetryQuery(0, fromNetwork(new TypeError('Failed to fetch')))).toBe(true);
    expect(shouldRetryQuery(0, new AppError('timed out', 'Aborted after 30000ms'))).toBe(true);
  });

  it('asks again when the server itself fell over', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(shouldRetryQuery(0, fromResponse(status, {}))).toBe(true);
    }
  });

  it('asks at most once, whatever the failure', () => {
    expect(shouldRetryQuery(1, fromNetwork(new TypeError('Failed to fetch')))).toBe(false);
    expect(shouldRetryQuery(1, fromResponse(503, {}))).toBe(false);
  });

  /**
   * 429 is transient and still not retried here. The throttle answers `Retry-After: 20-26s` and
   * this retryer's first backoff is one second, so a retry inside React Query cannot clear the
   * window — it spends the budget and adds load to a service already saying stop.
   */
  it('does not retry a throttle it cannot outwait', () => {
    expect(shouldRetryQuery(0, fromResponse(429, {}))).toBe(false);
  });
});

describe('loadFailed', () => {
  const q = (over: Partial<Parameters<typeof loadFailed>[0]>) =>
    loadFailed({ isError: false, fetchStatus: 'idle', data: undefined, ...over });

  it('is true for a settled error', () => {
    expect(q({ isError: true })).toBe(true);
  });

  /**
   * The arm plain `isError` misses, and the whole reason this helper exists.
   */
  it('is true for a query paused with nothing behind it', () => {
    expect(q({ fetchStatus: 'paused', data: undefined })).toBe(true);
  });

  it('is false for a paused REFETCH sitting on data that loaded fine', () => {
    // The screen is showing real rows, slightly stale, and will refresh when the tab comes
    // forward. Calling that a failure would put a red banner over a working page.
    expect(q({ fetchStatus: 'paused', data: [{ id: 'a' }] })).toBe(false);
  });

  it('is false while a first load is still in flight', () => {
    expect(q({ fetchStatus: 'fetching', data: undefined })).toBe(false);
  });

  it('is false for a loaded, idle query — including a legitimately empty list', () => {
    expect(q({ fetchStatus: 'idle', data: [] })).toBe(false);
  });
});

/**
 * The end-to-end shape of the bug, driven through the real `queryClient` this app ships with.
 *
 * `document.visibilityState` is forced to 'hidden' because that is the condition that produced it:
 * a tab opened in the background, or switched away from while loading. Against the previous
 * configuration (`retry: 1` for everything) this test renders PAUSED and never reaches ERROR.
 */
describe('a refused fetch, in a tab that is not in front', () => {
  let restoreVisibility: (() => void) | null = null;

  beforeEach(() => {
    queryClient.clear();
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    restoreVisibility = () => {
      if (original) Object.defineProperty(Document.prototype, 'visibilityState', original);
    };
  });

  afterEach(() => {
    restoreVisibility?.();
    queryClient.clear();
  });

  const Probe: React.FC = () => {
    const result = useQuery({
      queryKey: ['probe', 'refused'],
      queryFn: () => Promise.reject(fromResponse(403, { message: 'Insufficient role permissions' })),
      // Deliberately NOT set here: the point is that the shared default governs. A page that adds
      // its own `retry: 1` opts back into the defect, which is what Scheduling.tsx used to do.
    });
    const rows: unknown[] = (result.data as unknown[]) ?? [];
    return (
      <div>
        <span data-testid="state">{result.isError ? 'ERROR' : result.fetchStatus === 'paused' ? 'PAUSED' : 'PENDING'}</span>
        <span data-testid="failed">{loadFailed(result) ? 'yes' : 'no'}</span>
        <span data-testid="count">{rows.length} rows</span>
      </div>
    );
  };

  it('settles into an error state rather than pausing where no page can see it', async () => {
    render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ERROR'), { timeout: 4000 });
    expect(screen.getByTestId('failed')).toHaveTextContent('yes');
  });

  /**
   * The regression itself. "0 rows" next to no error is the sentence the operator acted on.
   */
  it('is never a state in which the screen can honestly print a count', async () => {
    render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId('failed')).toHaveTextContent('yes'), { timeout: 4000 });
    expect(screen.getByTestId('state')).not.toHaveTextContent('PAUSED');
  });
});
