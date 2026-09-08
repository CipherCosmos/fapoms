import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerPayableStatus } from '@fapoms/shared';
import { encryptedColumn } from '../../infrastructure/security/field-encryption';

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
// The invoice's lines are read together (totals recompute, approval, the reveal) — indexed so
// none of those is a table scan.
@Index(['assayerInvoiceId'])
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

  /**
   * The assayer invoice this payable rides, or null while it is still in the eligible pool.
   *
   * Set by `AssayerInvoiceService.invite`, nulled again when the invoice is cancelled or the
   * line is detached (void/hold while merely INVITED). While the invoice is INVITED or
   * SUBMITTED the payable is frozen out of per-payable approval ("awaiting assayer invoice
   * AINV-x") — invoice approval is the gesture that approves its lines.
   */
  @Column({ name: 'assayer_invoice_id', type: 'uuid', nullable: true })
  assayerInvoiceId: string | null;

  /**
   * True on payables that pre-date assayer invoicing (backfilled where money already moved:
   * APPROVED/PAID or partly paid). Grandfathered rows stay visible on the assayer's gated
   * statement WITHOUT an invoice — their money was already revealed under the old rules — and
   * are permanently excluded from invoice eligibility so history is never re-billed.
   */
  @Column({ name: 'pre_invoicing_era', type: 'boolean', default: false })
  preInvoicingEra: boolean;

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

  // ── Destination Snapshot for Outbound Payouts (Frozen before consumption) ─
  @Column({ name: 'destination_bank_account_number', type: 'text', nullable: true, transformer: encryptedColumn })
  destinationBankAccountNumber: string | null;

  @Column({ name: 'destination_ifsc', type: 'varchar', length: 20, nullable: true })
  destinationIfsc: string | null;

  @Column({ name: 'destination_bank_name', type: 'varchar', length: 150, nullable: true })
  destinationBankName: string | null;

  @Column({ name: 'destination_account_holder_name', type: 'varchar', length: 200, nullable: true })
  destinationAccountHolderName: string | null;

  @Column({ name: 'payout_evidence_version_id', type: 'uuid', nullable: true })
  payoutEvidenceVersionId: string | null;

  @Column({ name: 'destination_verified_at', type: 'timestamptz', nullable: true })
  destinationVerifiedAt: Date | null;
}
