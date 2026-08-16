import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerPayableStatus } from '@fapoms/shared';

/**
 * Assayer compensation — deliberately separate from client billing (spec §5/§12).
 *
 * Client billing says "what the client owes us". This says "what we owe the
 * assayer". Rates are snapshotted at payable time so historical amounts are
 * immutable even if a master rate changes later (spec §5: historical payable
 * rates).
 */
@Entity('assayer_payables')
@Index(['assayerId'])
@Index(['clientId'])
@Index(['projectId'])
@Index(['assignmentId'])
@Index(['status'])
// One FEE payable per assignment, enforced by the database. Expense reimbursements are payables
// against the same assignment too (one per approved claim) and are marked by
// rate_snapshot.source = 'EXPENSE_CLAIM', so they are excluded. Also in migration
// 1790500000000-BillingUniquenessPerAssignment.
@Index('UQ_assayer_payables_fee_per_assignment', ['assignmentId'], {
  unique: true,
  where: `"assignment_id" IS NOT NULL AND ("rate_snapshot"->>'source') IS DISTINCT FROM 'EXPENSE_CLAIM'`,
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

  @Column({ name: 'assignment_id', type: 'uuid', nullable: true })
  assignmentId: string | null;

  @Column({ type: 'varchar', length: 20, default: AssayerPayableStatus.PENDING })
  status: AssayerPayableStatus;

  @Column({ name: 'base_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  baseAmount: number;

  @Column({ name: 'travel_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  travelAmount: number;

  @Column({ name: 'tax_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  taxAmount: number;

  @Column({ name: 'tds_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  tdsAmount: number;

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
