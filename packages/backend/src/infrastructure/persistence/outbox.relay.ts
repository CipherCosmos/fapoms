import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, LessThan, In } from 'typeorm';
import { Optional } from '@nestjs/common';
import { OutboxEntity } from './outbox.entity';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { CacheService } from '../cache/cache.service';
import { MetricsService } from '../observability/metrics.service';

/** How long an undispatched row is left alone before the relay claims it. */
const FAST_PATH_GRACE_MS = 30_000;

/** Rows per tick. Bounds how long one pass holds the lock. */
const BATCH_SIZE = 200;

/**
 * Retries before a row is left for a human. Roughly 15 minutes at a one-minute tick — long
 * enough to ride out a subscriber restart, short enough that a genuinely poisoned event stops
 * consuming a batch slot on every pass forever.
 *
 * Reaching it is now a state on the row (`failed_at`), not merely the point at which the row
 * stops matching this query. See `OutboxEntity.failedAt`.
 */
export const MAX_ATTEMPTS = 15;

@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);

  constructor(
    @InjectRepository(OutboxEntity)
    private readonly outbox: Repository<OutboxEntity>,
    private readonly eventPublisher: DomainEventPublisher,
    private readonly cache: CacheService,
    // Optional so the many unit tests that construct this relay by hand keep working, and so a
    // metrics registry that is not wired can never stop an event being relayed.
    @Optional() private readonly metrics?: MetricsService,
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
    /**
     * `failedAt: IsNull()` rather than `attempts: LessThan(MAX_ATTEMPTS)`.
     *
     * They exclude the same rows, but only one of them says so. Selecting on the attempt count
     * meant "abandoned" was invisible — no column held it, nothing could list it, and a replay
     * had to know the constant to undo it. Selecting on the terminal state means a replay is
     * `failed_at = NULL` and the relay picks the row up again on its next tick, with no other
     * mechanism involved.
     */
    const due = await this.outbox.find({
      where: {
        dispatchedAt: IsNull(),
        failedAt: IsNull(),
        occurredAt: LessThan(new Date(Date.now() - FAST_PATH_GRACE_MS)),
      },
      order: { occurredAt: 'ASC' },
      take: BATCH_SIZE,
    });

    let dispatched = 0;
    let failed = 0;
    const dispatchedIds: string[] = [];

    for (const row of due) {
      try {
        if (typeof this.eventPublisher.publishAsync === 'function') {
          const handled = await this.eventPublisher.publishAsync(row.eventName, row.payload);
          /**
           * Nobody listening is not a delivery.
           *
           * `publishAsync` resolves happily over an empty listener array, and this used to count
           * that as success and stamp `dispatched_at` — so a renamed or unregistered subscriber
           * discarded every event of that name for ever, with no error, no retry and nothing in
           * the dead-letter queue. For `assignment:status-changed` that is a payable never booked.
           *
           * Throwing puts the row on the ordinary failure path: it retries, and if the subscriber
           * is genuinely gone it dead-letters and appears in `GET /admin/outbox/dead-letters` for
           * a person to look at. A dead letter somebody can see beats a silent discard, even when
           * the event turns out to be one nothing needs to handle.
           */
          if (typeof handled === 'number' && handled === 0) {
            throw new Error(
              `no subscriber is registered for "${row.eventName}" — the event was not delivered to anything. `
              + 'Either a subscriber was renamed or removed, or this process does not register one.',
            );
          }
        } else {
          this.eventPublisher.publish(row.eventName, row.payload);
        }
        dispatchedIds.push(row.id);
        dispatched++;
      } catch (err) {
        const message = (err as Error).message;
        const attempts = row.attempts + 1;
        const exhausted = attempts >= MAX_ATTEMPTS;
        // The terminal state is written in the SAME update as the attempt that caused it, so a
        // crash between the two cannot leave a row that is out of retries and not marked as such.
        await this.outbox.update(row.id, {
          attempts,
          lastError: message,
          ...(exhausted ? { failedAt: new Date() } : {}),
        });
        failed++;

        if (exhausted) {
          // Stops being retried from here. Said at error level because an event that never
          // reached its subscribers is a silent divergence between what the database records
          // and what the rest of the system believes — but the log line is no longer the ONLY
          // trace: `failed_at` is now on the row, the row is listed by GET
          // /admin/outbox/dead-letters, and this counter makes it alertable.
          this.metrics?.outboxDeadLettered.inc({ event: row.eventName });
          this.logger.error(
            `Outbox event ${row.id} (${row.eventName}) abandoned after ${attempts} attempts and dead-lettered: ` +
              `${message}. Replay it from Administration -> Outbox once the cause is fixed.`,
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
