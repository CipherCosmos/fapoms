import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { FeedbackCategory, FeedbackSeverity, FeedbackStatus } from '@fapoms/shared';

/**
 * One reported item in the feedback & collaboration channel — a bug, an
 * enhancement idea, a process suggestion or a question — plus everything that
 * happens to it. The conversation lives in {@link FeedbackMessageEntity}; this
 * row is the thread root the team triages.
 *
 * ## Two kinds of reporter, one thread
 *
 * Anyone who uses FAPOMS can file feedback, and FAPOMS has two separate identity
 * spaces: internal `users` (staff, clients) and field `assayers` (who have no
 * `users` row, only a mobile token). So exactly one of `reporterUserId` /
 * `reporterAssayerId` is set per thread, mirroring how the notifications table
 * already models its dual recipient. `reporterName` / `reporterRole` snapshot who
 * they were at submit time so the queue reads correctly even if the account later
 * changes.
 *
 * `category` and `severity` are seeded by the heuristic classifier on submit and
 * remain editable by the team during triage — the AI proposes, the team disposes.
 */
@Entity('feedback_threads')
@Index(['reporterUserId'])
@Index(['reporterAssayerId'])
@Index(['status'])
@Index(['category'])
@Index(['assignedToUserId'])
@Index(['lastMessageAt'])
export class FeedbackThreadEntity extends BaseEntity {
  /** The internal user who filed it, or null when a field assayer did. */
  @Column({ name: 'reporter_user_id', type: 'uuid', nullable: true })
  reporterUserId: string | null;

  /** The field assayer who filed it, or null when an internal user did. */
  @Column({ name: 'reporter_assayer_id', type: 'uuid', nullable: true })
  reporterAssayerId: string | null;

  /** Display name captured at submit time. */
  @Column({ name: 'reporter_name', type: 'varchar', length: 200 })
  reporterName: string;

  /** The reporter's primary role/context at submit time, e.g. 'OPERATIONS_MANAGER' or 'ASSAYER'. */
  @Column({ name: 'reporter_role', type: 'varchar', length: 64, nullable: true })
  reporterRole: string | null;

  /** One-line summary the reporter (or the classifier) gives the item. */
  @Column({ name: 'title', type: 'varchar', length: 200 })
  title: string;

  @Column({ name: 'category', type: 'enum', enum: FeedbackCategory, default: FeedbackCategory.OTHER })
  category: FeedbackCategory;

  @Column({ name: 'severity', type: 'enum', enum: FeedbackSeverity, default: FeedbackSeverity.MEDIUM })
  severity: FeedbackSeverity;

  @Column({ name: 'status', type: 'enum', enum: FeedbackStatus, default: FeedbackStatus.OPEN })
  status: FeedbackStatus;

  /** The team member who owns this item, once triaged. */
  @Column({ name: 'assigned_to_user_id', type: 'uuid', nullable: true })
  assignedToUserId: string | null;

  /** The part of the product the item is about, e.g. 'planning', 'data-entry' — from the page they filed from. */
  @Column({ name: 'area', type: 'varchar', length: 100, nullable: true })
  area: string | null;

  /**
   * Where and how it was filed, captured automatically so the team can reproduce:
   * `{ route, platform: 'web'|'mobile', appVersion, userAgent }`.
   */
  @Column({ name: 'app_context', type: 'jsonb', nullable: true })
  appContext: Record<string, unknown> | null;

  /** Denormalised so the queue sorts by activity without joining messages. */
  @Column({ name: 'last_message_at', type: 'timestamptz', nullable: true })
  lastMessageAt: Date | null;

  /**
   * When the team first replied. The response-time SLA is the gap between
   * `createdAt` and this; null means the reporter is still waiting for a first
   * reply, which is what the escalation scanner watches for.
   */
  @Column({ name: 'first_responded_at', type: 'timestamptz', nullable: true })
  firstRespondedAt: Date | null;

  /**
   * How many people this item affects: the reporter plus everyone who added their
   * voice ("me too"). Denormalised from feedback_votes so the desk can sort by
   * impact without a join. Seeded to 1 for the reporter on create.
   */
  @Column({ name: 'vote_count', type: 'int', default: 1 })
  voteCount: number;

  /**
   * What the intelligence layer inferred at submit time and thereafter:
   * `{ suggestedCategory, suggestedSeverity, confidence, keywords, duplicateCandidateIds }`.
   * Kept even after the team overrides `category`/`severity`, so we can measure the
   * classifier and later swap the heuristic for an LLM without losing history.
   */
  @Column({ name: 'ai_meta', type: 'jsonb', nullable: true })
  aiMeta: Record<string, unknown> | null;

  /** Set when the team marks this as a duplicate of another thread. */
  @Column({ name: 'duplicate_of_id', type: 'uuid', nullable: true })
  duplicateOfId: string | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @Column({ name: 'resolved_by_user_id', type: 'uuid', nullable: true })
  resolvedByUserId: string | null;
}
