import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bull';
import { Repository, In } from 'typeorm';
import { NotificationChannel, NotificationStatus } from '@fapoms/shared';
import { NotificationEntity } from './notification.entity';
import { DeviceTokenEntity } from './device-token.entity';
import { NotificationPreferenceEntity } from './notification-preference.entity';
import { FcmProvider } from '../../infrastructure/notifications/fcm-provider';
import { NotificationSweeper } from './notification.sweeper';
import { NOTIFICATION_QUEUE } from './notification.constants';

export { NOTIFICATION_QUEUE };


export interface DeliveryJob {
  notificationId: string;
}

/**
 * FCM error codes that mean "this device will never receive anything again".
 *
 * These are the only failures worth treating as terminal. Everything else —
 * timeouts, 503s, quota — is transient and belongs in the retry backoff, because
 * giving up on a real device after one bad minute means an assayer silently
 * stops getting offers.
 */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Drains the notification outbox.
 *
 * Slice 1 writes rows and records the channels each should travel on, but
 * nothing sent them: a row marked `PUSH` sat at `PENDING` forever. This worker
 * is what closes that gap, and it exists as a queue rather than an inline
 * `await` for one reason — a push must never be on the critical path of the
 * business action. FCM being slow should not slow down accepting an assignment,
 * and FCM being down should not fail it.
 *
 * Retries are Bull's, with exponential backoff. What is *not* delegated is the
 * bookkeeping: every attempt writes `attempts`, and terminal outcomes write
 * `status` plus `failure_reason`, so a notification that never arrived can be
 * explained after the fact rather than guessed at.
 */
@Processor(NOTIFICATION_QUEUE)
export class NotificationDeliveryWorker {
  private readonly logger = new Logger(NotificationDeliveryWorker.name);

  constructor(
    @InjectRepository(NotificationEntity)
    private readonly notificationRepo: Repository<NotificationEntity>,
    @InjectRepository(DeviceTokenEntity)
    private readonly deviceTokenRepo: Repository<DeviceTokenEntity>,
    @InjectRepository(NotificationPreferenceEntity)
    private readonly preferenceRepo: Repository<NotificationPreferenceEntity>,
    private readonly fcm: FcmProvider,
    private readonly sweeper: NotificationSweeper,
  ) {}

  /** Re-queues rows the enqueue never reached. Registered as a repeatable job. */
  @Process('sweep')
  async sweep(): Promise<void> {
    await this.sweeper.requeueStranded();
  }

  /** Settles rows abandoned mid-send so `SENT` cannot masquerade as success. */
  @Process('fail-abandoned')
  async failAbandoned(): Promise<void> {
    await this.sweeper.failAbandonedSends();
  }

  @Process({ name: 'deliver', concurrency: 5 })
  async deliver(job: Job<DeliveryJob>): Promise<void> {
    const notification = await this.notificationRepo.findOne({
      where: { id: job.data.notificationId },
    });

    if (!notification) {
      // Deleted between enqueue and delivery. Nothing to do, and nothing wrong.
      this.logger.debug(`Notification ${job.data.notificationId} no longer exists; skipping.`);
      return;
    }

    // Terminal delivery states never re-deliver. The previous "...unless it carries a
    // PUSH channel" exception let a duplicate or re-enqueued job for an already
    // DELIVERED/READ push fall through and send a SECOND push (the sweep/requeue path
    // or any resend could trigger it). A legitimate manual resend resets status to
    // PENDING before re-enqueuing, so it is not caught here.
    if ([NotificationStatus.DELIVERED, NotificationStatus.READ, NotificationStatus.SUPPRESSED]
      .includes(notification.status)) {
      return;
    }

    if (!notification.channels?.includes(NotificationChannel.PUSH)) {
      return;
    }

    // ── Preference check ──────────────────────────────────────────────────
    // Absence of a row means opted in, so someone who has never opened the
    // preferences screen keeps receiving everything.
    const recipientId = notification.userId ?? notification.assayerId;
    if (!recipientId) {
      await this.markFailed(notification, 'Notification has no recipient.');
      return;
    }

    const pref = await this.preferenceRepo.findOne({
      where: notification.userId
        ? { userId: notification.userId, category: notification.category }
        : { assayerId: notification.assayerId!, category: notification.category },
    });

    if (pref && pref.push === false) {
      await this.notificationRepo.update(notification.id, {
        status: NotificationStatus.SUPPRESSED,
        failureReason: 'Recipient has turned off push for this category.',
      });
      return;
    }

    // ── Tokens ────────────────────────────────────────────────────────────
    const tokens = await this.deviceTokenRepo.find({
      where: { userId: recipientId, isActive: true },
    });

    if (tokens.length === 0) {
      // Not a failure worth retrying: the person simply has no device
      // registered. Recorded plainly so "why didn't I get a push" has an
      // answer, and left DELIVERED if in-app already carried it.
      const inAppCarried = notification.channels.includes(NotificationChannel.IN_APP);
      await this.notificationRepo.update(notification.id, {
        status: inAppCarried ? NotificationStatus.DELIVERED : NotificationStatus.SUPPRESSED,
        failureReason: 'No registered device for this recipient.',
        attempts: (notification.attempts ?? 0) + 1,
      });
      return;
    }

    // ── Send ──────────────────────────────────────────────────────────────
    await this.notificationRepo.update(notification.id, {
      status: NotificationStatus.SENT,
      sentAt: new Date(),
      attempts: (notification.attempts ?? 0) + 1,
    });

    const results = await this.fcm.sendMulticast(
      tokens.map((t) => t.token),
      {
        title: notification.title,
        body: notification.message,
        // Selects the Android notification channel, so a LOW-priority notice no longer
        // arrives with the same heads-up popup and vibration as a CRITICAL escalation.
        priority: notification.priority,
        // Everything the app needs to deep-link straight to the record, so a
        // tap lands on the thing the notification is about.
        data: {
          notificationId: notification.id,
          type: notification.type ?? '',
          category: notification.category,
          entityType: notification.entityType ?? '',
          entityId: notification.entityId ?? '',
          link: notification.link ?? '',
          // Carried in `data` as well as on the payload so the app can present a
          // locally-raised copy of the same event on the same channel.
          priority: notification.priority ?? '',
        },
      },
    );

    // Retire tokens FCM has told us are dead, so they stop being retried and
    // stop counting as failures for every future notification.
    const deadTokenIds = tokens
      .filter((_, i) => results[i] && !results[i].success && DEAD_TOKEN_CODES.has(results[i].errorCode ?? ''))
      .map((t) => t.id);

    if (deadTokenIds.length) {
      await this.deviceTokenRepo.update({ id: In(deadTokenIds) }, { isActive: false });
      this.logger.log(`Retired ${deadTokenIds.length} dead device token(s).`);
    }

    const delivered = results.filter((r) => r.success).length;

    if (delivered > 0) {
      await this.notificationRepo.update(notification.id, {
        status: NotificationStatus.DELIVERED,
        deliveredAt: new Date(),
        failureReason: null,
      });
      return;
    }

    // Everything failed. If every failure was terminal there is nothing to
    // retry — throwing would just burn the backoff to reach the same answer.
    const allDead = results.every((r) => DEAD_TOKEN_CODES.has(r.errorCode ?? ''));
    const reason = results[0]?.error ?? 'Push delivery failed.';

    if (allDead) {
      await this.markFailed(notification, `All devices unreachable: ${reason}`);
      return;
    }

    await this.notificationRepo.update(notification.id, { failureReason: reason });
    // Hand back to Bull so the configured backoff applies. On the final attempt
    // `onFailed` records the terminal state.
    throw new Error(reason);
  }

  private async markFailed(n: NotificationEntity, reason: string): Promise<void> {
    await this.notificationRepo.update(n.id, {
      status: NotificationStatus.FAILED,
      failedAt: new Date(),
      failureReason: reason.slice(0, 1000),
    });
  }

  /**
   * Records the terminal failure once Bull has exhausted every retry.
   *
   * Without this a notification that genuinely never arrived would sit at
   * `SENT` forever, which reads as success.
   */
  @Process('mark-exhausted')
  async markExhausted(job: Job<DeliveryJob & { reason?: string }>): Promise<void> {
    const n = await this.notificationRepo.findOne({ where: { id: job.data.notificationId } });
    if (n && n.status !== NotificationStatus.DELIVERED && n.status !== NotificationStatus.READ) {
      await this.markFailed(n, job.data.reason ?? 'Delivery failed after all retries.');
    }
  }

}
