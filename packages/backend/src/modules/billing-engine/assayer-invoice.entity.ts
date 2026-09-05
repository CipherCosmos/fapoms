import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerInvoiceStatus } from '@fapoms/shared';

/**
 * An assayer's invoice — the consent-and-visibility wrapper over their payables.
 *
 * This table holds NO money of its own. Each attached `assayer_payables` row (via
 * `assayer_payables.assayer_invoice_id`) is the line; the four amount columns here are SUMs of
 * the stored line amounts, frozen at invite time and re-verified (never recomputed) at approval.
 * Pricing happened once, at booking, by `assignmentMoney` — an invoice that re-priced anything
 * would be a second formula, which is the exact defect the one-calculator invariant exists to
 * prevent.
 *
 *   INVITED → SUBMITTED → APPROVED     (+ CANCELLED from either pre-approval state)
 *
 * INVITED is ops saying "bill us for this work" — the assayer has seen nothing yet. SUBMITTED
 * is the assayer's confirmation of the on-screen figures (the reveal), idempotent by
 * `submittedRequestId` because mobile retries on flaky connections. APPROVED is ops accepting
 * the submission, and is the same transaction that approves every PENDING line payable — one
 * gesture, not N. CANCELLED releases the lines back to the eligible pool; there is no REJECTED
 * (ops cancels, fixes the payables, re-invites).
 */
@Entity('assayer_invoices')
@Index(['assayerId'])
@Index(['status'])
/**
 * ONE active invoice per assayer, enforced by the database. Same pattern as
 * `UQ_assayer_payables_fee_per_assignment` on payable.entity.ts: the service checks first, but
 * two concurrent invites race past any check — the partial unique index is the real guard, and
 * the loser catches the violation by this name (`isUniqueViolation` matches on it).
 */
@Index('UQ_assayer_invoices_one_active_per_assayer', ['assayerId'], {
  unique: true,
  where: `"status" IN ('INVITED','SUBMITTED')`,
})
export class AssayerInvoiceEntity extends BaseEntity {
  /** `AINV-…` — same generation mechanism as `payableNumber` (time36 + 6-digit sequence). */
  @Column({ name: 'invoice_number', length: 50, unique: true })
  invoiceNumber: string;

  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @Column({ type: 'varchar', length: 20, default: AssayerInvoiceStatus.INVITED })
  status: AssayerInvoiceStatus;

  @Column({ name: 'invited_at', type: 'timestamptz', nullable: true })
  invitedAt: Date | null;

  @Column({ name: 'invited_by', type: 'uuid', nullable: true })
  invitedBy: string | null;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  /**
   * The `clientRequestId` of the submission, for idempotency — same semantics as
   * `assignments.last_counter_request_id`: mobile retries a submit POST with the same body, and
   * a repeat of this id is a no-op that returns the current state instead of a 409.
   */
  @Column({ name: 'submitted_request_id', type: 'uuid', nullable: true })
  submittedRequestId: string | null;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @Column({ name: 'approved_by', type: 'uuid', nullable: true })
  approvedBy: string | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @Column({ name: 'cancelled_by', type: 'uuid', nullable: true })
  cancelledBy: string | null;

  @Column({ name: 'cancel_reason', type: 'text', nullable: true })
  cancelReason: string | null;

  /** How many payables ride this invoice — kept with the totals by the same recomputes. */
  @Column({ name: 'line_count', type: 'integer', default: 0 })
  lineCount: number;

  /** Σ line base_amount. A SUM of stored amounts, never a computed price. */
  @Column({ name: 'subtotal_base', type: 'decimal', precision: 14, scale: 2, default: 0 })
  subtotalBase: number;

  /** Σ line travel_amount. */
  @Column({ name: 'subtotal_travel', type: 'decimal', precision: 14, scale: 2, default: 0 })
  subtotalTravel: number;

  /** Σ line tds_amount. */
  @Column({ name: 'tds_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  tdsAmount: number;

  /** Σ line total_amount — what the assayer is actually owed across the invoice. */
  @Column({ name: 'total_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  totalAmount: number;

  @Column({ length: 3, default: 'INR' })
  currency: string;

  @Column({ type: 'text', nullable: true })
  notes: string | null;
}
