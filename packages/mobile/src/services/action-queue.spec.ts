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
  setActionQueueOwner,
  adoptUnownedActions,
  toSubmitOutcome,
  NOT_SIGNED_IN_ERROR,
} from './action-queue';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const tokenStore = require('./token-store') as { __store: Record<string, unknown> };

const ASSAYER_A = 'assayer-a';
const ASSAYER_B = 'assayer-b';

beforeEach(() => {
  for (const key of Object.keys(tokenStore.__store)) delete tokenStore.__store[key];
  __resetActionQueueForTests();
  setActionQueueOwner(ASSAYER_A);
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

  it('stamps every action with the signed-in user who filed it', async () => {
    const entry = await enqueueAction('CHECK_IN', { lat: 1, lng: 2 });
    expect(entry.ownerId).toBe(ASSAYER_A);
  });

  it('refuses to file an action when nobody is signed in', async () => {
    setActionQueueOwner(null);
    await expect(enqueueAction('CHECK_IN', { lat: 1, lng: 2 })).rejects.toThrow(NOT_SIGNED_IN_ERROR);
    const dispatch: ActionDispatcher = jest.fn(async () => ({ success: true }));
    const result = await enqueueAndRun('CHECK_IN', { lat: 1, lng: 2 }, dispatch);
    expect(result).toMatchObject({ success: false, queued: false });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await getQueuedActions()).toHaveLength(0);
  });

  it('uses a key the caller supplies, so one form keeps one key', async () => {
    const entry = await enqueueAction('EXPENSE_CLAIM', { amount: 500 }, { clientRequestId: 'form-key-1' });
    expect(entry.clientRequestId).toBe('form-key-1');
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

/**
 * Offline presses must not multiply. A claim or offer reply that could not be sent is on the
 * phone and will send itself; a second press on the same form (or a second Accept on the same
 * offer) used to file a second copy with a fresh key, which the server could not recognise.
 */
describe('duplicate presses while an action is waiting', () => {
  const offline: ActionDispatcher = async () => {
    throw new Error('Network request failed');
  };

  it('a second press with the same form key reuses the waiting action, not a second copy', async () => {
    const seen: string[] = [];
    const recording: ActionDispatcher = async (_p, key) => {
      seen.push(key);
      throw new Error('Network request failed');
    };
    await enqueueAndRun('EXPENSE_CLAIM', { amount: 500 }, recording, { clientRequestId: 'form-key-1' });
    await enqueueAndRun('EXPENSE_CLAIM', { amount: 500 }, recording, { clientRequestId: 'form-key-1' });

    const queued = await getQueuedActions();
    expect(queued).toHaveLength(1);
    expect(queued[0].clientRequestId).toBe('form-key-1');
    // Retried with the same key both times: that is what the server dedupes on.
    expect(seen).toEqual(['form-key-1', 'form-key-1']);
  });

  it('a second Accept on an offer whose accept is waiting reuses it (sameAs)', async () => {
    const sameOffer = (a: any) => a.payload.assignmentId === 'job-1' && a.payload.status === 'ACCEPTED';
    await enqueueAndRun('ASSIGNMENT_STATUS', { op: 'transition', assignmentId: 'job-1', status: 'ACCEPTED' }, offline, { sameAs: sameOffer });
    await enqueueAndRun('ASSIGNMENT_STATUS', { op: 'transition', assignmentId: 'job-1', status: 'ACCEPTED' }, offline, { sameAs: sameOffer });
    expect(await getQueuedActions()).toHaveLength(1);
  });

  it('different forms (different keys) are different actions', async () => {
    await enqueueAndRun('EXPENSE_CLAIM', { amount: 500 }, offline, { clientRequestId: 'form-key-1' });
    await enqueueAndRun('EXPENSE_CLAIM', { amount: 500 }, offline, { clientRequestId: 'form-key-2' });
    expect(await getQueuedActions()).toHaveLength(2);
  });

  it('an action already on the wire is not sent a second time by another press', async () => {
    let release: (v: { success: true }) => void = () => {};
    const slow: ActionDispatcher = jest.fn(() => new Promise((res) => { release = res; })) as any;
    const first = enqueueAndRun('EXPENSE_CLAIM', { amount: 500 }, slow, { clientRequestId: 'k' });
    await new Promise((r) => setTimeout(r, 0));

    const second = await enqueueAndRun('EXPENSE_CLAIM', { amount: 500 }, slow, { clientRequestId: 'k' });
    expect(second.queued).toBe(true);
    expect(slow).toHaveBeenCalledTimes(1);

    release({ success: true });
    await first;
    expect(await getQueuedActions()).toHaveLength(0);
  });
});

describe('toSubmitOutcome', () => {
  it('reports a queued action as a success the screen can close on, marked queued', () => {
    expect(toSubmitOutcome({ success: false, retryable: true, error: 'timeout', queued: true })).toEqual({
      success: true,
      queued: true,
    });
  });

  it('passes a real refusal through, with a fallback when the server said nothing', () => {
    expect(toSubmitOutcome({ success: false, retryable: false, error: 'Over the limit', code: 'X', queued: false })).toEqual({
      success: false,
      queued: false,
      error: 'Over the limit',
      code: 'X',
    });
    expect(toSubmitOutcome({ success: false, queued: false }, 'Failed')).toMatchObject({ success: false, error: 'Failed' });
  });

  it('a sent action is a plain success', () => {
    expect(toSubmitOutcome({ success: true, queued: false })).toEqual({ success: true, queued: false });
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

  /**
   * The defect: sign-out never cleared this queue (its in-memory copy outlived even a deleted
   * file), so A's check-in went out under B's session. Sign-out now clears it — and even a session
   * that ends without a sign-out cannot leak: the queue refuses anything B did not file.
   */
  it("never sends another user's action — it is dropped on the next drain", async () => {
    await enqueueAction('CHECK_IN', { lat: 1, lng: 2 });
    setActionQueueOwner(ASSAYER_B);
    const dispatch: ActionDispatcher = jest.fn(async () => ({ success: true }));
    await processActionQueue({ CHECK_IN: dispatch });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await getQueuedActions()).toHaveLength(0);
  });

  it('a drain with nobody signed in sends nothing and drops nothing', async () => {
    await enqueueAction('CHECK_IN', { lat: 1, lng: 2 });
    setActionQueueOwner(null);
    const dispatch: ActionDispatcher = jest.fn(async () => ({ success: true }));
    await processActionQueue({ CHECK_IN: dispatch });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await getQueuedActions()).toHaveLength(1);
  });

  it('an action is not sent if the account changed while an earlier one was on the wire', async () => {
    await enqueueAction('CHECK_IN', { n: 1 });
    await enqueueAction('CHECK_IN', { n: 2 });
    const sent: number[] = [];
    const dispatch: ActionDispatcher = jest.fn(async (p: any) => {
      sent.push(p.n);
      setActionQueueOwner(ASSAYER_B); // the account switches mid-drain
      return { success: true };
    });
    await processActionQueue({ CHECK_IN: dispatch });
    expect(sent).toEqual([1]);
  });

  it('entries from before actions carried an owner are adopted only when asked', async () => {
    tokenStore.__store.action_queue = [
      { id: 'old', kind: 'CHECK_IN', payload: {}, clientRequestId: 'k', status: 'PENDING', createdAt: '', updatedAt: '' },
    ];
    __resetActionQueueForTests();
    setActionQueueOwner(ASSAYER_A);
    await adoptUnownedActions(ASSAYER_A);
    const dispatch: ActionDispatcher = jest.fn(async () => ({ success: true }));
    await processActionQueue({ CHECK_IN: dispatch });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('an unowned legacy entry is refused, not sent, on a fresh sign-in', async () => {
    tokenStore.__store.action_queue = [
      { id: 'old', kind: 'CHECK_IN', payload: {}, clientRequestId: 'k', status: 'PENDING', createdAt: '', updatedAt: '' },
    ];
    __resetActionQueueForTests();
    setActionQueueOwner(ASSAYER_B);
    const dispatch: ActionDispatcher = jest.fn(async () => ({ success: true }));
    await processActionQueue({ CHECK_IN: dispatch });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await getQueuedActions()).toHaveLength(0);
  });
});
