import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ValidationCaseEntity } from '../../modules/validation/validation-case.entity';
import { ValidationQueryStatus } from '@fapoms/shared';

@Entity('validation_queries')
@Index(['validationCaseId'])
@Index(['assayerId'])
@Index(['status'])
export class ValidationQueryEntity extends BaseEntity {
  @Column({ name: 'validation_case_id', type: 'uuid' })
  validationCaseId: string;

  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  /**
   * The question, as it was asked. Written once and never appended to — the back-and-forth
   * lives in `validation_query_messages`, which is what both clients render.
   *
   * This row used to carry the conversation as well: an `assayer_response` column that the
   * mobile route appended `[timestamp] text` lines to while the web route overwrote the whole
   * thing with the latest message body, and an `attachments` array that accumulated copies of
   * files already hanging off their own messages. Nothing rendered either of them. They are
   * gone; a message has one home.
   */
  @Column({ name: 'query_text', type: 'text' })
  queryText: string;

  @Column({ name: 'target_field', type: 'varchar', length: 150, nullable: true })
  targetField: string | null;

  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt: Date | null;

  @Column({
    type: 'enum',
    enum: ValidationQueryStatus,
    default: ValidationQueryStatus.OPEN,
  })
  status: ValidationQueryStatus;

  /** The returned PDF this clarification is about, so the desk opens the right file. */
  @Column({ name: 'document_id', type: 'uuid', nullable: true })
  documentId: string | null;

  @Column({ name: 'raised_by_user_id', type: 'uuid', nullable: true })
  raisedByUserId: string | null;

  /** Denormalised so a thread list can sort by activity without joining messages. */
  @Column({ name: 'last_message_at', type: 'timestamptz', nullable: true })
  lastMessageAt: Date | null;

  @Column({ name: 'sla_due_date', type: 'timestamptz', nullable: true })
  slaDueDate: Date | null;

  @ManyToOne(() => ValidationCaseEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'validation_case_id' })
  validationCase: ValidationCaseEntity;
}
