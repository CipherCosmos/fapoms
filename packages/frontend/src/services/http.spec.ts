import { fetchWithTimeout, DEFAULT_TIMEOUT_MS } from './http';

/**
 * These cover the property the whole module exists for: a `fetch` that never settles must not
 * leave the caller waiting forever.
 *
 * Worth stating why this is tested at all, given the browser does the actual aborting: the bug
 * being prevented is not "AbortController is broken", it is "somebody added a direct `fetch` call
 * and forgot the timeout". Four such call sites had accumulated (login, logout, the postal-pincode
 * lookup, the presigned upload PUT) while the API client was hardened around them. A test that
 * pins the *helper's* contract is what makes reaching for the helper the cheap option.
 *
 * Fake timers are used so the suite proves the 30s budget without waiting 30s for it.
 */
describe('fetchWithTimeout', () => {
  const realFetch = (globalThis as any).fetch;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    (globalThis as any).fetch = realFetch;
  });

  /** A fetch that never resolves on its own — it settles only when its signal aborts. */
  const stalledFetch = () =>
    jest.fn((_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      }),
    );

  it('rejects once the default budget elapses rather than hanging forever', async () => {
    (globalThis as any).fetch = stalledFetch();

    const pending = fetchWithTimeout('/api/v1/auth/login', { method: 'POST' });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });

    jest.advanceTimersByTime(DEFAULT_TIMEOUT_MS);
    await assertion;
  });

  it('honours a shorter per-call budget, as the third-party pincode lookup relies on', async () => {
    (globalThis as any).fetch = stalledFetch();

    const pending = fetchWithTimeout('https://api.postalpincode.in/pincode/560001', { timeoutMs: 5_000 });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });

    jest.advanceTimersByTime(5_000);
    await assertion;
  });

  /**
   * The caller's own signal must still win. React Query hands one down to cancel superseded
   * requests, and swallowing it would turn a routine cancellation into a spurious error banner.
   */
  it('forwards an abort from the caller signal', async () => {
    (globalThis as any).fetch = stalledFetch();
    const caller = new AbortController();

    const pending = fetchWithTimeout('/api/v1/notifications', { signal: caller.signal });
    const assertion = expect(pending).rejects.toBeDefined();

    caller.abort(new DOMException('superseded', 'AbortError'));
    await assertion;
  });

  /**
   * A long-lived operations tab makes thousands of requests. If the deadline timer outlived the
   * request that armed it, every one of them would leak a pending timer.
   */
  it('clears its timer once the request settles', async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    await fetchWithTimeout('/api/v1/notifications/unread-count');

    expect(jest.getTimerCount()).toBe(0);
  });

  it('passes the response through untouched on success', async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const res = await fetchWithTimeout('/api/v1/health');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});
