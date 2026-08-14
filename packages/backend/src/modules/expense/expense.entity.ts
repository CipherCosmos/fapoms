import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
// Single source of truth lives in @fapoms/shared so backend, web and mobile validate the same set.
// Re-exported here to keep existing `from './expense.entity'` imports working unchanged.
import { ExpenseCategory, ExpenseStatus } from '@fapoms/shared';
export { ExpenseCategory, ExpenseStatus } from '@fapoms/shared';

/**
 * A reimbursement claim raised by an assayer against one assignment.
 *
 * The mobile app has had a complete expense feature — modal, categories, context action,
 * an "expenses claimed" total on the earnings screen — posting to
 * `POST /assignments/:id/expenses`, an endpoint that did not exist anywhere in the backend.
 * Every claim a field assayer submitted returned 404 and was silently discarded, which is why
 * the app has always shown "₹0 claimed" no matter what was entered. This is the missing half.
 */

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

  /**
   * The payable raised when this claim was approved — how the assayer actually gets the money.
   *
   * Approval used to be the end of the road: the claim reached APPROVED and no row anywhere
   * owed anyone anything, so the reimbursement was never paid. It now raises an
   * `assayer_payables` row, which already carries approval, TDS, disbursement and a payment
   * history, and this column points at it.
   *
   * There is deliberately no PAID status on the claim. Whether the money has gone out is a fact
   * about the payable, and duplicating it here would create two answers that could disagree —
   * read it through this link instead. Uniquely indexed, so approving twice cannot raise a
   * second payable and pay the claim twice.
   */
  @Index({ unique: true, where: 'reimbursement_payable_id IS NOT NULL' })
  @Column({ name: 'reimbursement_payable_id', type: 'uuid', nullable: true })
  reimbursementPayableId: string | null;
}
