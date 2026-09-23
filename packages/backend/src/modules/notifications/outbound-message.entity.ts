import {
  Entity, Column, Index, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';
import type { MessageChannel, OutboundMessageStatus } from '@fapoms/shared';

/** The kinds of one-to-one message (email or SMS) the system sends on somebody's behalf. */
export type OutboundMessageKind =
  | 'REGISTRATION_INVITE'
  | 'ACCOUNT_SETUP_LINK'
  | 'APPLICATION_APPROVED'
  | 'APPLICATION_REJECTED'
  | 'APPLICATION_INFO_REQUESTED'
  | 'REFERENCE_NOTICE'
  | 'APP_ACCESS_CREDENTIALS'
  | 'ROSTER_MESSAGE'
  /** A catalog notification's email leg (`NotificationDeliveryWorker`). */
  | 'NOTIFICATION'
  | 'MORNING_DIGEST'
  /** Sent while the caller waits (`EmailService.sendNow`), recorded without the body. */
  | 'REGISTRATION_OTP'
  | 'MFA_CODE'
  | 'BRANCH_AUDIT_PACKET'
  | 'TRANSPORT_TEST'
  | 'TEMPLATE_TEST'
  | 'REGISTRATION_SUBMITTED';

/**
 * One message — an email or a text — somebody's action asked for, from the moment it was asked for
 * until the mail server or SMS gateway took it or it was given up on.
 *
 * Email and SMS share this ledger and its whole lifecycle (claim, retry, sweep, erase-on-settle);
 * only the transport and the sealed payload differ by `channel`. A second table for SMS would have
 * been a second copy of every rule below.
 *
 * Not the notification table: a notification is an event fanned out to an audience, with a bell
 * and a push and per-category preferences. These are the one-to-one messages an action sends to a
 * named address — an invite link, a setup link, a set of credentials — where the person who pressed
 * the button needs to know whether it went.
 *
 * `payload` holds the whole message, and several of these messages are credentials: a registration
 * link, a password-setup link, a temporary password. It is therefore encrypted with the PII key
 * and **erased the moment the row settles**, sent or failed, so the table holds a working credential
 * only for the seconds it spends in flight. Bull's job data (Redis) holds only the row id.
 */
@Entity('outbound_messages')
// Declared here as well as in the migration, for the same reason `notification_settings` gives:
// a synchronize=true environment rebuilds from entities and drops migration-only indexes.
@Index('idx_outbound_messages_unsettled', ['status', 'createdAt'], {
  where: `"status" IN ('QUEUED', 'SENDING')`,
})
@Index('idx_outbound_messages_entity', ['entityType', 'entityId'])
export class OutboundMessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 8, default: 'EMAIL' })
  channel: MessageChannel;

  @Column({ type: 'varchar', length: 48 })
  kind: OutboundMessageKind;

  @Column({ type: 'varchar', length: 16, default: 'QUEUED' })
  status: Exclude<OutboundMessageStatus, 'NOT_QUEUED'>;

  /** An email address, or an E.164 phone number for a text. */
  @Column({ type: 'varchar', length: 320 })
  recipient: string;

  /**
   * Kept after settling so "what did we send them" has an answer without keeping the body. For a
   * text it is the template's name, since an SMS has no subject.
   */
  @Column({ type: 'varchar', length: 500 })
  subject: string;

  /**
   * Encrypted, and null once settled — see the class comment. Email: `{ subject, text, html }`;
   * SMS: `{ text, dltTemplateId }`.
   */
  @Column({ type: 'text', nullable: true })
  payload: string | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @Column({ name: 'entity_type', type: 'varchar', length: 64, nullable: true })
  entityType: string | null;

  @Column({ name: 'entity_id', type: 'varchar', length: 64, nullable: true })
  entityId: string | null;

  /** The person whose action asked for it — the only non-administrator who may read its status. */
  @Column({ name: 'requested_by', type: 'uuid', nullable: true })
  requestedBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt: Date | null;
}
