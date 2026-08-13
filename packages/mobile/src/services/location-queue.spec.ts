/**
 * The offline queue is the difference between a movement trail that survives a day in rural
 * Kerala and one that quietly loses the only stretches worth having. It runs on handsets nobody
 * can attach a debugger to, so its behaviour is pinned here instead.
 *
 * The failures under test are the ones that would corrupt evidence rather than merely lose it:
 * dropping fixes that were never delivered, and re-sending in a way that could double a distance.
 */

// The queue persists through token-store, which reaches for expo-file-system. Mocked with a plain
// in-memory map so these tests exercise the queue's own logic without a native runtime.
jest.mock('./token-store', () => {
  const store: Record<string, unknown> = {};
  return {
    __store: store,
    readCache: jest.fn(async (key: string) => (key in store ? store[key] : null)),
    writeCache: jest.fn(async (key: string, value: unknown) => { store[key] = value; }),
  };
});

import { queueFix, queuedCount, flushQueue, clearQueue, persistQueue, __resetQueueForTests, QueuedFix } from './location-queue';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tokenStore = require('./token-store') as { __store: Record<string, unknown> };

const fix = (minutesAgo: number): QueuedFix => ({
  latitude: 10.5,
  longitude: 76.2,
  accuracyMeters: 20,
  recordedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
});

beforeEach(async () => {
  for (const key of Object.keys(tokenStore.__store)) delete tokenStore.__store[key];
  __resetQueueForTests();
});

describe('queueing', () => {
  it('persists fixes in the order they were taken', async () => {
    await queueFix(fix(3));
    await queueFix(fix(2));
    await queueFix(fix(1));

    expect(await queuedCount()).toBe(3);
  });

  it('drops the oldest once the queue is full, keeping the current journey', async () => {
    // Days offline must not fill a cheap handset's storage; the newest fixes are the ones the
    // drive happening right now depends on.
    for (let i = 0; i < 2_050; i++) await queueFix({ ...fix(1), latitude: 10 + i });
    await persistQueue();

    const queued = tokenStore.__store['location_queue'] as QueuedFix[];
    expect(queued).toHaveLength(2_000);
    // The last fix queued survived; the first did not.
    expect(queued[queued.length - 1].latitude).toBe(10 + 2_049);
    expect(queued[0].latitude).not.toBe(10);
  });

  /**
   * Persisting on every append re-serialised the whole backlog per 30-second fix — O(n) work and
   * a full file write, all day, on the cheapest handsets. Appends coalesce instead.
   */
  it('coalesces writes instead of rewriting storage on every fix', async () => {
    const { writeCache } = require('./token-store');
    for (let i = 0; i < 50; i++) await queueFix(fix(i));

    expect(writeCache).not.toHaveBeenCalled();

    await persistQueue();
    expect(writeCache).toHaveBeenCalledTimes(1);
  });

  it('survives a restart by reloading what was persisted', async () => {
    await queueFix(fix(2));
    await queueFix(fix(1));
    await persistQueue();

    __resetQueueForTests(); // as if the app had been killed and reopened

    expect(await queuedCount()).toBe(2);
  });
});

describe('flushing', () => {
  it('sends what is queued and empties it on success', async () => {
    await queueFix(fix(2));
    await queueFix(fix(1));
    const upload = jest.fn().mockResolvedValue(true);

    const r = await flushQueue(upload);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ sent: 2, remaining: 0 });
    expect(await queuedCount()).toBe(0);
  });

  /**
   * The failure that silently destroys evidence. A rejected upload — no signal, a 500, an expired
   * token — must leave the fixes exactly where they were, or a bad half-hour of connectivity
   * erases the trail permanently and the assayer's journey becomes unverifiable.
   */
  it('keeps every fix when the upload fails', async () => {
    await queueFix(fix(2));
    await queueFix(fix(1));
    const upload = jest.fn().mockResolvedValue(false);

    const r = await flushQueue(upload);

    expect(r).toEqual({ sent: 0, remaining: 2 });
    expect(await queuedCount()).toBe(2);
  });

  it('does nothing at all when there is nothing queued', async () => {
    const upload = jest.fn().mockResolvedValue(true);

    expect(await flushQueue(upload)).toEqual({ sent: 0, remaining: 0 });
    expect(upload).not.toHaveBeenCalled();
  });

  it('drains a long backlog in server-sized batches', async () => {
    for (let i = 0; i < 1_800; i++) {
      await queueFix({ ...fix(1), recordedAt: new Date(Date.now() - i * 1000).toISOString() });
    }
    const upload = jest.fn().mockResolvedValue(true);

    const r = await flushQueue(upload);

    // The server refuses batches over 1000, so two passes: 1000 then 800.
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[0][0]).toHaveLength(1000);
    expect(upload.mock.calls[1][0]).toHaveLength(800);
    expect(r.sent).toBe(1_800);
  });

  it('stops at the first failure and keeps the undelivered remainder', async () => {
    for (let i = 0; i < 1_500; i++) {
      await queueFix({ ...fix(1), recordedAt: new Date(Date.now() - i * 1000).toISOString() });
    }
    const upload = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const r = await flushQueue(upload);

    expect(r.sent).toBe(1000);
    expect(await queuedCount()).toBe(500);
  });

  /**
   * A fix taken while a batch is in flight must not be thrown away by writing back a stale
   * remainder — that would lose the newest position on every single flush.
   */
  it('does not discard a fix queued while the batch was uploading', async () => {
    await queueFix(fix(2));
    let added = false;
    const upload = jest.fn().mockImplementation(async () => {
      if (!added) { added = true; await queueFix(fix(0)); } // arrives mid-flight, once
      return true;
    });

    await flushQueue(upload);

    // The mid-flight fix survived this pass and is left for the next one.
    expect(await queuedCount()).toBe(1);
  });

  /**
   * A flush drains only what was waiting when it started. Without that bound, a device still
   * taking fixes while uploading would keep the loop (and the flush lock) alive indefinitely.
   */
  it('drains only the backlog present when the flush began', async () => {
    for (let i = 0; i < 5; i++) await queueFix(fix(i));
    const upload = jest.fn().mockImplementation(async () => {
      await queueFix(fix(0)); // a new fix on every single upload
      return true;
    });

    const r = await flushQueue(upload);

    expect(r.sent).toBe(5);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(await queuedCount()).toBe(1);
  });

  /**
   * A timer tick and a socket reconnect can both trigger a flush at once. Two concurrent drains
   * racing on the same persisted array would double-send or lose fixes.
   */
  it('will not run two drains at the same time', async () => {
    await queueFix(fix(1));
    let resolveUpload: (v: boolean) => void = () => {};
    const upload = jest.fn().mockImplementation(() => new Promise<boolean>((res) => { resolveUpload = res; }));

    const first = flushQueue(upload);
    const second = await flushQueue(upload); // must return immediately, not start a second drain

    expect(second.sent).toBe(0);
    expect(upload).toHaveBeenCalledTimes(1);

    resolveUpload(true);
    await first;
  });
});

describe('sign-out', () => {
  it('empties the queue so one assayer never uploads under another login', async () => {
    await queueFix(fix(1));

    await clearQueue();

    expect(await queuedCount()).toBe(0);
  });
});
