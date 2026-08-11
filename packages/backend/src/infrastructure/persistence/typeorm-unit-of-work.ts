import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { UnitOfWork, TransactionWork } from './unit-of-work';
import { OutboxEntity } from './outbox.entity';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

interface StagedEvent {
  id: string;
  eventName: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class TypeOrmUnitOfWork extends UnitOfWork {
  private readonly logger = new Logger(TypeOrmUnitOfWork.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly eventPublisher: DomainEventPublisher,
    @InjectRepository(OutboxEntity)
    private readonly outbox: Repository<OutboxEntity>,
  ) {
    super();
  }

  async run<T>(work: TransactionWork<T>): Promise<T> {
    const staged: StagedEvent[] = [];

    const result = await this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const value = await work(manager, (eventName, payload) => {
        staged.push({
          id: randomUUID(),
          eventName,
          // Stamped here rather than at publish time so the row and the in-process event
          // carry the same payload — a relayed event must be indistinguishable from one the
          // fast path delivered.
          payload: { ...payload, timestamp: new Date() },
        });
      });

      // Inside the transaction: the events and the change they describe now commit or roll
      // back together. `insert` rather than `save` because these are append-only and never
      // re-read within the transaction.
      if (staged.length > 0) {
        await manager.insert(OutboxEntity, staged.map(toRow));
      }

      return value;
    });

    // Past this line the change is durable. A throw inside `work` never reaches here: the
    // transaction rolls back and takes the staged rows with it.
    await this.dispatch(staged);

    return result;
  }

  /**
   * The fast path — publish immediately so subscribers do not wait for the relay's next tick.
   *
   * Failure here is not an error the caller should see: the transaction has committed, so
   * rethrowing would report failure for an operation that succeeded and invite a retry that
   * would double it. The row simply stays undispatched and `OutboxRelay` picks it up.
   */
  private async dispatch(staged: StagedEvent[]): Promise<void> {
    for (const event of staged) {
      try {
        this.eventPublisher.publish(event.eventName, event.payload);
        await this.outbox.update(event.id, { dispatchedAt: new Date() });
      } catch (err) {
        this.logger.error(
          `Deferred ${event.eventName} to the outbox relay after a failed immediate publish: ${
            (err as Error).message
          }`,
        );
      }
    }
  }
}

/**
 * `payload` is cast because TypeORM's `DeepPartial` recurses into `Record<string, unknown>`
 * and cannot express "an arbitrary JSON object" — the value is written to a jsonb column
 * verbatim, so there is no partial-entity semantics to preserve.
 */
const toRow = (event: StagedEvent): QueryDeepPartialEntity<OutboxEntity> => ({
  id: event.id,
  eventName: event.eventName,
  payload: event.payload as QueryDeepPartialEntity<OutboxEntity>['payload'],
  dispatchedAt: null,
  attempts: 0,
  lastError: null,
});
