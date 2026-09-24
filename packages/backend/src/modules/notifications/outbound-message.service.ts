import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import type { JobOptions, Queue } from 'bull';
import { In, IsNull, LessThan, LessThanOrEqual, Repository } from 'typeorm';
import { NotificationStatus } from '@fapoms/shared';
import type { MessageChannel, OutboundMessageReceipt } from '@fapoms/shared';
import { OutboundMessageEntity, OutboundMessageKind } from './outbound-message.entity';
import { NotificationEntity } from './notification.entity';
import { OUTBOUND_EMAIL_QUEUE, OUTBOUND_SMS_QUEUE } from './notification.constants';
import { decryptField, encryptField } from '../../infrastructure/security/field-encryption';
import { FAILED_JOB_RETENTION } from '../../infrastructure/queue/queued-job';
import { NOTIFICATION_MESSAGE_LEG_LIST } from './notification-message-legs';
import { errorAlerter, type ErrorAlerter } from '../../infrastructure/observability/error-alerter';
import {
  CHANNEL_HEALTH_WINDOW_MS, readChannelHealth, type ChannelHealth,
} from './messaging-health';

/**
 * The `entityType` a notification's email or text leg is queued under (`NotificationDeliveryWorker`).
 * When a row of this type settles, its outcome is written back onto the notification — see
 * `settleNotificationLegs`.
 */
export const NOTIFICATION_MESSAGE_ENTITY = 'NOTIFICATION';

/** Why a settled email failed, in words a clerk can act on. Shared with the sweep's write-back. */
export const EMAIL_NOT_SET_UP_REASON = 'Email is not set up on this system, so it was not sent.';
const GAVE_UP_REASON = 'It could not be sent within a day, so it was given up on. Send it again if it is still needed.';
const ABANDONED_REASON = 'The sender stopped before the mail server confirmed it, so it may not have arrived. '
  + 'Send it again if the person says they did not get it.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A settled message's outcome, in channel-neutral terms. Which notification columns it lands on —
 * `email_*` or `sms_*` — is decided per returned row by its `channel` (`notification-message-legs.ts`).
 * `notSetUp` asks each leg for its own "not configured" wording instead of `reason`.
 */
type NotificationLegOutcome = {
  status: NotificationStatus;
  reason: string | null;
  at?: Date;
  notSetUp?: boolean;
};

/**
 * The job name, read by both halves so they cannot drift (see `queued-job.ts` on why that matters).
 * The same name on both channel queues; the queue decides the channel.
 */
export const OUTBOUND_MESSAGE_JOB = 'send-outbound-message';

export interface OutboundMessageJobData {
  /** Only the id. The message — which may be a credential — never goes to Redis. */
  outboundMessageId: string;
}

/**
 * Five tries, 10 s → 20 s → 40 s → 80 s apart: about two and a half minutes of patience for a mail
 * server having a bad moment, which is as long as a person watching "Sending…" should wait before
 * being told to hand the link over another way.
 */
export const OUTBOUND_MESSAGE_JOB_OPTIONS: JobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: { age: 60 * 60, count: 1000 },
  removeOnFail: FAILED_JOB_RETENTION,
};

export type OutboundMessageRequest = {
  kind: OutboundMessageKind;
  /** An email address, or a phone number for a text. */
  to: string;
  text: string;
  /** What the email is about, so a record can find the emails sent for it. */
  entityType?: string | null;
  entityId?: string | null;
  /** Whose action asked for it; the person allowed to watch it. */
  requestedBy?: string | null;
} & (
  | { channel: 'EMAIL'; subject: string; html?: string }
  /** `label` is what the ledger shows in place of a subject (the template's name). */
  | { channel: 'SMS'; label: string; dltTemplateId?: string | null }
);

type SealedMessage =
  | { subject: string; text: string; html?: string }
  | { text: string; dltTemplateId?: string | null };

export type OpenedEmail = { channel: 'EMAIL'; to: string; subject: string; text: string; html?: string };
export type OpenedSms = { channel: 'SMS'; to: string; text: string; dltTemplateId?: string | null };

export interface OpenedMessage {
  row: OutboundMessageEntity;
  message: OpenedEmail | OpenedSms | null;
}

/**
 * Records emails for sending and answers where each one has got to.
 *
 * The request that wants an email calls `enqueue` and gets a receipt back straight away; the worker
 * (`OutboundEmailWorker`) does the sending. The database row is the source of truth and the Bull
 * job is only a nudge, the same stance `NotificationSweeper` takes: if Redis is down when the row
 * is written, the row still exists and the sweep puts it on the queue later.
 *
 * It is also the only thing that sends a notification's email. The notification worker decides
 * whether and what to email, hands the message over here (`entityType: 'NOTIFICATION'`) and marks
 * the notification's `email_status` SENT — "with the mail queue". Every place a row settles
 * (`markSent`, `markFailed`, the sweep's give-ups) then writes the outcome back onto that
 * notification with one conditional UPDATE, so `email_status` still ends DELIVERED, FAILED or
 * SUPPRESSED with a reason, and there is one retry policy for email rather than two.
 */
@Injectable()
export class OutboundMessageService {
  private readonly logger = new Logger(OutboundMessageService.name);

  /** A row still QUEUED this long after it was written has lost its job; put it back. */
  static readonly STRANDED_AFTER_MS = 2 * 60_000;
  /** Longer than every retry combined. Past this a SENDING row's worker is gone. */
  static readonly ABANDONED_AFTER_MS = 15 * 60_000;
  /** A queued email nobody has managed to send in a day is not going to be useful when it arrives. */
  static readonly GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
  /** Settled rows are kept this long, for "did we email them?", then deleted. */
  static readonly KEEP_SETTLED_FOR_MS = 90 * 24 * 60 * 60_000;
  private static readonly SWEEP_BATCH = 200;
  /** How long a message held back by a broken channel waits before the sweep tries it again. */
  static readonly TRANSPORT_BACKOFF_MS = 10 * 60_000;

  /** Where "every send on a channel is failing" is reported. Replaceable in tests. */
  alerter: Pick<ErrorAlerter, 'report'> = errorAlerter;

  constructor(
    @InjectRepository(OutboundMessageEntity)
    private readonly repo: Repository<OutboundMessageEntity>,
    @InjectQueue(OUTBOUND_EMAIL_QUEUE)
    private readonly emailQueue: Queue,
    @InjectRepository(NotificationEntity)
    private readonly notifications: Repository<NotificationEntity>,
    @InjectQueue(OUTBOUND_SMS_QUEUE)
    private readonly smsQueue: Queue,
  ) {}

  static jobIdFor(id: string): string {
    return `outbound-message:${id}`;
  }

  /** Each channel sends from its own queue (see `OUTBOUND_SMS_QUEUE`). */
  private queueFor(channel: MessageChannel): Queue {
    return channel === 'SMS' ? this.smsQueue : this.emailQueue;
  }

  private static noun(channel: MessageChannel): string {
    return channel === 'SMS' ? 'text' : 'email';
  }

  /**
   * Record an email and put it on the queue. Never throws.
   *
   * The action that wanted the email has already happened by the time this is called — an
   * application exists, a password link has been minted — so a failure here must not undo it or
   * turn it into an error page. It comes back as `NOT_QUEUED` instead, and the screen offers the
   * link to hand over another way, exactly as it does for an email that failed to send.
   */
  async enqueue(request: OutboundMessageRequest): Promise<OutboundMessageReceipt> {
    const { channel } = request;
    const to = (request.to ?? '').trim();
    if (!to) {
      const error = channel === 'SMS' ? 'There is no phone number to send to.' : 'There is no email address to send to.';
      return { id: null, channel, status: 'NOT_QUEUED', to: '', error };
    }

    let row: OutboundMessageEntity;
    try {
      const sealed: SealedMessage = request.channel === 'SMS'
        ? { text: request.text, dltTemplateId: request.dltTemplateId ?? null }
        : { subject: request.subject, text: request.text, html: request.html };
      row = await this.repo.save(this.repo.create({
        channel,
        kind: request.kind,
        status: 'QUEUED',
        recipient: to.slice(0, 320),
        subject: (request.channel === 'SMS' ? request.label : request.subject ?? '').slice(0, 500),
        payload: encryptField(JSON.stringify(sealed)),
        attempts: 0,
        entityType: request.entityType ?? null,
        entityId: request.entityId ?? null,
        requestedBy: request.requestedBy ?? null,
      }));
    } catch (err: any) {
      this.logger.error(`Could not record a ${request.kind} ${OutboundMessageService.noun(channel)}: ${err?.message ?? err}`);
      return {
        id: null,
        channel,
        status: 'NOT_QUEUED',
        to,
        error: `The ${OutboundMessageService.noun(channel)} could not be queued. Hand the details over another way.`,
      };
    }

    await this.nudge(row.id, channel);
    return { id: row.id, channel, status: 'QUEUED', to };
  }

  /**
   * Record an email that was sent while its caller waited (`EmailService.sendNow`).
   *
   * Written already settled and with no payload — the message went (or did not) before this row
   * existed, and a one-time code or a branch packet has no business being stored. It exists so that
   * "what did the system email, to whom, and did it go" has one answer: this table. Never throws; a
   * failure to record is logged and the send's own outcome still comes back.
   */
  async recordImmediate(input: {
    channel: MessageChannel;
    kind: OutboundMessageKind;
    to: string;
    /** The email's subject, or the text's template name. */
    subject: string;
    entityType?: string | null;
    entityId?: string | null;
    requestedBy?: string | null;
    sent: boolean;
    error?: string;
  }): Promise<OutboundMessageReceipt> {
    const now = new Date();
    try {
      const row = await this.repo.save(this.repo.create({
        channel: input.channel,
        kind: input.kind,
        status: input.sent ? 'SENT' : 'FAILED',
        recipient: (input.to ?? '').slice(0, 320),
        subject: (input.subject ?? '').slice(0, 500),
        payload: null,
        attempts: 1,
        lastError: input.sent ? null : (input.error ?? 'The send failed.').slice(0, 1000),
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        requestedBy: input.requestedBy ?? null,
        sentAt: input.sent ? now : null,
        failedAt: input.sent ? null : now,
      }));
      return OutboundMessageService.toReceipt(row);
    } catch (err: any) {
      this.logger.warn(
        `Could not record a ${input.kind} ${OutboundMessageService.noun(input.channel)} that was ${input.sent ? 'sent' : 'not sent'}: ${err?.message ?? err}`,
      );
      return {
        id: null, channel: input.channel, status: input.sent ? 'SENT' : 'FAILED', to: input.to,
        error: input.sent ? null : input.error ?? null,
      };
    }
  }

  /** Puts a row's job on its channel's queue. A Redis failure is logged and left for the sweep. */
  private async nudge(id: string, channel: MessageChannel): Promise<boolean> {
    try {
      await this.queueFor(channel).add(
        OUTBOUND_MESSAGE_JOB,
        { outboundMessageId: id } satisfies OutboundMessageJobData,
        { ...OUTBOUND_MESSAGE_JOB_OPTIONS, jobId: OutboundMessageService.jobIdFor(id) },
      );
      return true;
    } catch (err: any) {
      this.logger.warn(
        `${channel === 'SMS' ? 'Text' : 'Email'} ${id} is recorded but not yet queued (${err?.message ?? err}); the sweep will retry.`,
      );
      return false;
    }
  }

  /** Where a message has got to, for the person who asked for it or an administrator. */
  async receiptFor(id: string, viewer: { id: string; isAdmin: boolean }): Promise<OutboundMessageReceipt> {
    const row = await this.repo.findOne({ where: { id } });
    // Somebody else's email reads as missing rather than forbidden, so ids cannot be probed.
    if (!row || (!viewer.isAdmin && row.requestedBy !== viewer.id)) {
      throw new NotFoundException('That message could not be found.');
    }
    return OutboundMessageService.toReceipt(row);
  }

  /** Several at once, for a screen watching a batch. Unknown or unreadable ids are left out. */
  async receiptsFor(ids: string[], viewer: { id: string; isAdmin: boolean }): Promise<OutboundMessageReceipt[]> {
    const unique = [...new Set(ids)].slice(0, 500);
    if (unique.length === 0) return [];
    const rows = await this.repo.find({ where: { id: In(unique) } });
    return rows
      .filter((row) => viewer.isAdmin || row.requestedBy === viewer.id)
      .map(OutboundMessageService.toReceipt);
  }

  static toReceipt(row: OutboundMessageEntity): OutboundMessageReceipt {
    return {
      id: row.id,
      channel: row.channel,
      status: row.status,
      to: row.recipient,
      error: row.status === 'FAILED' ? row.lastError : null,
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    };
  }

  // ── The worker's half ────────────────────────────────────────────────────

  /**
   * Take a row for sending: QUEUED → SENDING in one conditional UPDATE, so two copies of the job
   * (a Bull retry racing the sweep, say) cannot both send it. Null when somebody else has it or it
   * has already settled.
   */
  async claim(id: string): Promise<OpenedMessage | null> {
    const result = await this.repo
      .createQueryBuilder()
      .update(OutboundMessageEntity)
      .set({ status: 'SENDING', attempts: () => 'attempts + 1' })
      .where('id = :id', { id })
      .andWhere('status = :queued', { queued: 'QUEUED' })
      .execute();
    if (!result.affected) return null;

    const row = await this.repo.findOne({ where: { id } });
    if (!row) return null;
    return { row, message: OutboundMessageService.open(row) };
  }

  /** The decrypted message, or null when it cannot be read (erased, or the key has changed). */
  static open(row: OutboundMessageEntity): OpenedMessage['message'] {
    if (!row.payload) return null;
    try {
      const sealed = JSON.parse(decryptField(row.payload)) as Record<string, any>;
      if (typeof sealed?.text !== 'string') return null;
      if (row.channel === 'SMS') {
        return { channel: 'SMS', to: row.recipient, text: sealed.text, dltTemplateId: sealed.dltTemplateId ?? null };
      }
      return { channel: 'EMAIL', to: row.recipient, subject: sealed.subject ?? row.subject, text: sealed.text, html: sealed.html };
    } catch {
      return null;
    }
  }

  async markSent(id: string): Promise<void> {
    const now = new Date();
    const settled = await this.repo
      .createQueryBuilder()
      .update(OutboundMessageEntity)
      .set({ status: 'SENT', sentAt: now, lastError: null, payload: null, retryAfter: null })
      .where('id = :id', { id })
      .returning(['channel', 'entityType', 'entityId'])
      .execute();
    await this.settleNotificationLegs(settled.raw, {
      status: NotificationStatus.DELIVERED,
      at: now,
      reason: null,
    });
  }

  /**
   * `notSetUp` marks the failure as "no transport configured", which a notification records as
   * SUPPRESSED rather than FAILED: email being switched off is the platform's state, not something
   * that went wrong with this message.
   */
  async markFailed(id: string, reason: string, opts: { notSetUp?: boolean } = {}): Promise<void> {
    const settled = await this.repo
      .createQueryBuilder()
      .update(OutboundMessageEntity)
      .set({ status: 'FAILED', failedAt: new Date(), lastError: reason.slice(0, 1000), payload: null })
      .where('id = :id', { id })
      .returning(['channel', 'entityType', 'entityId'])
      .execute();
    await this.settleNotificationLegs(settled.raw, opts.notSetUp
      ? { status: NotificationStatus.SUPPRESSED, reason: null, notSetUp: true }
      : { status: NotificationStatus.FAILED, reason: reason.slice(0, 1000) });
  }

  /**
   * Writes a settled message's outcome back onto the notifications it was sent for — the email
   * columns for an email, the SMS columns for a text.
   *
   * `returned` is the settling UPDATE's RETURNING rows, so exactly the rows that statement settled
   * are written back — never a guess from a second query. Each row lands only on its own channel's
   * leg: an email settling must never touch `sms_status`, nor a text `email_status` (one sweep UPDATE
   * can return both). Conditional on that leg's status being SENT ("with the message queue"): a
   * notification already settled keeps its answer, and a row that is not a notification's message
   * matches nothing. Never throws — the message's own outcome is already recorded, and failing here
   * would make the worker retry a send it cannot claim again.
   */
  private async settleNotificationLegs(returned: unknown, outcome: NotificationLegOutcome): Promise<void> {
    for (const leg of NOTIFICATION_MESSAGE_LEG_LIST) {
      const ids = OutboundMessageService.notificationIdsIn(returned, leg.channel);
      if (!ids.length) continue;
      try {
        await this.notifications
          .createQueryBuilder()
          .update(NotificationEntity)
          .set(leg.patch(outcome.status, {
            reason: outcome.notSetUp ? leg.notSetUpReason : outcome.reason,
            ...(outcome.at ? { at: outcome.at } : {}),
          }))
          .where('id IN (:...ids)', { ids })
          .andWhere(`${leg.statusColumn} = :handedOff`, { handedOff: NotificationStatus.SENT })
          .execute();
      } catch (err: any) {
        this.logger.error(
          `Could not record the ${leg.noun} outcome (${outcome.status}) on ${ids.length} notification(s): ${err?.message ?? err}`,
        );
      }
    }
  }

  /** The notification ids among an UPDATE's RETURNING rows (`channel`, `entity_type`, `entity_id`) for one channel. */
  static notificationIdsIn(returned: unknown, channel: MessageChannel): string[] {
    const rows = Array.isArray(returned) ? returned : [];
    const ids = rows
      .filter((r: any) => (r?.channel ?? 'EMAIL') === channel
        && r?.entity_type === NOTIFICATION_MESSAGE_ENTITY && UUID.test(String(r?.entity_id ?? '')))
      .map((r: any) => String(r.entity_id));
    return [...new Set(ids)];
  }

  /** A transient failure with retries left: back to QUEUED, so the retry can claim it again. */
  async release(id: string, reason: string): Promise<void> {
    await this.repo.update({ id, status: 'SENDING' }, { status: 'QUEUED', lastError: reason.slice(0, 1000) });
  }

  /**
   * The CHANNEL failed (credentials refused, server unreachable) and the quick retries are spent:
   * back to QUEUED — not FAILED — with `retry_after` pushed out, so the sweep tries it again later
   * and fixing the credential delivers the backlog. The sweep's one-day give-up still applies.
   */
  async deferForTransport(id: string, reason: string, now = Date.now()): Promise<void> {
    await this.repo.update(
      { id, status: 'SENDING' },
      {
        status: 'QUEUED',
        lastError: reason.slice(0, 1000),
        retryAfter: new Date(now + OutboundMessageService.TRANSPORT_BACKOFF_MS),
      },
    );
  }

  /** Per channel: sends and failures in the last half hour, and whether the channel reads as down. */
  channelHealth(now = Date.now()): Promise<ChannelHealth[]> {
    return readChannelHealth((sql, params) => this.repo.query(sql, params), now);
  }

  /**
   * Says so, out loud, when a channel has failures in the window and not one success.
   *
   * Nothing did before: a revoked Gmail app password failed every email for a morning and the only
   * trace was each message's own FAILED row. The alerter groups by channel and rate-limits itself
   * (one per key per fifteen minutes), so a two-minute sweep cannot flood the receiver.
   */
  private async reportFailingChannels(now: number): Promise<void> {
    let health: ChannelHealth[];
    try {
      health = await this.channelHealth(now);
    } catch (err: any) {
      this.logger.warn(`Could not read channel health: ${err?.message ?? err}`);
      return;
    }
    for (const h of health) {
      if (!h.down) continue;
      this.logger.error(
        `Every ${OutboundMessageService.noun(h.channel)} in the last ${CHANNEL_HEALTH_WINDOW_MS / 60_000} minutes failed `
          + `(${h.failing} failing, 0 sent). Check the ${h.channel === 'SMS' ? 'SMS gateway' : 'mail'} settings.`,
      );
      this.alerter.report({ method: 'JOB', route: `/outbound-messages/${h.channel.toLowerCase()}`, errorName: 'AllSendsFailing' });
    }
  }

  // ── The sweep ────────────────────────────────────────────────────────────

  /**
   * Keeps "queued" from quietly meaning "lost".
   *
   * - QUEUED past the grace period with no live job (Redis was down at enqueue, or a job died
   *   outside the handler): queued again. A job that exists and is merely waiting out a backoff is
   *   left alone — re-adding under the same job id is a no-op for Bull.
   * - QUEUED for a whole day: given up on, because a registration link that arrives tomorrow is a
   *   worse outcome than the desk being told today that it never went.
   * - SENDING long past every retry: the worker died mid-send. Recorded as failed with a reason
   *   that says it may or may not have arrived, rather than left looking like it is still going.
   * - Either give-up on a notification's email is written back onto the notification too.
   * - Settled rows past the retention period: deleted.
   */
  async sweep(now = Date.now()): Promise<{ requeued: number; abandoned: number; expired: number; purged: number }> {
    const expired = await this.repo
      .createQueryBuilder()
      .update(OutboundMessageEntity)
      .set({
        status: 'FAILED',
        failedAt: new Date(now),
        payload: null,
        lastError: GAVE_UP_REASON,
      })
      .where('status = :queued', { queued: 'QUEUED' })
      .andWhere('created_at < :cutoff', { cutoff: new Date(now - OutboundMessageService.GIVE_UP_AFTER_MS) })
      .returning(['channel', 'entityType', 'entityId'])
      .execute();
    await this.settleNotificationLegs(expired.raw, {
      status: NotificationStatus.FAILED,
      reason: GAVE_UP_REASON,
    });

    const abandoned = await this.repo
      .createQueryBuilder()
      .update(OutboundMessageEntity)
      .set({
        status: 'FAILED',
        failedAt: new Date(now),
        payload: null,
        lastError: ABANDONED_REASON,
      })
      .where('status = :sending', { sending: 'SENDING' })
      .andWhere('updated_at < :cutoff', { cutoff: new Date(now - OutboundMessageService.ABANDONED_AFTER_MS) })
      .returning(['channel', 'entityType', 'entityId'])
      .execute();
    await this.settleNotificationLegs(abandoned.raw, {
      status: NotificationStatus.FAILED,
      reason: ABANDONED_REASON,
    });

    // A row a broken channel deferred (`retry_after`) is left alone until its backoff passes.
    const strandedBefore = LessThan(new Date(now - OutboundMessageService.STRANDED_AFTER_MS));
    const stranded = await this.repo.find({
      where: [
        { status: 'QUEUED', updatedAt: strandedBefore, retryAfter: IsNull() },
        { status: 'QUEUED', updatedAt: strandedBefore, retryAfter: LessThanOrEqual(new Date(now)) },
      ],
      order: { createdAt: 'ASC' },
      take: OutboundMessageService.SWEEP_BATCH,
      select: { id: true, channel: true },
    });
    let requeued = 0;
    for (const { id, channel } of stranded) {
      try {
        const existing = await this.queueFor(channel).getJob(OutboundMessageService.jobIdFor(id));
        if (existing) {
          const state = await existing.getState();
          // A failed job keeps its id for a week, and Bull will not add a second job under it.
          if (state === 'failed' || state === 'completed') await existing.remove();
          else continue;
        }
      } catch (err: any) {
        this.logger.warn(`Sweep could not inspect the job for ${OutboundMessageService.noun(channel)} ${id}: ${err?.message ?? err}`);
        break;
      }
      if (!(await this.nudge(id, channel))) break;
      requeued++;
    }

    const purged = await this.repo
      .createQueryBuilder()
      .delete()
      .from(OutboundMessageEntity)
      .where('status IN (:...settled)', { settled: ['SENT', 'FAILED'] })
      .andWhere('updated_at < :cutoff', { cutoff: new Date(now - OutboundMessageService.KEEP_SETTLED_FOR_MS) })
      .execute();

    const summary = {
      requeued,
      abandoned: abandoned.affected ?? 0,
      expired: expired.affected ?? 0,
      purged: purged.affected ?? 0,
    };
    if (summary.requeued || summary.abandoned || summary.expired) {
      this.logger.warn(
        `Message sweep: re-queued ${summary.requeued}, abandoned ${summary.abandoned}, gave up on ${summary.expired}.`,
      );
    }
    await this.reportFailingChannels(now);
    return summary;
  }
}
