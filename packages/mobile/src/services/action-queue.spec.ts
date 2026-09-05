/**
 * The action queue is what stands between a check-in or an expense claim and the field
 * connection that carries it. The failures under test are the ones that quietly lose or
 * duplicate an assayer's action: a retry after a lost response filing a second expense claim, and
 * a validation failure being retried forever instead of being shown once and dropped.
 */

jest.mock('./token-store', () => {
  const store: Record<string, unknown> = {};
  return {
    __store: store,
    readCache: jest.fn(async (key: string) => (key in store ? store[key] : null)),
    writeCache: jest.fn(async (key: string, value: unknown) => {
      store[key] = JSON.parse(JSON.stringify(value));
    }),
  };
});

import {
  enqueueAction,
  enqueueAndRun,
  getQueuedActions,
  processActionQueue,
  dismissAction,
  clearActionQueue,
  generateClientRequestId,
  isRetryableStatus,
  __resetActionQueueForTests,
  ActionDispatcher,
} from './action-queue';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const tokenStore = require('./token-store') as { __store: Record<string, unknown> };

beforeEach(() => {
  for (const key of Object.keys(tokenStore.__store)) delete tokenStore.__store[key];
  __resetActionQueueForTests();
});

describe('generateClientRequestId', () => {
  it('produces a v4-shaped id, and a different one each time', () => {
    const a = generateClientRequestId();
    const b = generateClientRequestId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});

describe('enqueueing', () => {
  it('writes an action down as PENDING with a clientRequestId, and it survives a restart', async () => {
    await enqueueAction('EXPENSE_CLAIM', { amount: 500 });
    __resetActionQueueForTests();
    const [entry] = await getQueuedActions();
    expect(entry.status).toBe('PENDING');
    expect(entry.clientRequestId).toBeTruthy();
  });
});

describe('enqueueAndRun', () => {
  it('runs immediately, and clears the queue on success', async () => {
    const dispatch: ActionDispatcher = jest.fn(async () => ({ success: true }));
    const result = await enqueueAndRun('CHECK_IN', { lat: 1, lng: 2 }, dispatch);
    expect(result).toEqual({ success: true, queued: false });
    expect(await getQueuedActions()).toHaveLength(0);
  });

  /**
   * The contract the backend keys idempotency on: the same clientRequestId must be sent on
   * every attempt for the same logical action, so a retry after a lost response is recognised
   * as the request that already landed rather than filed as a second claim.
   */
  it('sends the same clientRequestId to the dispatcher every attempt', async () => {
    const seen: string[] = [];
    const flaky: ActionDispatcher = jest.fn(async (_payload, clientRequestId) => {
      seen.push(clientRequestId);
      return seen.length === 1
        ? { success: false, error: 'timeout', retryable: true }
        : { success: true };
    });

    await enqueueAndRun('EXPENSE_CLAIM', { amount: 500 }, flaky);
    await processActionQueue({ EXPENSE_CLAIM: flaky });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it('a retryable (transport) failure is left queued, not surfaced as final', async () => {
    const dispatch: ActionDispatcher = jest.fn(async () => {
      throw new Error('Network request failed');
    });
    const result = await enqueueAndRun('CHECK_OUT', { lat: 1, lng: 2 }, dispatch);
    expect(result.queued).toBe(true);
    expect((await getQueuedActions())[0].status).toBe('RETRYING');
  });

  /**
   * A validation 4xx ("claim is over the single-claim limit") fails the same way every time.
   * Retrying it silently would leave the assayer thinking a rejected request was still trying,
   * so it is surfaced once and taken off the queue rather than requeued.
   */
  it('a non-retryable failure is surfaced and removed, not requeued', async () => {
    const dispatch: ActionDispatcher = jest.fn(async () => ({
      success: false,
      error: 'Claim is over the single-claim limit',
      retryable: false,
    }));
    const result = await enqueueAndRun('EXPENSE_CLAIM', { amount: 90_000 }, dispatch);
    expect(result).toEqual({
      success: false,
      error: 'Claim is over the single-claim limit',
      retryable: false,
      queued: false,
    });
    expect(await getQueuedActions()).toHaveLength(0);
  });
});

describe('isRetryableStatus', () => {
  it('treats a 4xx refusal as terminal — including the 400 an old build gets for a legacy counter-offer transition', () => {
    // Fee negotiation was removed server-side: a COUNTER_OFFER transition from a build that
    // still ships one is answered with a plain 400. That answer must land as a terminal,
    // shown-once failure — retrying a refusal can only be refused identically again.
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(409)).toBe(false);
  });

  it('retries only what might genuinely go differently next time', () => {
    expect(isRetryableStatus(undefined)).toBe(true); // never reached the server
    expect(isRetryableStatus(429)).toBe(true); // the server's own "try again"
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
  });
});

describe('processActionQueue', () => {
  it('retries a RETRYING action on the next drain and clears it once it lands', async () => {
    const dispatch: ActionDispatcher = jest.fn(async () => {
      throw new Error('timeout');
    });
    await enqueueAndRun('CHECK_IN', { lat: 1, lng: 2 }, dispatch);
    expect((await getQueuedActions())[0].status).toBe('RETRYING');

    const ok: ActionDispatcher = jest.fn(async () => ({ success: true }));
    await processActionQueue({ CHECK_IN: ok });

    expect(ok).toHaveBeenCalledTimes(1);
    expect(await getQueuedActions()).toHaveLength(0);
  });

  it('leaves a kind with no registered dispatcher untouched', async () => {
    await enqueueAction('QUERY_MESSAGE', { body: 'hi' });
    await processActionQueue({});
    expect((await getQueuedActions())[0].status).toBe('PENDING');
  });

  it('does not run two drains at the same time', async () => {
    await enqueueAction('CHECK_IN', { lat: 1, lng: 2 });
    let release: (v: { success: true }) => void = () => {};
    const slow: ActionDispatcher = jest.fn(
      () => new Promise((res) => { release = res; }),
    ) as any;

    const first = processActionQueue({ CHECK_IN: slow });
    await new Promise((r) => setTimeout(r, 0));
    expect(slow).toHaveBeenCalledTimes(1);

    await processActionQueue({ CHECK_IN: slow });
    expect(slow).toHaveBeenCalledTimes(1);

    release({ success: true });
    await first;
  });
});

describe('dismiss and sign-out', () => {
  it('dismiss removes an action from the queue', async () => {
    const entry = await enqueueAction('CHECK_IN', { lat: 1, lng: 2 });
    await dismissAction(entry.id);
    expect(await getQueuedActions()).toHaveLength(0);
  });

  it('sign-out empties the queue so no action fires under another login', async () => {
    await enqueueAction('CHECK_IN', { lat: 1, lng: 2 });
    await clearActionQueue();
    expect(await getQueuedActions()).toHaveLength(0);
  });
});
