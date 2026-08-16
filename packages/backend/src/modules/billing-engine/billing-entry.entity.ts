import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ClientEntity } from '../client/client.entity';
import { ProjectEntity } from '../project/project.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { BillingInvoiceEntity } from './invoice.entity';
import { BillingLevel, BillingState, PaymentState, BillingPricingModel } from '@fapoms/shared';

/**
 * A single billable line at one level of the traceability chain:
 *
 *   Client → Project → Assignment → Assayer (payable)
 *
 * `level` determines which FK is populated. Every entry is denormalised back to
 * `clientId` (and up the chain where known) so reports never need joins to decide
 * "which client is this money for", and so cross-project duplicate detection has a
 * single key to query.
 */
@Entity('billing_entries')
@Index(['level'])
@Index(['clientId'])
@Index(['projectId'])
@Index(['assignmentId'])
@Index(['assayerId'])
@Index(['state'])
@Index(['paymentState'])
// `SELECT … FOR UPDATE WHERE invoice_id = …` in createInvoice/recordPayment — a sequential scan
// held under a row lock without this. Also in 1790300000000-RestoreScaleIndexes.
@Index('IDX_billing_entries_invoice_id', ['invoiceId'])
export class BillingEntryEntity extends BaseEntity {
  @Column({ name: 'entry_number', length: 50, unique: true })
  entryNumber: string;

  @Column({ type: 'varchar', length: 20 })
  level: BillingLevel;

  @Column({ name: 'client_id', type: 'uuid' })
  clientId: string;

  @Column({ name: 'project_id', type: 'uuid', nullable: true })
  projectId: string | null;

  @Column({ name: 'assignment_id', type: 'uuid', nullable: true })
  assignmentId: string | null;

  @Column({ name: 'assayer_id', type: 'uuid', nullable: true })
  assayerId: string | null;

  @Column({ type: 'varchar', length: 30 })
  state: BillingState;

  @Column({ name: 'payment_state', type: 'varchar', length: 20 })
  paymentState: PaymentState;

  @Column({ name: 'pricing_model', type: 'varchar', length: 30, default: BillingPricingModel.FLAT_RATE })
  pricingModel: BillingPricingModel;

  @Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
  rate: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
  quantity: number | null;

  @Column({ name: 'billing_period_start', type: 'date', nullable: true })
  billingPeriodStart: string | null;

  @Column({ name: 'billing_period_end', type: 'date', nullable: true })
  billingPeriodEnd: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  // ── Money (spec §2/§4/§5): one level never leaks into another ──────────
  @Column({ name: 'base_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  baseAmount: number;

  @Column({ name: 'travel_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  travelAmount: number;

  @Column({ name: 'adjustment_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  adjustmentAmount: number;

  @Column({ name: 'discount_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  discountAmount: number;

  @Column({ name: 'tax_rate', type: 'decimal', precision: 6, scale: 2, default: 0 })
  taxRate: number;

  /**
   * base + travel + adjustment − discount: the value GST and TDS are computed on.
   * Stored separately because the previous code wrote this sum back over
   * `baseAmount`, so any second recompute (e.g. an adjustment) folded travel and
   * earlier adjustments into the base a second time and inflated the line.
   */
  @Column({ name: 'taxable_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  taxableAmount: number;

  @Column({ name: 'tax_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  taxAmount: number;

  // TDS is withheld at a *rate* (e.g. 10% u/s 194J). The rate has to be stored
  // separately from the resulting amount: without it there was nothing to
  // recompute from, so TDS silently stayed 0 on every entry and clients were
  // over-billed by the withheld amount.
  @Column({ name: 'tds_rate', type: 'decimal', precision: 6, scale: 2, default: 0 })
  tdsRate: number;

  @Column({ name: 'tds_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  tdsAmount: number;

  @Column({ name: 'total_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  totalAmount: number;

  @Column({ length: 3, default: 'INR' })
  currency: string;

  // Money-collection ledger, distinct from the approval pipeline
  @Column({ name: 'billed_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  billedAmount: number;

  @Column({ name: 'paid_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  paidAmount: number;

  @Column({ name: 'outstanding_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  outstandingAmount: number;

  @Column({ name: 'disputed_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  disputedAmount: number;

  @Column({ name: 'cancelled_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  cancelledAmount: number;

  @Column({ name: 'adjusted_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  adjustedAmount: number;

  // ── Traceability / split / merge / duplicate ────────────────────────────
  @Column({ name: 'parent_entry_id', type: 'uuid', nullable: true })
  parentEntryId: string | null;

  @Column({ name: 'source_entry_id', type: 'uuid', nullable: true })
  sourceEntryId: string | null;

  @Column({ name: 'invoice_id', type: 'uuid', nullable: true })
  invoiceId: string | null;

  @ManyToOne(() => ClientEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'client_id' })
  client: ClientEntity;

  @ManyToOne(() => ProjectEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity | null;

  @ManyToOne(() => AssignmentEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'assignment_id' })
  assignment: AssignmentEntity | null;

  @ManyToOne(() => BillingInvoiceEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'invoice_id' })
  invoice: BillingInvoiceEntity | null;
}
