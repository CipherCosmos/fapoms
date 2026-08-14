import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bull';
import { Repository, In } from 'typeorm';
import { NotificationChannel, NotificationStatus } from '@fapoms/shared';
import { NotificationEntity } from './notification.entity';
import { DeviceTokenEntity } from './device-token.entity';
import { NotificationPreferenceEntity } from './notification-preference.entity';
import { UserEntity } from '../user/user.entity';
import { FcmProvider } from '../../infrastructure/notifications/fcm-provider';
import { EmailProvider, appPublicUrl, renderEmailHtml } from '../../infrastructure/notifications/email-provider';
import { renderTemplate } from './notification-catalog';
import { NotificationSweeper } from './notification.sweeper';
import { NotificationSettingsService } from './notification-settings.service';
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
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly fcm: FcmProvider,
    private readonly email: EmailProvider,
    private readonly sweeper: NotificationSweeper,
    private readonly settings: NotificationSettingsService,
  ) {}

  /** Re-queues rows the enqueue never reached. Registered as a repeatable job. */
  @Process('sweep')
  async sweep(): Promise<void> {
    await this.sweeper.requeueStranded();
    await this.sweeper.requeueStrandedEmails();
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

  /**
   * Emails one notification to its internal-user recipient.
   *
   * A separate job from `deliver` on purpose: push and email fail independently (an FCM
   * outage must not burn email's retries, and Gmail throttling must not delay pushes), and
   * their bookkeeping is separate columns for the same reason — push marking the row
   * DELIVERED must not read as "the email went", nor trip a shared terminal-state guard.
   */
  @Process({ name: 'deliver-email', concurrency: 3 })
  async deliverEmail(job: Job<DeliveryJob>): Promise<void> {
    const notification = await this.notificationRepo.findOne({
      where: { id: job.data.notificationId },
    });
    if (!notification) return;

    // Only PENDING proceeds: DELIVERED/FAILED/SUPPRESSED are terminal, NULL means this row
    // never owed an email.
    if (notification.emailStatus !== NotificationStatus.PENDING) return;

    if (!notification.userId) {
      await this.settleEmail(notification, NotificationStatus.SUPPRESSED,
        'Email reaches internal users only; this recipient is a field assayer.');
      return;
    }

    // Same convention as push: absence of a preference row means opted in; only an explicit
    // false suppresses.
    const pref = await this.preferenceRepo.findOne({
      where: { userId: notification.userId, category: notification.category },
    });
    if (pref && pref.email === false) {
      await this.settleEmail(notification, NotificationStatus.SUPPRESSED,
        'Recipient has turned off email for this category.');
      return;
    }

    const user = await this.userRepo.findOne({
      where: { id: notification.userId },
      select: ['id', 'email', 'isActive', 'status'],
    });
    if (!user?.email) {
      await this.settleEmail(notification, NotificationStatus.SUPPRESSED,
        'Recipient has no email address on file.');
      return;
    }
    /**
     * Durably cut off, not merely locked out.
     *
     * Emailing a suspended or archived account leaks operational detail to someone deliberately
     * removed. LOCKED is not that: it is the automatic fifteen-minute lockout five bad passwords
     * produce, and an SLA escalation is if anything MORE useful to that person, who is a
     * colleague having a bad morning rather than an ex-colleague.
     */
    const CUT_OFF = ['SUSPENDED', 'DISABLED', 'ARCHIVED', 'INVITED'];
    if (!user.isActive || CUT_OFF.includes(user.status)) {
      await this.settleEmail(notification, NotificationStatus.SUPPRESSED,
        `Recipient account is ${user.isActive ? user.status.toLowerCase() : 'deactivated'}.`);
      return;
    }

    const linkUrl = notification.link ? `${appPublicUrl()}${notification.link}` : null;

    /**
     * Email wording, when an operator has written some.
     *
     * The row already carries the rendered in-app title and message; an email-specific
     * template is rendered here instead, against the payload the event was raised with. An
     * inbox has room for context a lock screen does not, which is the whole reason the
     * override exists — and falling back to the in-app text keeps every type that has not
     * been customised sending exactly what it sent before.
     */
    const def = notification.type
      ? await this.settings.defFor(notification.type).catch(() => null)
      : null;
    const payload = notification.payload ?? {};
    const subject = def?.emailSubject
      ? renderTemplate(def.emailSubject, payload)
      : notification.title;
    const bodyText = def?.emailBody
      ? renderTemplate(def.emailBody, payload)
      : notification.message;

    /**
     * Claim the row here — as late as possible, immediately before the only irreversible step.
     *
     * The stranded-email sweep re-enqueues anything PENDING for five minutes, which a large
     * fan-out or a throttling provider produces routinely, so two jobs can genuinely be in
     * flight for one row. A conditional PENDING → SENT update means exactly one of them may
     * send.
     *
     * Why *here* and not earlier: everything above is read-only and idempotent, and claiming
     * before it turned an ordinary database blip into a lost email. A throw during the
     * preference or user lookup would leave the row SENT, and the retry — the very machinery
     * that exists for transient errors — would see a non-PENDING row and return without
     * sending. Claiming late keeps the anti-duplicate guarantee (this is still the last thing
     * before the send) while leaving the fragile reads outside it, where a throw simply leaves
     * the row PENDING for the retry to pick up.
     */
    const claim = await this.notificationRepo
      .createQueryBuilder()
      .update(NotificationEntity)
      .set({
        emailStatus: NotificationStatus.SENT,
        // The claim's own clock. `updated_at` is bumped by every write to the row — including
        // the push leg's own sweep — so it cannot tell the abandoned-send sweep how long THIS
        // send has been outstanding.
        emailedAt: new Date(),
      })
      .where('id = :id', { id: notification.id })
      .andWhere('email_status = :pending', { pending: NotificationStatus.PENDING })
      .execute();
    if (!claim.affected) {
      this.logger.debug(`Email for ${notification.id} is already claimed by another job.`);
      return;
    }

    const result = await this.email.send({
      to: user.email,
      subject,
      text: `${bodyText}${linkUrl ? `\n\nOpen in FAPOMS: ${linkUrl}` : ''}`,
      html: renderEmailHtml({
        title: subject,
        bodyLines: bodyText.split('\n').filter(Boolean),
        linkUrl,
      }),
    });

    if (result.success) {
      await this.notificationRepo.update(notification.id, {
        emailStatus: NotificationStatus.DELIVERED,
        emailedAt: new Date(),
        emailFailureReason: null,
      });
      return;
    }

    if (result.permanent) {
      /**
       * "No transport configured" is not a failure of this message — it is the platform
       * being told not to send email at all. Recording it as FAILED made every notification
       * in an unconfigured deployment look like something had gone wrong, when the honest
       * reading is that email is switched off. Everything else permanent (a rejected address,
       * bad credentials) genuinely failed.
       */
      const notConfigured = !this.email.isEnabled();
      await this.settleEmail(
        notification,
        notConfigured ? NotificationStatus.SUPPRESSED : NotificationStatus.FAILED,
        notConfigured ? 'Email is not configured, so none was sent.' : (result.error ?? 'Email send failed.'),
      );
      return;
    }

    // Transient. Record what happened; on the final attempt settle as FAILED instead of
    // throwing — throwing on the last try would leave the row PENDING forever, which the
    // push path avoids only via an external mark-exhausted job nothing enqueues.
    const attemptsAllowed = Number(job.opts?.attempts ?? 1);
    if (job.attemptsMade + 1 >= attemptsAllowed) {
      await this.settleEmail(notification, NotificationStatus.FAILED,
        `${result.error ?? 'Email send failed.'} (after ${attemptsAllowed} attempts)`);
      return;
    }
    // Release the claim so the retry — or the sweeper, if this process dies — can take the row
    // again. Leaving it SENT would strand it until `failAbandonedSends` gave up on it.
    await this.notificationRepo.update(notification.id, {
      emailStatus: NotificationStatus.PENDING,
      emailFailureReason: result.error ?? 'Email send failed.',
    });
    throw new Error(result.error ?? 'Email send failed.');
  }

  private async settleEmail(
    n: NotificationEntity,
    status: NotificationStatus,
    reason: string,
  ): Promise<void> {
    await this.notificationRepo.update(n.id, {
      emailStatus: status,
      emailFailureReason: reason.slice(0, 1000),
      ...(status === NotificationStatus.DELIVERED ? { emailedAt: new Date() } : {}),
    });
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
