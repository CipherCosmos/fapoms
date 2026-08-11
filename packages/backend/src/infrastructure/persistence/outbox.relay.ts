import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, LessThan, In } from 'typeorm';
import { OutboxEntity } from './outbox.entity';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { CacheService } from '../cache/cache.service';

/** How long an undispatched row is left alone before the relay claims it. */
const FAST_PATH_GRACE_MS = 30_000;

/** Rows per tick. Bounds how long one pass holds the lock. */
const BATCH_SIZE = 200;

/**
 * Retries before a row is left for a human. Roughly 15 minutes at a one-minute tick — long
 * enough to ride out a subscriber restart, short enough that a genuinely poisoned event stops
 * consuming a batch slot on every pass forever.
 */
const MAX_ATTEMPTS = 15;

@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);

  constructor(
    @InjectRepository(OutboxEntity)
    private readonly outbox: Repository<OutboxEntity>,
    private readonly eventPublisher: DomainEventPublisher,
    private readonly cache: CacheService,
  ) {}

  /**
   * Publish everything the fast path did not.
   *
   * Only rows older than the grace period are considered. Without it the relay would race the
   * `UnitOfWork` that just committed — it would find a row whose in-process publish is still
   * a few milliseconds away and deliver it a second time, turning an exceptional duplicate
   * into one on every single event.
   *
   * Held under a cluster-wide lock so replicas do not each publish the same batch. The lock
   * fails open (see `CacheService.withLock`), which is the right trade here: without Redis the
   * worst case is duplicate delivery, which subscribers already tolerate, whereas failing
   * closed would mean events stop being relayed at all.
   */
  async drain(): Promise<{ dispatched: number; failed: number }> {
    return this.cache.withLock('lock:outbox:relay', 60, () => this.drainOnce(), { retries: 0 });
  }

  private async drainOnce(): Promise<{ dispatched: number; failed: number }> {
    const due = await this.outbox.find({
      where: {
        dispatchedAt: IsNull(),
        occurredAt: LessThan(new Date(Date.now() - FAST_PATH_GRACE_MS)),
        attempts: LessThan(MAX_ATTEMPTS),
      },
      order: { occurredAt: 'ASC' },
      take: BATCH_SIZE,
    });

    let dispatched = 0;
    let failed = 0;
    const dispatchedIds: string[] = [];

    for (const row of due) {
      try {
        this.eventPublisher.publish(row.eventName, row.payload);
        dispatchedIds.push(row.id);
        dispatched++;
      } catch (err) {
        const message = (err as Error).message;
        const attempts = row.attempts + 1;
        await this.outbox.update(row.id, { attempts, lastError: message });
        failed++;

        if (attempts >= MAX_ATTEMPTS) {
          // Stops being retried from here. Said at error level because an event that never
          // reached its subscribers is a silent divergence between what the database records
          // and what the rest of the system believes.
          this.logger.error(
            `Outbox event ${row.id} (${row.eventName}) abandoned after ${attempts} attempts: ${message}`,
          );
        }
      }
    }

    if (dispatchedIds.length > 0) {
      if (dispatchedIds.length === 1) {
        await this.outbox.update(dispatchedIds[0], { dispatchedAt: new Date(), lastError: null });
      } else {
        await this.outbox.update({ id: In(dispatchedIds) }, { dispatchedAt: new Date(), lastError: null });
      }
    }

    if (dispatched > 0 || failed > 0) {
      this.logger.warn(
        `Outbox relay recovered ${dispatched} event(s) the immediate publish missed; ${failed} still failing.`,
      );
    }

    return { dispatched, failed };
  }
}
