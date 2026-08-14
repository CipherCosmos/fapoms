import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { LessThan, Repository } from 'typeorm';
import { NotificationChannel, NotificationStatus } from '@fapoms/shared';
import { NotificationEntity } from './notification.entity';
import { NOTIFICATION_QUEUE } from './notification.constants';

/**
 * Catches notifications the queue never heard about.
 *
 * The enqueue in `NotificationDispatchService` is deliberately non-fatal: if
 * Redis is unavailable the row is still written and the business action still
 * succeeds. That trade is only safe if something later notices the orphan —
 * otherwise "we didn't lose it, we just never sent it" is a distinction without
 * a difference.
 *
 * The database is treated as the source of truth and the queue as a cache of
 * pending work, which is the direction that survives a Redis restart. A row
 * stuck at `PENDING` past the grace period is simply re-queued; delivery is
 * idempotent, so a double-send is at worst a duplicate push, and losing an
 * assignment offer is far worse than sending one twice.
 */
@Injectable()
export class NotificationSweeper {
  private readonly logger = new Logger(NotificationSweeper.name);

  /** Long enough that a normally-processing job is never re-queued underneath itself. */
  private static readonly STRANDED_AFTER_MINUTES = 5;
  private static readonly BATCH = 200;

  constructor(
    @InjectRepository(NotificationEntity)
    private readonly notificationRepo: Repository<NotificationEntity>,
    @InjectQueue(NOTIFICATION_QUEUE)
    private readonly deliveryQueue: Queue,
  ) {}

  async requeueStranded(): Promise<number> {
    const cutoff = new Date(Date.now() - NotificationSweeper.STRANDED_AFTER_MINUTES * 60_000);

    const stranded = await this.notificationRepo.find({
      where: { status: NotificationStatus.PENDING, createdAt: LessThan(cutoff) },
      take: NotificationSweeper.BATCH,
      order: { createdAt: 'ASC' },
    });

    if (!stranded.length) return 0;

    let requeued = 0;
    for (const n of stranded) {
      if (!n.channels?.includes(NotificationChannel.PUSH)) {
        // Pending with no push channel is a contradiction — in-app rows are
        // delivered on insert. Settle it rather than sweeping it forever.
        await this.notificationRepo.update(n.id, {
          status: NotificationStatus.DELIVERED,
          deliveredAt: new Date(),
        });
        continue;
      }

      try {
        await this.deliveryQueue.add(
          'deliver',
          { notificationId: n.id },
          { attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true },
        );
        requeued++;
      } catch (err: any) {
        // Redis still down. Leave the row pending; the next sweep retries.
        this.logger.warn(`Sweeper could not re-queue ${n.id}: ${err?.message}`);
        break;
      }
    }

    if (requeued) {
      this.logger.log(`Re-queued ${requeued} stranded notification(s).`);
    }
    return requeued;
  }

  /**
   * The email leg of the same guarantee. It needs its own query because email's lifecycle is a
   * separate column: an IN_APP+EMAIL row is born with row-status DELIVERED (the bell already
   * has it), so the push-oriented sweep above never sees it — only `email_status` knows an
   * email is still owed.
   */
  async requeueStrandedEmails(): Promise<number> {
    const cutoff = new Date(Date.now() - NotificationSweeper.STRANDED_AFTER_MINUTES * 60_000);

    const stranded = await this.notificationRepo.find({
      where: { emailStatus: NotificationStatus.PENDING, createdAt: LessThan(cutoff) },
      take: NotificationSweeper.BATCH,
      order: { createdAt: 'ASC' },
    });
    if (!stranded.length) return 0;

    let requeued = 0;
    for (const n of stranded) {
      try {
        await this.deliveryQueue.add(
          'deliver-email',
          { notificationId: n.id },
          { attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true },
        );
        requeued++;
      } catch (err: any) {
        this.logger.warn(`Sweeper could not re-queue email ${n.id}: ${err?.message}`);
        break;
      }
    }

    if (requeued) this.logger.log(`Re-queued ${requeued} stranded email(s).`);
    return requeued;
  }

  /**
   * Stops `SENT` from being a permanent resting state.
   *
   * A row moves to `SENT` immediately before the FCM call. If the process is
   * killed mid-call it stays there — indistinguishable from success on every
   * screen that reads status. Anything still `SENT` an hour later plainly did
   * not complete, and is recorded as failed so it can be seen and explained.
   */
  async failAbandonedSends(): Promise<number> {
    const cutoff = new Date(Date.now() - 60 * 60_000);
    const result = await this.notificationRepo
      .createQueryBuilder()
      .update(NotificationEntity)
      .set({
        status: NotificationStatus.FAILED,
        failedAt: new Date(),
        failureReason: 'Delivery did not complete; the sender stopped before confirming.',
      })
      .where('status = :sent', { sent: NotificationStatus.SENT })
      .andWhere('sent_at < :cutoff', { cutoff })
      .execute();

    const n = result.affected ?? 0;
    if (n) this.logger.warn(`Marked ${n} abandoned send(s) as failed.`);

    /**
     * The same rescue for the email leg.
     *
     * `deliver-email` claims a row by flipping it PENDING → SENT before calling the provider,
     * which is what stops two jobs sending the same message. The cost of that claim is this
     * case: a process killed mid-send leaves the row SENT forever, invisible to the
     * stranded-email sweep (which only looks for PENDING). An hour is far longer than any SMTP
     * round trip, so anything still SENT by then plainly did not finish — and it is recorded as
     * failed rather than left looking like a success nobody received.
     */
    const emailResult = await this.notificationRepo
      .createQueryBuilder()
      .update(NotificationEntity)
      .set({
        emailStatus: NotificationStatus.FAILED,
        emailFailureReason: 'Email delivery did not complete; the sender stopped before confirming.',
      })
      .where('email_status = :sent', { sent: NotificationStatus.SENT })
      // `emailed_at` is stamped by the claim and belongs to this send alone. `updated_at` is
      // bumped by every write to the row — including the push settle two statements above —
      // so keying off it let an unrelated write hide a stranded email for another hour.
      .andWhere('emailed_at < :cutoff', { cutoff })
      .execute();

    const e = emailResult.affected ?? 0;
    if (e) this.logger.warn(`Marked ${e} abandoned email send(s) as failed.`);
    return n + e;
  }
}
