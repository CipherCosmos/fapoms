import { Column, Entity, Index, Unique, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { FeedbackThreadEntity } from './feedback-thread.entity';

/**
 * One "me too" on a feedback item.
 *
 * Enterprise feedback systems prioritise by impact, not just recency — a bug that
 * hits forty people outranks a fresh one that hits one. Rather than let those forty
 * file forty duplicates, they add their voice here, and the team sees a single item
 * with a weight. A voter is one of the two identity spaces (user or assayer), and
 * the partial unique indexes below stop the same person voting twice.
 */
@Entity('feedback_votes')
@Index(['feedbackThreadId'])
// One vote per person per thread, enforced separately for each identity space so a
// null in the other column never collides (Postgres treats NULLs as distinct, which
// a plain composite unique would allow to duplicate).
@Unique('uq_feedback_vote_user', ['feedbackThreadId', 'voterUserId'])
@Unique('uq_feedback_vote_assayer', ['feedbackThreadId', 'voterAssayerId'])
export class FeedbackVoteEntity extends BaseEntity {
  @Column({ name: 'feedback_thread_id', type: 'uuid' })
  feedbackThreadId: string;

  @ManyToOne(() => FeedbackThreadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'feedback_thread_id' })
  thread?: FeedbackThreadEntity;

  @Column({ name: 'voter_user_id', type: 'uuid', nullable: true })
  voterUserId: string | null;

  @Column({ name: 'voter_assayer_id', type: 'uuid', nullable: true })
  voterAssayerId: string | null;
}
