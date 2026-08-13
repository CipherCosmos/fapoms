import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { FeedbackThreadEntity } from './feedback-thread.entity';
import { FeedbackAuthorType } from '@fapoms/shared';

/**
 * One message in a feedback thread.
 *
 * `authorType` records the *side* — the reporter, the team, or the system — while
 * `authorUserId` / `authorAssayerId` record *who* (dual identity, same as the
 * thread's reporter). SYSTEM lines (status changes, assignment, triage notes)
 * carry neither.
 *
 * `isInternal` marks a team-only note: visible to PRODUCT_SUPPORT and admins, never
 * returned to the reporter. This is what lets the team collaborate on an item
 * ("this is the same as last week's cache bug") without leaking half-formed
 * discussion back to the person who filed it.
 */
@Entity('feedback_messages')
@Index(['feedbackThreadId', 'createdAt'])
export class FeedbackMessageEntity extends BaseEntity {
  @Column({ name: 'feedback_thread_id', type: 'uuid' })
  feedbackThreadId: string;

  @ManyToOne(() => FeedbackThreadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'feedback_thread_id' })
  thread?: FeedbackThreadEntity;

  @Column({ name: 'author_type', type: 'enum', enum: FeedbackAuthorType })
  authorType: FeedbackAuthorType;

  /** Set when a team member or an internal-user reporter wrote it. */
  @Column({ name: 'author_user_id', type: 'uuid', nullable: true })
  authorUserId: string | null;

  /** Set when a field assayer reporter wrote it. */
  @Column({ name: 'author_assayer_id', type: 'uuid', nullable: true })
  authorAssayerId: string | null;

  @Column({ name: 'author_name', type: 'varchar', length: 200, nullable: true })
  authorName: string | null;

  @Column({ name: 'body', type: 'text', nullable: true })
  body: string | null;

  /** Screenshots / logs / files attached to the message. */
  @Column({ name: 'attachments', type: 'jsonb', nullable: true })
  attachments: { url: string; fileName: string; fileType: string }[] | null;

  /** Team-only note, never shown to the reporter. */
  @Column({ name: 'is_internal', type: 'boolean', default: false })
  isInternal: boolean;

  @Column({ name: 'is_read', type: 'boolean', default: false })
  isRead: boolean;

  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt: Date | null;
}
