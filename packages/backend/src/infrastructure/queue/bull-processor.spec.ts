import 'reflect-metadata';
import { BullProcessor } from './bull-processor';

/**
 * The generic background queue dispatched nothing.
 *
 * `BullQueueManager.enqueue` adds NAMED jobs; the processor registered an unnamed `@Process()`,
 * which Bull stores under `__default__`. Bull dispatches with
 * `handlers[job.name] || handlers['*']`, so a named job matched neither and Bull failed it with
 * "Missing process handler for job type <name>" — every job, every retry, kept forever because
 * `removeOnFail` was false. These pin the two halves of the contract: the wildcard registration
 * (asserted on the decorator metadata, since only Bull itself can exercise the dispatch) and the
 * payload shape the manager writes.
 */
describe('BullProcessor', () => {
  const makeJob = (name: string, payload: unknown) => ({ id: '1', name, data: { name, payload } }) as any;

  it('is registered for every job name, not just the default', () => {
    // `@Process('*')` records `{ name: '*' }` under Nest's BULL_MODULE_QUEUE_PROCESS metadata;
    // a bare `@Process()` records no name, which is what left this queue undeliverable.
    const meta = Reflect.getMetadata('bull:module_queue_process', BullProcessor.prototype.process);
    expect(meta?.name).toBe('*');
  });

  it('runs the handler registered for the job name, with the enqueued payload', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const processor = new BullProcessor({ getHandler: () => handler } as any);

    await processor.process(makeJob('rebuild-index', { scope: 'branches' }));

    expect(handler).toHaveBeenCalledWith({ scope: 'branches' });
  });

  it('fails loudly when nothing is registered for the job name', async () => {
    const processor = new BullProcessor({ getHandler: () => undefined } as any);

    // Not a silent return: the producer believed this work would happen, so it must reach the
    // dead-letter monitor rather than disappearing behind a warning.
    await expect(processor.process(makeJob('orphaned', {}))).rejects.toThrow(/No handler registered/);
  });

  it('propagates a handler failure so Bull can retry it', async () => {
    const processor = new BullProcessor({ getHandler: () => jest.fn().mockRejectedValue(new Error('boom')) } as any);

    await expect(processor.process(makeJob('flaky', {}))).rejects.toThrow('boom');
  });
});
