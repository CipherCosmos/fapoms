import { Repository } from 'typeorm';
import { OutboxRelay } from './outbox.relay';
import { OutboxEntity } from './outbox.entity';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { CacheService } from '../cache/cache.service';

const row = (over: Partial<OutboxEntity> = {}): OutboxEntity =>
  ({
    id: 'row-1',
    eventName: 'billing:payment-recorded',
    payload: { invoiceId: 'inv-1' },
    occurredAt: new Date('2026-01-01T00:00:00Z'),
    dispatchedAt: null,
    attempts: 0,
    lastError: null,
    ...over,
  }) as OutboxEntity;

describe('OutboxRelay', () => {
  let due: OutboxEntity[];
  let updates: { id: string; patch: any }[];
  let published: { event: string; payload: any }[];
  let findArgs: any;
  let relay: OutboxRelay;
  let publisher: DomainEventPublisher;

  beforeEach(() => {
    due = [];
    updates = [];
    published = [];
    findArgs = undefined;

    const outbox = {
      find: jest.fn(async (opts: any) => {
        findArgs = opts;
        return due;
      }),
      update: jest.fn(async (id: string, patch: any) => {
        updates.push({ id, patch });
      }),
    } as unknown as Repository<OutboxEntity>;

    publisher = {
      publish: jest.fn((event: string, payload: any) => {
        published.push({ event, payload });
      }),
      subscribe: jest.fn(),
    } as unknown as DomainEventPublisher;

    const cache = {
      withLock: jest.fn((_key: string, _ttl: number, fn: () => any) => fn()),
    } as unknown as CacheService;

    relay = new OutboxRelay(outbox, publisher, cache);
  });

  describe('what it claims', () => {
    it('takes only undispatched rows, oldest first', async () => {
      await relay.drain();

      expect(findArgs.where.dispatchedAt).toBeDefined();
      expect(findArgs.order).toEqual({ occurredAt: 'ASC' });
    });

    it('leaves rows the fast path may still be about to publish', async () => {
      await relay.drain();

      // Without a grace window the relay races the transaction that just committed: it would
      // find a row whose in-process publish is milliseconds away and deliver it twice, turning
      // an exceptional duplicate into one on every event.
      const cutoff: Date = findArgs.where.occurredAt.value;
      expect(cutoff.getTime()).toBeLessThan(Date.now());
      expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(30_000);
    });

    it('runs under a cluster-wide lock so replicas do not each publish the batch', async () => {
      const cache = { withLock: jest.fn(async () => ({ dispatched: 0, failed: 0 })) };
      const guarded = new OutboxRelay(
        {} as unknown as Repository<OutboxEntity>,
        publisher,
        cache as unknown as CacheService,
      );

      await guarded.drain();

      expect(cache.withLock).toHaveBeenCalledWith(
        'lock:outbox:relay',
        expect.any(Number),
        expect.any(Function),
        expect.objectContaining({ retries: 0 }),
      );
    });

    it('bounds the batch so one pass cannot hold the lock indefinitely', async () => {
      await relay.drain();
      expect(findArgs.take).toBeGreaterThan(0);
    });
  });

  describe('dispatching', () => {
    it('publishes the stored payload unchanged', async () => {
      due = [row({ payload: { invoiceId: 'inv-1', timestamp: '2026-01-01T00:00:00Z' } })];

      const result = await relay.drain();

      expect(published).toEqual([
        {
          event: 'billing:payment-recorded',
          payload: { invoiceId: 'inv-1', timestamp: '2026-01-01T00:00:00Z' },
        },
      ]);
      expect(result).toEqual({ dispatched: 1, failed: 0 });
    });

    it('marks a delivered row dispatched and clears the last error', async () => {
      due = [row({ lastError: 'gateway was down' })];

      await relay.drain();

      expect(updates).toHaveLength(1);
      expect(updates[0].id).toBe('row-1');
      expect(updates[0].patch.dispatchedAt).toBeInstanceOf(Date);
      expect(updates[0].patch.lastError).toBeNull();
    });

    it('records the failure on the row rather than only in the log', async () => {
      due = [row({ attempts: 2 })];
      (publisher.publish as jest.Mock).mockImplementation(() => {
        throw new Error('subscriber exploded');
      });

      const result = await relay.drain();

      // A row retried for hours has to say why on the row itself; correlating against logs
      // that may have rotated is not a diagnosis path.
      expect(updates[0].patch).toEqual({ attempts: 3, lastError: 'subscriber exploded' });
      expect(updates[0].patch.dispatchedAt).toBeUndefined();
      expect(result).toEqual({ dispatched: 0, failed: 1 });
    });

    it('keeps going after a row that failed', async () => {
      due = [row({ id: 'bad' }), row({ id: 'good' })];
      (publisher.publish as jest.Mock).mockImplementationOnce(() => {
        throw new Error('subscriber exploded');
      });

      const result = await relay.drain();

      expect(result).toEqual({ dispatched: 1, failed: 1 });
      expect(updates.map((u) => u.id)).toEqual(['bad', 'good']);
    });

    it('stops retrying a row that has exhausted its attempts', async () => {
      await relay.drain();

      // Bounded by the query, not by a check inside the loop — an event nothing can process
      // would otherwise consume a batch slot on every pass forever.
      expect(findArgs.where.attempts).toBeDefined();
    });
  });
});
