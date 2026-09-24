import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { LessThan, Repository } from 'typeorm';
import { NotificationChannel, NotificationStatus } from '@fapoms/shared';
import type { MessageChannel } from '@fapoms/shared';
import { NotificationEntity } from './notification.entity';
import { NOTIFICATION_QUEUE } from './notification.constants';
import { FAILED_JOB_RETENTION } from '../../infrastructure/queue/queued-job';
import { NOTIFICATION_MESSAGE_ENTITY } from './outbound-message.service';
import { pushDeliveryJobId } from './notification-dispatch.service';
import { NOTIFICATION_MESSAGE_LEGS, NOTIFICATION_MESSAGE_LEG_LIST } from './notification-message-legs';

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
        // A failed or completed job keeps its id for a while and Bull will not add a second job
        // under it; a waiting/delayed/active one is already going to deliver this row.
        const existing = await this.deliveryQueue.getJob(pushDeliveryJobId(n.id));
        if (existing) {
          const state = await existing.getState();
          if (state === 'failed' || state === 'completed') await existing.remove();
          else continue;
        }
        await this.deliveryQueue.add(
          'deliver',
          { notificationId: n.id },
          // Bounded failed-job retention, the same terms the original enqueue in
          // NotificationDispatchService uses. Without it every job that exhausted its five
          // attempts stayed in Redis forever, and the sweeper re-queues exactly the rows most
          // likely to be failing — see FAILED_JOB_RETENTION.
          {
            jobId: pushDeliveryJobId(n.id),
            attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: FAILED_JOB_RETENTION,
          },
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
   * The email and text legs of the same guarantee, one channel per call. Each needs its own query
   * because its lifecycle is a separate column: an IN_APP+EMAIL (or IN_APP+SMS) row is born with
   * row-status DELIVERED (the bell already has it), so the push-oriented sweep above never sees it —
   * only `email_status` / `sms_status` knows a message is still owed.
   *
   * Only PENDING: a message that has not yet been handed to the message queue. Once handed over
   * (status SENT) that queue's own sweep (`OutboundMessageService.sweep`) owns it — re-queueing,
   * giving up, and writing the outcome back here.
   */
  async requeueStrandedMessages(channel: MessageChannel): Promise<number> {
    const leg = NOTIFICATION_MESSAGE_LEGS[channel];
    const cutoff = new Date(Date.now() - NotificationSweeper.STRANDED_AFTER_MINUTES * 60_000);

    const stranded = await this.notificationRepo.find({
      where: { [leg.statusKey]: NotificationStatus.PENDING, createdAt: LessThan(cutoff) },
      take: NotificationSweeper.BATCH,
      order: { createdAt: 'ASC' },
    });
    if (!stranded.length) return 0;

    let requeued = 0;
    for (const n of stranded) {
      try {
        await this.deliveryQueue.add(
          leg.job,
          { notificationId: n.id },
          // Same bounded retention as the push leg above, for the same reason.
          { attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: FAILED_JOB_RETENTION },
        );
        requeued++;
      } catch (err: any) {
        this.logger.warn(`Sweeper could not re-queue ${leg.noun} ${n.id}: ${err?.message}`);
        break;
      }
    }

    if (requeued) this.logger.log(`Re-queued ${requeued} stranded ${leg.noun}(s).`);
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
     * The email and text legs, narrowed to the one case the message queue cannot see.
     *
     * `deliver-email` / `deliver-sms` claims a row (PENDING → SENT) and then hands the message to the
     * message queue. From the moment the queue has its `outbound_messages` row, that queue's sweep
     * settles it and writes the outcome back — a stuck send, a day-old queued message, all of it.
     * What it cannot see is a process killed between the claim and the hand-off: SENT, and no
     * message row of that channel for it anywhere. Anything in that state an hour on never reached
     * the queue, and is recorded as failed rather than left reading "with the queue" for ever. The
     * leg's own timestamp (`emailed_at` / `texted_at`) is stamped by the claim; `updated_at` would be
     * reset by any unrelated write to the row, such as the push settle above.
     *
     * The guard matches on channel as well as entity: an email row for this notification says
     * nothing about whether its text reached the queue, and vice versa.
     */
    let legs = 0;
    for (const leg of NOTIFICATION_MESSAGE_LEG_LIST) {
      const legResult = await this.notificationRepo
        .createQueryBuilder()
        .update(NotificationEntity)
        .set(leg.patch(NotificationStatus.FAILED, {
          reason: `The ${leg.noun} never reached the message queue; the sender stopped before handing it over.`,
        }))
        .where(`${leg.statusColumn} = :sent`, { sent: NotificationStatus.SENT })
        .andWhere(`${leg.atColumn} < :cutoff`, { cutoff })
        .andWhere(
          'NOT EXISTS (SELECT 1 FROM outbound_messages o WHERE o.channel = :channel AND o.entity_type = :entityType AND o.entity_id = "notifications"."id"::text)',
          { channel: leg.channel, entityType: NOTIFICATION_MESSAGE_ENTITY },
        )
        .execute();

      const affected = legResult.affected ?? 0;
      if (affected) this.logger.warn(`Marked ${affected} ${leg.noun}(s) that never reached the message queue as failed.`);
      legs += affected;
    }
    return n + legs;
  }
}
