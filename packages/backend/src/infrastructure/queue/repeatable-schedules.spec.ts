import { Logger } from '@nestjs/common';
import { ensureRepeatableSchedules } from './repeatable-schedules';

/**
 * A CRON THAT STOPS FIRING MUST NOT DO IT IN SILENCE.
 *
 * Bull schedules the next firing of a repeatable job only while its `bull:<queue>:repeat` member
 * still exists. If that key goes — a Redis restart without persistence, an eviction, somebody's
 * `FLUSHALL` — the job stops for ever and Bull reports nothing, because from its point of view
 * there is no schedule to run.
 *
 * Observed on a real deployment: nine minutes with no cron of any kind. `audit-seal` fired once
 * and stopped, the outbox sat undispatched across three tick boundaries, 134 audit events went
 * unsealed — while `/health` said ok, the worker stayed healthy, ordinary Bull jobs kept
 * succeeding and nothing was logged. The convergence ran once at boot and never looked again.
 *
 * The outbox is what books payables, so the failure mode is money quietly not being booked. That
 * is why this is checked repeatedly rather than trusted once, and why a re-registration is
 * announced rather than performed quietly: a fault that heals itself in silence is a fault nobody
 * ever fixes.
 *
 * Times are faked throughout. A test that waited five real minutes for an interval would be a test
 * nobody runs.
 */
describe('repeatable schedules keep being checked, and say when one had vanished', () => {
  const WANTED = [{ name: 'drain', cron: '* * * * *' }];

  /** A Bull queue double whose repeatable set can be emptied out from under the caller. */
  function fakeQueue(name = 'outbox') {
    const repeatables: Array<{ name: string; cron: string; key: string; id?: string | null }> = [];
    return {
      name,
      repeatables,
      getRepeatableJobs: jest.fn(async () => [...repeatables]),
      removeRepeatableByKey: jest.fn(async (key: string) => {
        const at = repeatables.findIndex((r) => r.key === key);
        if (at >= 0) repeatables.splice(at, 1);
      }),
      add: jest.fn(async (jobName: string, _data: unknown, opts: any) => {
        const cron = opts?.repeat?.cron;
        if (!repeatables.some((r) => r.name === jobName && r.cron === cron)) {
          repeatables.push({ name: jobName, cron, key: `${jobName}:${cron}`, id: opts?.jobId ?? null });
        }
      }),
    };
  }

  let warn: jest.SpyInstance;
  let logger: Logger;

  beforeEach(() => {
    jest.useFakeTimers();
    logger = new Logger('test');
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    warn.mockRestore();
  });

  /** Let the fire-and-forget convergence settle without advancing the interval. */
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  it('registers the wanted schedule at boot', async () => {
    const queue = fakeQueue();
    ensureRepeatableSchedules(queue as never, WANTED, logger, { reconcileIntervalMs: 0 });
    await settle();
    expect(queue.repeatables.map((r) => r.name)).toEqual(['drain']);
  });

  it('puts back a schedule that disappeared, and says so', async () => {
    const queue = fakeQueue();
    ensureRepeatableSchedules(queue as never, WANTED, logger, { reconcileIntervalMs: 60_000 });
    await settle();
    expect(queue.repeatables).toHaveLength(1);
    warn.mockClear();

    // Exactly what a Redis restart without persistence does: the key is gone and nothing says so.
    queue.repeatables.length = 0;

    jest.advanceTimersByTime(60_000);
    await settle();

    expect(queue.repeatables.map((r) => r.name)).toEqual(['drain']);
    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toMatch(/had disappeared/i);
    expect(said).toContain('outbox');
    expect(said).toContain('drain');
  });

  it('stays quiet on a pass that finds nothing wrong', async () => {
    // This runs every five minutes on every queue in the process. A line per pass would bury the
    // one line that matters.
    const queue = fakeQueue();
    ensureRepeatableSchedules(queue as never, WANTED, logger, { reconcileIntervalMs: 60_000 });
    await settle();
    warn.mockClear();

    jest.advanceTimersByTime(60_000 * 5);
    await settle();

    expect(warn).not.toHaveBeenCalled();
    expect(queue.repeatables).toHaveLength(1);
  });

  it('keeps checking after a pass that could not reach Redis', async () => {
    // A timer that dies on the first error is worse than no timer: the schedule is then gone AND
    // nothing is watching for it.
    const queue = fakeQueue();
    ensureRepeatableSchedules(queue as never, WANTED, logger, { reconcileIntervalMs: 60_000 });
    await settle();
    warn.mockClear();

    queue.getRepeatableJobs.mockRejectedValueOnce(new Error('Redis unavailable'));
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/could not re-check/i);

    // And the next pass still works.
    warn.mockClear();
    queue.repeatables.length = 0;
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(queue.repeatables.map((r) => r.name)).toEqual(['drain']);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/had disappeared/i);
  });

  it('never holds the process open just to re-check a cron', async () => {
    // The interval outlives every request; if it kept the event loop alive, a SIGTERM would hang
    // until the grace period killed it.
    const unref = jest.fn();
    const realSetInterval = global.setInterval;
    const spy = jest.spyOn(global, 'setInterval').mockImplementation(((fn: any, ms: any) => {
      const t = realSetInterval(fn, ms);
      (t as unknown as { unref: () => void }).unref = unref;
      return t;
    }) as never);
    try {
      ensureRepeatableSchedules(fakeQueue() as never, WANTED, logger, { reconcileIntervalMs: 60_000 });
      await settle();
      expect(unref).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('can be switched off, which is the only way a test can assert one convergence', async () => {
    const queue = fakeQueue();
    ensureRepeatableSchedules(queue as never, WANTED, logger, { reconcileIntervalMs: 0 });
    await settle();
    queue.getRepeatableJobs.mockClear();

    jest.advanceTimersByTime(60_000 * 60);
    await settle();

    expect(queue.getRepeatableJobs).not.toHaveBeenCalled();
  });
});
