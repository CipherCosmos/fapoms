import { DataSource, EntityManager, Repository } from 'typeorm';
import { TypeOrmUnitOfWork } from './typeorm-unit-of-work';
import { OutboxEntity } from './outbox.entity';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

/**
 * A DataSource whose `transaction` behaves like a real one in the only respect these tests
 * care about: the callback's writes are visible to the caller only if it returns, and are
 * discarded if it throws.
 */
const makeDataSource = () => {
  const committed: string[] = [];
  const outboxRows: any[] = [];
  const isolationLevels: (string | undefined)[] = [];
  /** Whether the outbox INSERT happened before the transaction closed. */
  const order: string[] = [];

  const dataSource = {
    transaction: jest.fn(async (levelOrWork: any, maybeWork?: any) => {
      const work = typeof levelOrWork === 'function' ? levelOrWork : maybeWork;
      isolationLevels.push(typeof levelOrWork === 'function' ? undefined : levelOrWork);

      const staged: string[] = [];
      const stagedOutbox: any[] = [];
      const manager = {
        save: jest.fn(async (row: string) => {
          staged.push(row);
          return row;
        }),
        insert: jest.fn(async (_target: any, rows: any[]) => {
          order.push('outbox-insert');
          stagedOutbox.push(...rows);
          return { identifiers: rows.map((r) => ({ id: r.id })) };
        }),
      } as unknown as EntityManager;

      const result = await work(manager);
      order.push('commit');
      committed.push(...staged); // only reached when the callback did not throw
      outboxRows.push(...stagedOutbox);
      return result;
    }),
  } as unknown as DataSource;

  return { dataSource, committed, outboxRows, isolationLevels, order };
};

describe('TypeOrmUnitOfWork', () => {
  let published: { event: string; payload: any }[];
  let publisher: DomainEventPublisher;
  let outbox: Repository<OutboxEntity>;
  let marked: string[];

  beforeEach(() => {
    published = [];
    marked = [];
    publisher = {
      publish: jest.fn((event: string, payload: any) => {
        published.push({ event, payload });
      }),
      subscribe: jest.fn(),
    } as unknown as DomainEventPublisher;
    outbox = {
      update: jest.fn(async (id: string) => {
        marked.push(id);
      }),
    } as unknown as Repository<OutboxEntity>;
  });

  const uowOver = (dataSource: DataSource) =>
    new TypeOrmUnitOfWork(dataSource, publisher, outbox);

  describe('the transaction boundary', () => {
    it('opens the transaction at READ COMMITTED', async () => {
      const { dataSource, isolationLevels } = makeDataSource();
      await uowOver(dataSource).run(async () => undefined);

      // Not a stylistic choice: the FOR UPDATE locks callers take rely on a blocked writer
      // re-reading the row at its new committed value. REPEATABLE READ would abort it with a
      // serialization failure instead and push the retry onto the caller.
      expect(isolationLevels).toEqual(['READ COMMITTED']);
    });

    it('returns whatever the work returned', async () => {
      const { dataSource } = makeDataSource();
      await expect(uowOver(dataSource).run(async () => 'invoice-1')).resolves.toBe('invoice-1');
    });

    it('propagates a failure so the caller sees the rollback', async () => {
      const { dataSource, committed } = makeDataSource();
      const boom = new Error('overpayment refused');

      await expect(
        uowOver(dataSource).run(async (manager) => {
          await manager.save('invoice-row' as any);
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(committed).toEqual([]);
    });
  });

  describe('when events become visible', () => {
    it('releases nothing until the transaction has committed', async () => {
      const { dataSource } = makeDataSource();
      const seenDuringTransaction: number[] = [];

      await uowOver(dataSource).run(async (_manager, emit) => {
        emit('billing:payment-recorded', { invoiceId: 'inv-1' });
        // A synchronous in-process publisher means a subscriber reading the database here
        // would see the pre-payment state and act on it.
        seenDuringTransaction.push(published.length);
      });

      expect(seenDuringTransaction).toEqual([0]);
      expect(published).toHaveLength(1);
      expect(published[0].event).toBe('billing:payment-recorded');
    });

    it('discards the events of a transaction that rolled back', async () => {
      const { dataSource, outboxRows } = makeDataSource();

      await expect(
        uowOver(dataSource).run(async (_manager, emit) => {
          emit('billing:payment-recorded', { invoiceId: 'inv-1' });
          throw new Error('guard rejected the allocation');
        }),
      ).rejects.toThrow('guard rejected the allocation');

      // Announcing a payment that never happened is worse than announcing nothing: the
      // realtime gateway would have pushed it to every connected finance client.
      expect(published).toEqual([]);
      // And the outbox row rolled back with it, so the relay will not resurrect it later.
      expect(outboxRows).toEqual([]);
    });

    it('releases events in the order they were emitted', async () => {
      const { dataSource } = makeDataSource();

      await uowOver(dataSource).run(async (_manager, emit) => {
        emit('billing:entry-created', {});
        emit('billing:invoice-created', {});
        emit('billing:payment-recorded', {});
      });

      expect(published.map((p) => p.event)).toEqual([
        'billing:entry-created',
        'billing:invoice-created',
        'billing:payment-recorded',
      ]);
    });

    it('stamps each released event with a timestamp', async () => {
      const { dataSource } = makeDataSource();
      await uowOver(dataSource).run(async (_manager, emit) => {
        emit('billing:entry-created', { entryId: 'e-1' });
      });

      expect(published[0].payload).toMatchObject({ entryId: 'e-1' });
      expect(published[0].payload.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('the outbox', () => {
    it('writes the event inside the transaction, before the commit', async () => {
      const { dataSource, order, outboxRows } = makeDataSource();

      await uowOver(dataSource).run(async (_manager, emit) => {
        emit('billing:payment-recorded', { invoiceId: 'inv-1' });
      });

      // This ordering is the whole guarantee: the event and the change it describes are one
      // atomic write, so a process that dies immediately after COMMIT still owes the event
      // and the relay can find it.
      expect(order).toEqual(['outbox-insert', 'commit']);
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0]).toMatchObject({
        eventName: 'billing:payment-recorded',
        dispatchedAt: null,
        attempts: 0,
      });
    });

    it('stores the same payload the subscriber receives', async () => {
      const { dataSource, outboxRows } = makeDataSource();

      await uowOver(dataSource).run(async (_manager, emit) => {
        emit('billing:payment-recorded', { invoiceId: 'inv-1' });
      });

      // A relayed event must be indistinguishable from one the fast path delivered, timestamp
      // included — otherwise a subscriber could behave differently depending on which path ran.
      expect(outboxRows[0].payload).toEqual(published[0].payload);
    });

    it('marks a row dispatched once its immediate publish succeeded', async () => {
      const { dataSource, outboxRows } = makeDataSource();

      await uowOver(dataSource).run(async (_manager, emit) => {
        emit('billing:entry-created', {});
      });

      expect(marked).toEqual([outboxRows[0].id]);
    });

    it('touches the outbox at all only when there are events', async () => {
      const { dataSource, order } = makeDataSource();
      await uowOver(dataSource).run(async () => 'no events here');

      expect(order).toEqual(['commit']);
    });

    it('gives every event its own row', async () => {
      const { dataSource, outboxRows } = makeDataSource();

      await uowOver(dataSource).run(async (_manager, emit) => {
        emit('billing:entry-created', {});
        emit('billing:invoice-created', {});
      });

      expect(outboxRows).toHaveLength(2);
      expect(new Set(outboxRows.map((r) => r.id)).size).toBe(2);
    });
  });

  describe('a failing subscriber', () => {
    it('does not turn a committed change into a failed request', async () => {
      const { dataSource, committed } = makeDataSource();
      (publisher.publish as jest.Mock).mockImplementation(() => {
        throw new Error('realtime gateway is down');
      });

      // The money already moved. Rethrowing here would report failure for an operation that
      // succeeded, and the caller would reasonably retry it.
      await expect(
        uowOver(dataSource).run(async (manager, emit) => {
          await manager.save('payment-row' as any);
          emit('billing:payment-recorded', {});
          return 'ok';
        }),
      ).resolves.toBe('ok');

      expect(committed).toEqual(['payment-row']);
    });

    it('leaves the row undispatched so the relay retries it', async () => {
      const { dataSource } = makeDataSource();
      (publisher.publish as jest.Mock).mockImplementation(() => {
        throw new Error('realtime gateway is down');
      });

      await uowOver(dataSource).run(async (_manager, emit) => {
        emit('billing:payment-recorded', {});
      });

      expect(marked).toEqual([]);
    });

    it('still delivers the events after one that threw', async () => {
      const { dataSource } = makeDataSource();
      (publisher.publish as jest.Mock).mockImplementationOnce(() => {
        throw new Error('one bad subscriber');
      });

      await uowOver(dataSource).run(async (_manager, emit) => {
        emit('billing:entry-created', {});
        emit('billing:invoice-created', {});
      });

      // One unhappy subscriber must not strand every later event on the relay's slow path.
      expect(published.map((p) => p.event)).toEqual(['billing:invoice-created']);
      expect(marked).toHaveLength(1);
    });
  });
});
