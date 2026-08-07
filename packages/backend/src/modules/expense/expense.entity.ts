import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AssayerEntity } from '../assayer/assayer.entity';

/**
 * A reimbursement claim raised by an assayer against one assignment.
 *
 * The mobile app has had a complete expense feature — modal, categories, context action,
 * an "expenses claimed" total on the earnings screen — posting to
 * `POST /assignments/:id/expenses`, an endpoint that did not exist anywhere in the backend.
 * Every claim a field assayer submitted returned 404 and was silently discarded, which is why
 * the app has always shown "₹0 claimed" no matter what was entered. This is the missing half.
 */

export enum ExpenseCategory {
  /** Distance-based travel beyond the contracted allowance. */
  TRAVEL_KM = 'TRAVEL_KM',
  TOLL = 'TOLL',
  FOOD = 'FOOD',
  OTHER = 'OTHER',
}

export enum ExpenseStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

@Entity('assignment_expenses')
@Index(['assignmentId'])
@Index(['assayerId', 'status'])
export class ExpenseEntity extends BaseEntity {
  @Column({ name: 'assignment_id', type: 'uuid' })
  assignmentId: string;

  @ManyToOne(() => AssignmentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assignment_id' })
  assignment: AssignmentEntity;

  // Denormalised from the assignment so an assayer's claims can be listed and totalled
  // without joining through every assignment they have ever held.
  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;

  @Column({ type: 'varchar', length: 20 })
  category: ExpenseCategory;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  amount: number;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** Stored receipt, where one was captured. Claims without evidence are still allowed. */
  @Column({ name: 'receipt_url', type: 'text', nullable: true })
  receiptUrl: string | null;

  @Column({ type: 'varchar', length: 20, default: ExpenseStatus.PENDING })
  status: ExpenseStatus;

  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true })
  reviewedBy: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  /**
   * Required on rejection. A claim refused without a stated reason is not something the
   * assayer can act on, and reimbursement disputes are exactly the thing that needs a record.
   */
  @Column({ name: 'review_notes', type: 'text', nullable: true })
  reviewNotes: string | null;
}
