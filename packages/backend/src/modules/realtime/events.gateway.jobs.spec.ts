import { EventsGateway } from './events.gateway';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

/**
 * A background job's update reaches the person who started it, and nobody else.
 *
 * The payload names their uploaded file and what it did ("4,980 branches for SBI imported"). Falling
 * through to the gateway's generic branch would have broadcast it to the operational rooms — every
 * staff socket in the region — which is both a leak and, during a 5,000-row import writing progress
 * every second, a firehose.
 */
describe('job:updated routing', () => {
  const setup = () => {
    const publisher = new DomainEventPublisher();
    const resolveEventRegion = jest.fn().mockResolvedValue(null);
    const gateway = new EventsGateway(
      { verifyAsync: jest.fn() } as any,
      publisher,
      { resolveEventRegion } as any,
      { findOne: jest.fn() } as any,
    );
    const emits: Array<{ room: string; event: string; payload: unknown }> = [];
    gateway.server = {
      to: (room: string) => ({ emit: (event: string, payload: unknown) => emits.push({ room, event, payload }) }),
    } as any;
    return { publisher, emits, resolveEventRegion };
  };

  it('is sent to the requester\'s own room only, carrying the job summary', async () => {
    const { publisher, emits, resolveEventRegion } = setup();
    const job = { id: 'job-1', status: 'RUNNING', title: '5,000 branches for SBI' };
    publisher.publish('job:updated', { eventType: 'job:updated', requestedBy: 'user-1', job });
    await new Promise((r) => setImmediate(r));

    expect(emits).toEqual([{ room: 'user:user-1', event: 'job:updated', payload: job }]);
    // Never routed through the operational (org/staff/region) path.
    expect(resolveEventRegion).not.toHaveBeenCalled();
  });

  it('goes nowhere when it does not name a requester', async () => {
    const { publisher, emits } = setup();
    publisher.publish('job:updated', { eventType: 'job:updated', job: { id: 'job-1' } });
    await new Promise((r) => setImmediate(r));
    expect(emits).toEqual([]);
  });
});
