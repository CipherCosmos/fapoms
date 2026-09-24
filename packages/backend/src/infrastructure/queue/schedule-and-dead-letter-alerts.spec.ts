import { Logger } from '@nestjs/common';
import { convergeOnce, reconcile } from './repeatable-schedules';
import { JobFailureMonitor } from './job-failure.monitor';

/**
 * Background faults that used to end in a log line now reach the alerter, and a schedule nothing
 * wants any more is removed rather than left firing into a handler that no longer exists.
 */
const quietLogger = () => {
  const l = new Logger('test');
  jest.spyOn(l, 'warn').mockImplementation(() => undefined);
  jest.spyOn(l, 'log').mockImplementation(() => undefined);
  return l;
};

const fakeQueue = (existing: Array<{ name: string; cron: string; key: string; id?: string | null; tz?: string }>) => ({
  name: 'q',
  getRepeatableJobs: jest.fn(async () => [...existing]),
  removeRepeatableByKey: jest.fn(async () => undefined),
  add: jest.fn(async () => ({})),
});

describe('convergeOnce', () => {
  it('removes a schedule whose job is no longer wanted at all', async () => {
    const q = fakeQueue([
      { name: 'scan', cron: '*/15 * * * *', key: 'k-scan' },
      { name: 'retired-job', cron: '0 * * * *', key: 'k-retired' },
    ]);
    await convergeOnce(q as any, [{ name: 'scan', cron: '*/15 * * * *' }], quietLogger());
    expect(q.removeRepeatableByKey).toHaveBeenCalledWith('k-retired');
    expect(q.removeRepeatableByKey).not.toHaveBeenCalledWith('k-scan');
  });

  it('still removes a drifted cron of a wanted job', async () => {
    const q = fakeQueue([{ name: 'scan', cron: '*/5 * * * *', key: 'k-old' }]);
    await convergeOnce(q as any, [{ name: 'scan', cron: '*/15 * * * *' }], quietLogger());
    expect(q.removeRepeatableByKey).toHaveBeenCalledWith('k-old');
  });
});

describe('reconcile', () => {
  it('alerts when a wanted schedule had vanished', async () => {
    const q = fakeQueue([]);
    const report = jest.fn();
    await reconcile(q as any, [{ name: 'drain', cron: '* * * * *' }], quietLogger(), { report });
    expect(report).toHaveBeenCalledWith({ method: 'SCHEDULE', route: '/q/drain', errorName: 'ScheduleVanished' });
  });

  it('stays quiet when everything is registered', async () => {
    const q = fakeQueue([{ name: 'drain', cron: '* * * * *', key: 'k' }]);
    const report = jest.fn();
    await reconcile(q as any, [{ name: 'drain', cron: '* * * * *' }], quietLogger(), { report });
    expect(report).not.toHaveBeenCalled();
  });
});

describe('JobFailureMonitor', () => {
  it('reports a dead-lettered job through the alerter, not only the log', () => {
    const handlers: Record<string, (...a: any[]) => void> = {};
    const queue = { on: (ev: string, cb: any) => { handlers[ev] = cb; } };
    const moduleRef = { get: jest.fn((token: string) => (String(token).includes('outbound-email') ? queue : undefined)) };
    const monitor = new JobFailureMonitor(moduleRef as any, { jobsFailed: { inc: jest.fn() } } as any);
    const report = jest.fn();
    monitor.alerter = { report };
    jest.spyOn((monitor as any).logger, 'error').mockImplementation(() => undefined);
    monitor.onModuleInit();

    handlers.failed({ name: 'send', id: '1', attemptsMade: 1, opts: { attempts: 3 } }, new Error('x'));
    expect(report).not.toHaveBeenCalled(); // will retry — not dead yet
    handlers.failed({ name: 'send', id: '1', attemptsMade: 3, opts: { attempts: 3 } }, new Error('x'));
    expect(report).toHaveBeenCalledWith({ method: 'QUEUE', route: '/outbound-email/send', errorName: 'DeadLetter' });
  });
});
