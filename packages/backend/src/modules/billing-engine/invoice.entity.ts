import { Entity, Column, Index, ManyToOne, JoinColumn, OneToMany } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ClientEntity } from '../client/client.entity';
import { ProjectEntity } from '../project/project.entity';
import { BillingEntryEntity } from './billing-entry.entity';
import { BillingPaymentEntity } from './payment.entity';
import { InvoiceStatus } from '@fapoms/shared';

/**
 * A client invoice: a set of completed assignments for one client.
 *
 *   DRAFT → AWAITING_HOD → HOD_APPROVED → ISSUED ("Sent") → PAID
 *   (+ CANCELLED, which returns its lines to UNBILLED; an HOD rejection returns it to DRAFT)
 *
 * The HOD step (2026-09-24): only an invoice the HOD approved may be marked sent to the client.
 *
 * Part-payment is derived (`paidAmount > 0 && outstandingAmount > 0`), not a status.
 */
@Entity('billing_invoices')
@Index(['clientId'])
@Index(['projectId'])
@Index(['status'])
export class BillingInvoiceEntity extends BaseEntity {
  @Column({ name: 'invoice_number', length: 50, unique: true })
  invoiceNumber: string;

  @Column({ name: 'client_id', type: 'uuid' })
  clientId: string;

  /** Set when every line on the invoice is from one project; null for a mixed invoice. */
  @Column({ name: 'project_id', type: 'uuid', nullable: true })
  projectId: string | null;

  @Column({ type: 'varchar', length: 20, default: InvoiceStatus.DRAFT })
  status: InvoiceStatus;

  @Column({ name: 'issue_date', type: 'date', nullable: true })
  issueDate: string | null;

  @Column({ name: 'due_date', type: 'date', nullable: true })
  dueDate: string | null;

  @Column({ length: 3, default: 'INR' })
  currency: string;

  /** Pre-tax taxable value of the invoiced lines. */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  subtotal: number;

  @Column({ name: 'tax_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  taxAmount: number;

  /** Total TDS withheld by the client across this invoice's lines. */
  @Column({ name: 'tds_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  tdsAmount: number;

  /** subtotal + GST − TDS. */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  total: number;

  @Column({ name: 'paid_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  paidAmount: number;

  @Column({ name: 'outstanding_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  outstandingAmount: number;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  /** Who sent the draft for the HOD's final approval, and when (DRAFT → AWAITING_HOD). */
  @Column({ name: 'hod_requested_at', type: 'timestamptz', nullable: true })
  hodRequestedAt: Date | null;

  @Column({ name: 'hod_requested_by', type: 'uuid', nullable: true })
  hodRequestedBy: string | null;

  /**
   * The HOD's final approval (owner, 2026-09-24) — the second approval, after the office's, that
   * money needs before it can move. Moves the invoice
   * AWAITING_HOD → HOD_APPROVED; only then can it be marked sent to the client.
   * Never backfilled: whatever was waiting at deploy waits for the HOD like everything after it.
   */
  @Column({ name: 'hod_approved_at', type: 'timestamptz', nullable: true })
  hodApprovedAt: Date | null;

  @Column({ name: 'hod_approved_by', type: 'uuid', nullable: true })
  hodApprovedBy: string | null;

  /**
   * The last time the HOD sent it back to the office, by whom and why. Kept (not cleared by the
   * office's next approval) so the HOD's second look sees what the first one said; every
   * rejection is also a `billing_history` row.
   */
  @Column({ name: 'hod_rejected_at', type: 'timestamptz', nullable: true })
  hodRejectedAt: Date | null;

  @Column({ name: 'hod_rejected_by', type: 'uuid', nullable: true })
  hodRejectedBy: string | null;

  @Column({ name: 'hod_reject_reason', type: 'text', nullable: true })
  hodRejectReason: string | null;

  @ManyToOne(() => ClientEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'client_id' })
  client: ClientEntity;

  @ManyToOne(() => ProjectEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity | null;

  @OneToMany(() => BillingEntryEntity, (e) => e.invoice)
  entries: BillingEntryEntity[];

  @OneToMany(() => BillingPaymentEntity, (p) => p.invoice)
  payments: BillingPaymentEntity[];
}
