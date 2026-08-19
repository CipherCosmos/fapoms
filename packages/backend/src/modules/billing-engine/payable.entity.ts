import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerPayableStatus } from '@fapoms/shared';

/**
 * What we owe an assayer for one assignment — the assayer-side line.
 *
 * One fee payable per assignment, created by `bookAssignment` when the assignment completes and
 * priced by `assignmentMoney`. Approved expense claims are payables against the same assignment
 * too (one per claim, `expenseId` set), because an expense payout is the same act as a fee
 * payout and a second route to "pay an assayer" would mean two places to look.
 *
 *   PENDING ("Due") → APPROVED → PAID   and the `onHold` flag, which blocks approval and payment.
 *
 * PAID is reached only by `recordDisbursement`; nothing sets it by hand. Rates are snapshotted
 * at booking so the amount is immutable even if a master rate changes later.
 */
@Entity('assayer_payables')
@Index(['assayerId'])
@Index(['clientId'])
@Index(['projectId'])
@Index(['status'])
// One FEE payable per assignment, enforced by the database. Reimbursements carry `expense_id`
// and are excluded. The name is load-bearing: `isUniqueViolation` matches on it.
@Index('UQ_assayer_payables_fee_per_assignment', ['assignmentId'], {
  unique: true,
  where: '"expense_id" IS NULL',
})
// One payable per approved expense claim — the database's answer to the double-reimbursement
// window a retried approval used to open.
@Index('UQ_assayer_payables_expense', ['expenseId'], {
  unique: true,
  where: '"expense_id" IS NOT NULL',
})
export class AssayerPayableEntity extends BaseEntity {
  @Column({ name: 'payable_number', length: 50, unique: true })
  payableNumber: string;

  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @Column({ name: 'client_id', type: 'uuid', nullable: true })
  clientId: string | null;

  @Column({ name: 'project_id', type: 'uuid', nullable: true })
  projectId: string | null;

  @Column({ name: 'assignment_id', type: 'uuid' })
  assignmentId: string;

  /** Set on reimbursement payables; null on the fee payable. */
  @Column({ name: 'expense_id', type: 'uuid', nullable: true })
  expenseId: string | null;

  @Column({ type: 'varchar', length: 20, default: AssayerPayableStatus.PENDING })
  status: AssayerPayableStatus;

  /** A held payable cannot be approved or paid. */
  @Column({ name: 'on_hold', type: 'boolean', default: false })
  onHold: boolean;

  @Column({ name: 'hold_reason', type: 'text', nullable: true })
  holdReason: string | null;

  @Column({ name: 'base_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  baseAmount: number;

  @Column({ name: 'travel_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  travelAmount: number;

  @Column({ name: 'tax_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  taxAmount: number;

  @Column({ name: 'tds_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  tdsAmount: number;

  /** base + travel − TDS: what the assayer actually receives. */
  @Column({ name: 'total_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  totalAmount: number;

  @Column({ length: 3, default: 'INR' })
  currency: string;

  @Column({ name: 'paid_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  paidAmount: number;

  @Column({ name: 'rate_snapshot', type: 'jsonb', nullable: true })
  rateSnapshot: Record<string, unknown> | null;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @Column({ name: 'approved_by', type: 'uuid', nullable: true })
  approvedBy: string | null;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  @Column({ name: 'paid_by', type: 'uuid', nullable: true })
  paidBy: string | null;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;
}
