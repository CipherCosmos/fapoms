import { SlaScannerWorker } from './sla-scanner.worker';

/**
 * The scan runs one at a time cluster-wide (a Postgres advisory lock), and a tick whose phases
 * failed is reported through the alerter rather than only logged.
 */
describe('SlaScannerWorker — overlap guard and alerting', () => {
  const worker = (dataSource?: any) => {
    const w = new SlaScannerWorker(
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      undefined, dataSource,
    );
    jest.spyOn((w as any).logger, 'warn').mockImplementation(() => undefined);
    return w;
  };

  it('skips a tick while another scan holds the lock', async () => {
    const runner = {
      connect: jest.fn(), release: jest.fn(async () => undefined),
      query: jest.fn(async () => [{ ok: false }]),
    };
    const w = worker({ createQueryRunner: () => runner });
    const scanOnce = jest.spyOn(w as any, 'scanOnce').mockResolvedValue(undefined);
    await w.runScan({} as any);
    expect(scanOnce).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalled();
  });

  it('runs the scan when the lock is free', async () => {
    const runner = { connect: jest.fn(), release: jest.fn(async () => undefined), query: jest.fn(async () => [{ ok: true }]) };
    const w = worker({ createQueryRunner: () => runner });
    const scanOnce = jest.spyOn(w as any, 'scanOnce').mockResolvedValue(undefined);
    await w.runScan({} as any);
    expect(scanOnce).toHaveBeenCalledTimes(1);
  });

  it('reports a failed tick (AggregateError) through the alerter and still rethrows it', async () => {
    const w = worker();
    const report = jest.fn();
    w.alerter = { report };
    jest.spyOn(w as any, 'scanOnce').mockRejectedValue(new AggregateError([new Error('x')], 'phases failed'));
    await expect(w.runScan({} as any)).rejects.toThrow('phases failed');
    expect(report).toHaveBeenCalledWith({ method: 'JOB', route: '/sla-scanner/scan', errorName: 'AggregateError' });
  });
});
