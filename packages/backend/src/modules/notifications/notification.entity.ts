import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import {
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
  NotificationStatus,
} from '@fapoms/shared';
import { BaseEntity } from '../../core/entities/base.entity';
import { UserEntity } from '../user/user.entity';
import { AssayerEntity } from '../assayer/assayer.entity';

/**
 * A notification is addressed to exactly one recipient, which may be either an internal
 * **user** or an **assayer** — two separate identity spaces (assayers authenticate directly
 * from the `assayers` table and have no `users` row).
 *
 * `user_id` was previously non-null with a hard FK to `users`, which made notifying an assayer
 * impossible: every attempt threw a foreign-key violation that callers swallowed in try/catch,
 * so dispatch and clarification notifications silently never reached the field. Meanwhile the
 * read path already assumed otherwise — an assayer's JWT carries `sub: assayer.id`, and
 * `findMyNotifications` looks up notifications by that id.
 *
 * Both columns are therefore nullable with their own FK, and exactly one is set per row.
 * Integrity is preserved for each recipient type rather than dropping the constraint.
 */
/**
 * This environment runs with `DB_SYNCHRONIZE=true`, so TypeORM re-syncs the schema to whatever
 * is declared here on every boot — and drops anything it doesn't recognise. The dedupe index
 * below was originally created only as raw SQL inside a migration; synchronize doesn't parse
 * migration SQL, decided it was schema drift, and silently deleted it on the next restart. That
 * turned dedupe into a no-op: a second escalation of the same assignment created four fresh
 * notification rows instead of being caught by the (no longer existing) unique constraint,
 * caught only by manually diffing the row count against what the audit log claimed happened.
 * Declaring it here instead means synchronize enforces it rather than erasing it.
 */
@Entity('notifications')
@Index(['userId'])
@Index(['assayerId'])
@Index(['isRead'])
@Index(['status'])
@Index(['category'])
@Index(['entityType', 'entityId'])
@Index(['userId', 'isRead', 'createdAt'])
@Index('UQ_notifications_dedupe', ['dedupeKey'], { unique: true, where: '"dedupe_key" IS NOT NULL' })
export class NotificationEntity extends BaseEntity {
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  /** Set instead of `userId` when the recipient is a field assayer. */
  @Column({ name: 'assayer_id', type: 'uuid', nullable: true })
  assayerId: string | null;

  @Column({ length: 255 })
  title: string;

  @Column({ type: 'text' })
  message: string;

  @Column({ name: 'is_read', type: 'boolean', default: false })
  isRead: boolean;

  @Column({ name: 'link', type: 'varchar', length: 255, nullable: true })
  link: string | null;

  // ── Classification ──────────────────────────────────────────────────────
  /** Stable event key, e.g. `ASSIGNMENT_OFFERED`. `LEGACY` for pre-lifecycle rows. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  type: string | null;

  @Column({ type: 'varchar', length: 32, default: NotificationCategory.SYSTEM })
  category: NotificationCategory;

  @Column({ type: 'varchar', length: 16, default: NotificationPriority.NORMAL })
  priority: NotificationPriority;

  // ── Delivery lifecycle ──────────────────────────────────────────────────
  @Column({ type: 'varchar', length: 16, default: NotificationStatus.PENDING })
  status: NotificationStatus;

  @Column({ type: 'jsonb', default: () => `'["IN_APP"]'::jsonb` })
  channels: NotificationChannel[];

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt: Date | null;

  @Column({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt: Date | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  // ── Traceability / deep linking ─────────────────────────────────────────
  @Column({ name: 'entity_type', type: 'varchar', length: 64, nullable: true })
  entityType: string | null;

  @Column({ name: 'entity_id', type: 'uuid', nullable: true })
  entityId: string | null;

  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, any> | null;

  /** The audit event this notification was raised from. */
  @Column({ name: 'source_event_id', type: 'uuid', nullable: true })
  sourceEventId: string | null;

  /** Whoever performed the triggering action — never notified about their own. */
  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId: string | null;

  // ── Deduplication ───────────────────────────────────────────────────────
  /** Unique where present; a re-fired event collides here instead of duplicating. */
  @Column({ name: 'dedupe_key', type: 'varchar', length: 200, nullable: true })
  dedupeKey: string | null;

  /** Shared by every row of one fan-out, so a broadcast can be traced as one act. */
  @Column({ name: 'group_key', type: 'varchar', length: 200, nullable: true })
  groupKey: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity | null;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity | null;
}
