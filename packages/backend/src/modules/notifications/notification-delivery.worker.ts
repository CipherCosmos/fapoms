import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bull';
import { Repository, In } from 'typeorm';
import { NotificationChannel, NotificationStatus } from '@fapoms/shared';
import type { OutboundMessageReceipt } from '@fapoms/shared';
import { NotificationEntity } from './notification.entity';
import { DeviceTokenEntity } from './device-token.entity';
import { NotificationPreferenceEntity } from './notification-preference.entity';
import { UserEntity } from '../user/user.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { FcmProvider } from '../../infrastructure/notifications/fcm-provider';
import { appPublicUrl } from '../../infrastructure/notifications/email-provider';
import { EmailService } from './email.service';
import { SmsService } from './sms.service';
import { NOTIFICATION_MESSAGE_LEGS, NotificationMessageLeg } from './notification-message-legs';
import { NOTIFICATION_MESSAGE_ENTITY } from './outbound-message.service';
import { renderTemplate } from './notification-catalog';
import { NotificationSweeper } from './notification.sweeper';
import { NotificationSettingsService } from './notification-settings.service';
import { NOTIFICATION_QUEUE } from './notification.constants';

export { NOTIFICATION_QUEUE };


export interface DeliveryJob {
  notificationId: string;
}

const EMAIL = NOTIFICATION_MESSAGE_LEGS.EMAIL;
const SMS = NOTIFICATION_MESSAGE_LEGS.SMS;

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
    @InjectRepository(AssayerEntity)
    private readonly assayerRepo: Repository<AssayerEntity>,
    private readonly fcm: FcmProvider,
    private readonly email: EmailService,
    private readonly sweeper: NotificationSweeper,
    private readonly settings: NotificationSettingsService,
    private readonly sms: SmsService,
  ) {}

  /** Re-queues rows the enqueue never reached. Registered as a repeatable job. */
  @Process('sweep')
  async sweep(): Promise<void> {
    await this.sweeper.requeueStranded();
    await this.sweeper.requeueStrandedMessages('EMAIL');
    await this.sweeper.requeueStrandedMessages('SMS');
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

    // ── Push switched off ─────────────────────────────────────────────────
    /*
      No push credential on this server is a state, not a failure of this message.

      Sending anyway answered "FCM not initialized" for every device, which is not one of the dead-
      token codes, so the job threw and Bull retried it five times over a couple of minutes — for a
      condition no retry can change. Measured on this stack: every failed job in the notification
      queue was exactly that, and each left its row at SENT, which reads as success. Settled the
      way "no registered device" is: delivered when the bell already carried it.
    */
    if (!this.fcm.isEnabled()) {
      const inAppCarried = notification.channels.includes(NotificationChannel.IN_APP);
      await this.notificationRepo.update(notification.id, {
        status: inAppCarried ? NotificationStatus.DELIVERED : NotificationStatus.SUPPRESSED,
        failureReason: 'Push notifications are not set up on this server.',
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
   * Decides whether and what to email for one notification, and hands it to the mail queue.
   *
   * A separate job from `deliver` on purpose: push and email fail independently (an FCM outage must
   * not hold up email, and Gmail throttling must not delay pushes), and their bookkeeping is
   * separate columns for the same reason — push marking the row DELIVERED must not read as "the
   * email went", nor trip a shared terminal-state guard.
   *
   * It does not send. Sending, retrying and giving up belong to the one email pipeline
   * (`EmailService.queue` → `OutboundEmailWorker`); this job only settles what it alone can know —
   * who the recipient is, whether they want it, whether their account is cut off — and composes the
   * catalog's wording. `email_status` then reads:
   *
   *   PENDING     owed, not yet handed over (the sweeper re-queues a row stuck here)
   *   SENT        with the mail queue — the claim in `handOff`, taken before the hand-off
   *   DELIVERED / FAILED / SUPPRESSED
   *               written back by `OutboundMessageService` when the queued email settles; "email is
   *               not set up" lands as SUPPRESSED, not FAILED, as it always has
   */
  @Process({ name: 'deliver-email', concurrency: 3 })
  async deliverEmail(job: Job<DeliveryJob>): Promise<void> {
    const notification = await this.notificationRepo.findOne({
      where: { id: job.data.notificationId },
    });
    if (!notification) return;

    // Only PENDING proceeds: SENT is with the mail queue already, DELIVERED/FAILED/SUPPRESSED are
    // terminal, NULL means this row never owed an email.
    if (notification.emailStatus !== NotificationStatus.PENDING) return;

    let recipientEmail: string | null = null;

    if (notification.userId) {
      // Same convention as push: absence of a preference row means opted in; only an explicit
      // false suppresses.
      const pref = await this.preferenceRepo.findOne({
        where: { userId: notification.userId, category: notification.category },
      });
      if (pref && pref.email === false) {
        await this.settleLeg(notification, EMAIL, 'Recipient has turned off email for this category.');
        return;
      }

      const user = await this.userRepo.findOne({
        where: { id: notification.userId },
        select: ['id', 'email', 'isActive', 'status'],
      });
      if (!user?.email) {
        await this.settleLeg(notification, EMAIL, 'Recipient has no email address on file.');
        return;
      }
      const cutOff = NotificationDeliveryWorker.staffCutOff(user);
      if (cutOff) {
        await this.settleLeg(notification, EMAIL, cutOff);
        return;
      }
      recipientEmail = user.email;
    } else if (notification.assayerId) {
      const assayer = await this.assayerRepo.findOne({
        where: { id: notification.assayerId },
        select: ['id', 'email', 'displayName', 'status'],
      });
      if (!assayer?.email) {
        await this.settleLeg(notification, EMAIL, 'Field assayer has no email address on file.');
        return;
      }
      const cutOff = NotificationDeliveryWorker.assayerCutOff(assayer);
      if (cutOff) {
        await this.settleLeg(notification, EMAIL, cutOff);
        return;
      }
      recipientEmail = assayer.email;
    } else {
      await this.settleLeg(notification, EMAIL, 'Notification has no recipient user or assayer.');
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

    const badge = NotificationDeliveryWorker.badgeFor(notification.type, def?.category);

    const kvTable = payload.invoiceNumber ? [
      { label: 'Claim Reference', value: String(payload.invoiceNumber) },
      { label: 'Included Audits', value: `${payload.count ?? payload.lineCount ?? 0} completed assignment(s)` },
      ...(payload.subtotalBase !== undefined ? [{ label: 'Base Fees', value: `₹${Number(payload.subtotalBase).toLocaleString('en-IN')}` }] : []),
      ...(payload.subtotalTravel !== undefined ? [{ label: 'Travel Expenses', value: `₹${Number(payload.subtotalTravel).toLocaleString('en-IN')}` }] : []),
      ...(payload.tdsAmount !== undefined ? [{ label: 'TDS Deduction', value: `₹${Number(payload.tdsAmount).toLocaleString('en-IN')}` }] : []),
      ...(payload.totalAmount !== undefined ? [{ label: 'Net Payable', value: `₹${Number(payload.totalAmount).toLocaleString('en-IN')}` }] : []),
    ] : undefined;

    const to = recipientEmail;
    await this.handOff(notification, job, EMAIL, 'The email could not be queued.', () => this.email.queue({
      kind: 'NOTIFICATION',
      to,
      entityType: NOTIFICATION_MESSAGE_ENTITY,
      entityId: notification.id,
      requestedBy: null,
      content: {
        subject,
        text: `${bodyText}${linkUrl ? `\n\nOpen in FAPOMS: ${linkUrl}` : ''}`,
        layout: {
          title: subject,
          badge,
          bodyLines: bodyText.split('\n').filter(Boolean),
          kvTable,
          linkUrl,
          linkLabel: payload.invoiceNumber ? 'Review & Confirm Claim in App' : 'Open in FAPOMS',
        },
      },
    }));
  }

  /**
   * Decides whether to text one notification, and hands it to the SMS queue — the text twin of
   * `deliverEmail`, on its own job for the same reason email has one: a slow SMS gateway must not
   * hold up push or email, and `sms_status` must not share a terminal-state guard with either.
   *
   * Only reachable for an event an administrator has switched SMS on for; no shipped event carries
   * it. Like `deliverEmail` it does not send: `SmsService.queue` → `OutboundSmsWorker` owns sending,
   * retrying, "SMS is not set up" and giving up, and `OutboundMessageService` writes the outcome
   * back. This job settles only what it alone can know — who the recipient is, whether they have a
   * mobile number, whether they want texts for this category, whether their account is cut off.
   * `sms_status` then reads exactly as `email_status` does (PENDING → SENT → DELIVERED / FAILED /
   * SUPPRESSED).
   *
   * Two differences from email, both deliberate. The preference is honoured for assayers too: a
   * text reaches a field assayer's personal phone, and the settings screen offers them the switch.
   * And the wording is always the catalog's rendered in-app title and message, cut short — a text
   * is paid for per segment and must fit a registered DLT template, so there is no long-form
   * override the way an email has one.
   */
  @Process({ name: 'deliver-sms', concurrency: 2 })
  async deliverSms(job: Job<DeliveryJob>): Promise<void> {
    const notification = await this.notificationRepo.findOne({
      where: { id: job.data.notificationId },
    });
    if (!notification) return;

    // Only PENDING proceeds: SENT is with the SMS queue already, DELIVERED/FAILED/SUPPRESSED are
    // terminal, NULL means this row never owed a text.
    if (notification.smsStatus !== NotificationStatus.PENDING) return;

    if (!notification.userId && !notification.assayerId) {
      await this.settleLeg(notification, SMS, 'Notification has no recipient user or assayer.');
      return;
    }

    // Same convention as every other channel: absence of a preference row means opted in; only an
    // explicit false suppresses.
    const pref = await this.preferenceRepo.findOne({
      where: notification.userId
        ? { userId: notification.userId, category: notification.category }
        : { assayerId: notification.assayerId!, category: notification.category },
    });
    if (pref && pref.sms === false) {
      await this.settleLeg(notification, SMS, 'Recipient has turned off SMS for this category.');
      return;
    }

    let phone: string;
    let textedName: string | null = null;
    if (notification.userId) {
      const user = await this.userRepo.findOne({
        where: { id: notification.userId },
        select: ['id', 'phone', 'displayName', 'isActive', 'status'],
      });
      if (!user?.phone?.trim()) {
        await this.settleLeg(notification, SMS, 'Recipient has no mobile number on file.');
        return;
      }
      const cutOff = NotificationDeliveryWorker.staffCutOff(user);
      if (cutOff) {
        await this.settleLeg(notification, SMS, cutOff);
        return;
      }
      phone = user.phone;
      textedName = user.displayName ?? null;
    } else {
      const assayer = await this.assayerRepo.findOne({
        where: { id: notification.assayerId! },
        select: ['id', 'phone', 'displayName', 'status'],
      });
      if (!assayer?.phone?.trim()) {
        await this.settleLeg(notification, SMS, 'Field assayer has no mobile number on file.');
        return;
      }
      const cutOff = NotificationDeliveryWorker.assayerCutOff(assayer);
      if (cutOff) {
        await this.settleLeg(notification, SMS, cutOff);
        return;
      }
      phone = assayer.phone;
      textedName = assayer.displayName ?? null;
    }

    await this.handOff(notification, job, SMS, 'The text could not be queued.', () => this.sms.queue({
      kind: 'NOTIFICATION',
      to: phone,
      recipientName: textedName,
      entityType: NOTIFICATION_MESSAGE_ENTITY,
      entityId: notification.id,
      requestedBy: null,
      content: {
        template: 'notification',
        // Fitted to DLT's per-variable limit by the SMS template (`fitSmsVariable`), the one place
        // that rule lives; the full notification is one tap away in the app.
        data: { title: notification.title, message: notification.message },
      },
    }));
  }

  /**
   * Claim the row, hand the message over, and give the claim back if the queue would not take it —
   * the one hand-off routine for both message legs.
   *
   * The claim is PENDING → SENT in one conditional UPDATE on the leg's own status column. The
   * sweeper re-enqueues anything PENDING for five minutes, which a slow fan-out produces routinely,
   * so two copies of a job can race. Only the one whose UPDATE matched may hand the message to the
   * queue — without this, both would, and the recipient would get it twice. The leg's timestamp is
   * stamped with the hand-off; the settle re-stamps it with the send.
   *
   * When the queue did not take it (the row could not be written, or the message could not be put
   * together), nothing was sent. The claim goes back — conditionally, in case the row has moved on —
   * and the job throws so Bull tries the hand-off again. On the last attempt the row settles FAILED
   * with the reason instead: a hand-off that fails every time (an address that is only whitespace,
   * say) would otherwise go back to PENDING for the sweeper to re-queue for ever.
   */
  private async handOff(
    notification: NotificationEntity,
    job: Job<DeliveryJob>,
    leg: NotificationMessageLeg,
    notQueuedReason: string,
    queue: () => Promise<OutboundMessageReceipt>,
  ): Promise<void> {
    const claim = await this.notificationRepo
      .createQueryBuilder()
      .update(NotificationEntity)
      .set(leg.patch(NotificationStatus.SENT, { at: new Date() }))
      .where('id = :id', { id: notification.id })
      .andWhere(`${leg.statusColumn} = :pending`, { pending: NotificationStatus.PENDING })
      .execute();
    if (!claim.affected) {
      this.logger.debug(`The ${leg.noun} for ${notification.id} is already claimed by another job.`);
      return;
    }

    const receipt = await queue();
    if (receipt.status !== 'NOT_QUEUED') return;

    const reason = receipt.error ?? notQueuedReason;
    const attemptsAllowed = Number(job.opts?.attempts ?? 1);
    const lastAttempt = job.attemptsMade + 1 >= attemptsAllowed;
    await this.notificationRepo
      .createQueryBuilder()
      .update(NotificationEntity)
      .set(lastAttempt
        ? leg.patch(NotificationStatus.FAILED, { reason: `${reason} (after ${attemptsAllowed} attempts)`.slice(0, 1000) })
        : leg.patch(NotificationStatus.PENDING, { reason: reason.slice(0, 1000) }))
      .where('id = :id', { id: notification.id })
      .andWhere(`${leg.statusColumn} = :handedOff`, { handedOff: NotificationStatus.SENT })
      .execute();
    if (!lastAttempt) throw new Error(reason);
  }

  /**
   * Why a staff account must not be emailed or texted any more, or null when it may be. Durably cut
   * off, not merely locked out: LOCKED is the automatic fifteen-minute sign-in lockout, not a
   * severance, so it is still messaged. One rule for both legs.
   */
  private static staffCutOff(user: Pick<UserEntity, 'isActive' | 'status'>): string | null {
    const CUT_OFF = ['SUSPENDED', 'DISABLED', 'ARCHIVED', 'INVITED'];
    if (user.isActive && !CUT_OFF.includes(user.status)) return null;
    return `Recipient account is ${user.isActive ? user.status.toLowerCase() : 'deactivated'}.`;
  }

  /** The field assayer's version of `staffCutOff`. */
  private static assayerCutOff(assayer: Pick<AssayerEntity, 'status'>): string | null {
    if (assayer.status !== 'INACTIVE' && assayer.status !== 'SUSPENDED') return null;
    return `Field assayer account is ${String(assayer.status).toLowerCase()}.`;
  }

  /** The label and colour across the top of a notification email, from its type and category. */
  static badgeFor(type: string | null | undefined, category: string | null | undefined): {
    text: string;
    tone: 'gold' | 'flame' | 'emerald' | 'crimson' | 'slate';
  } {
    const notifType = (type || '').toUpperCase();
    const cat = String(category || '').toUpperCase();

    if (notifType === 'ACCOUNT_LOCKED' || cat.includes('SECURITY')) return { text: 'SECURITY ALERT', tone: 'crimson' };
    if (notifType.includes('DESTRUCTIVE') || notifType.includes('APPROVAL') || notifType.includes('ACTION_REQUIRED')) {
      return { text: 'ACTION REQUIRED', tone: 'crimson' };
    }
    if (notifType.includes('SLA') || notifType.includes('BREACH')) return { text: 'SLA ESCALATION', tone: 'flame' };
    if (cat.includes('COMPLIANCE')) return { text: 'COMPLIANCE NOTICE', tone: 'gold' };
    if (cat.includes('WORKFLOW')) return { text: 'WORKFLOW UPDATE', tone: 'emerald' };
    if (cat.includes('BILLING') || cat.includes('FINANCE')) return { text: 'FINANCE NOTICE', tone: 'gold' };
    return { text: 'FAPOMS NOTIFICATION', tone: 'gold' };
  }

  /**
   * Settles SUPPRESSED a message this job decided must not go, on that leg's own columns. Every other
   * outcome is the message queue's to write.
   */
  private async settleLeg(n: NotificationEntity, leg: NotificationMessageLeg, reason: string): Promise<void> {
    await this.notificationRepo.update(n.id, leg.patch(NotificationStatus.SUPPRESSED, { reason: reason.slice(0, 1000) }));
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
