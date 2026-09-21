import { NotificationStatus } from '@fapoms/shared';
import type { MessageChannel } from '@fapoms/shared';
import type { NotificationEntity } from './notification.entity';

/** The notification columns the email and text legs write. */
export type NotificationLegPatch = Partial<Pick<
  NotificationEntity,
  'emailStatus' | 'emailedAt' | 'emailFailureReason' | 'smsStatus' | 'textedAt' | 'smsFailureReason'
>>;

/**
 * One message leg of a notification — its email or its text — as the columns and job it owns.
 *
 * Both legs have the same lifecycle (PENDING owed → SENT with the message queue → DELIVERED / FAILED
 * / SUPPRESSED written back when the queued message settles) on their own three columns. Every place
 * that walks that lifecycle — the delivery worker's claim and put-back, the sweeper's re-queue and
 * rescue, the outbox's write-back — reads the column names from here, so the two legs are one rule
 * applied twice rather than two copies that can drift apart.
 */
export interface NotificationMessageLeg {
  channel: MessageChannel;
  /** The job on the notification queue that decides and hands over this leg. */
  job: 'deliver-email' | 'deliver-sms';
  /** For logs. */
  noun: 'email' | 'text';
  /** The status property, for `find` where-clauses and reading a row. */
  statusKey: 'emailStatus' | 'smsStatus';
  /** SQL column names, for conditional UPDATEs. */
  statusColumn: 'email_status' | 'sms_status';
  /** Stamped by the claim, re-stamped by the settle; the sweeper's rescue keys off it. */
  atColumn: 'emailed_at' | 'texted_at';
  /** What a notification records when this channel has no transport configured. */
  notSetUpReason: string;
  /** The patch that records `status` (and optionally a reason and a time) on this leg's columns. */
  patch(status: NotificationStatus, fields?: { reason?: string | null; at?: Date }): NotificationLegPatch;
}

export const NOTIFICATION_MESSAGE_LEGS: Record<MessageChannel, NotificationMessageLeg> = {
  EMAIL: {
    channel: 'EMAIL',
    job: 'deliver-email',
    noun: 'email',
    statusKey: 'emailStatus',
    statusColumn: 'email_status',
    atColumn: 'emailed_at',
    notSetUpReason: 'Email is not configured, so none was sent.',
    patch: (status, fields = {}) => ({
      emailStatus: status,
      ...(fields.at !== undefined ? { emailedAt: fields.at } : {}),
      ...(fields.reason !== undefined ? { emailFailureReason: fields.reason } : {}),
    }),
  },
  SMS: {
    channel: 'SMS',
    job: 'deliver-sms',
    noun: 'text',
    statusKey: 'smsStatus',
    statusColumn: 'sms_status',
    atColumn: 'texted_at',
    notSetUpReason: 'SMS is not configured, so no text was sent.',
    patch: (status, fields = {}) => ({
      smsStatus: status,
      ...(fields.at !== undefined ? { textedAt: fields.at } : {}),
      ...(fields.reason !== undefined ? { smsFailureReason: fields.reason } : {}),
    }),
  },
};

/** Both legs, email first — the order every sweep walks them in. */
export const NOTIFICATION_MESSAGE_LEG_LIST: readonly NotificationMessageLeg[] = [
  NOTIFICATION_MESSAGE_LEGS.EMAIL,
  NOTIFICATION_MESSAGE_LEGS.SMS,
];
