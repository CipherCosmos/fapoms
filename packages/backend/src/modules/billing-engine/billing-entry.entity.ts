import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ClientEntity } from '../client/client.entity';
import { ProjectEntity } from '../project/project.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { BillingInvoiceEntity } from './invoice.entity';
import { BillingState } from '@fapoms/shared';

/**
 * The client-side line for one assignment: what the client owes us for that audit.
 *
 * One per assignment, created by `BillingEngineService.bookAssignment` when the assignment
 * completes, priced by `assignmentMoney` and never typed by hand. Denormalised back to the
 * client and project so reports never need joins to decide "which client is this money for".
 *
 *   UNBILLED → INVOICED → PAID   (+ CANCELLED)   and the `onHold` flag, which blocks invoicing.
 */
@Entity('billing_entries')
@Index(['clientId'])
@Index(['projectId'])
@Index(['assayerId'])
@Index(['state'])
// `SELECT … FOR UPDATE WHERE invoice_id = …` in createInvoice/recordPayment — a sequential scan
// held under a row lock without this. Also in 1790300000000-RestoreScaleIndexes.
@Index('IDX_billing_entries_invoice_id', ['invoiceId'])
// One client line per assignment, enforced by the database. Booking runs from an at-least-once
// event under a fail-open lock; without this a duplicate delivery could produce two lines for
// one job. The name is load-bearing: `isUniqueViolation` matches on it.
@Index('UQ_billing_entries_root_per_assignment', ['assignmentId'], { unique: true })
export class BillingEntryEntity extends BaseEntity {
  @Column({ name: 'entry_number', length: 50, unique: true })
  entryNumber: string;

  @Column({ name: 'client_id', type: 'uuid' })
  clientId: string;

  @Column({ name: 'project_id', type: 'uuid', nullable: true })
  projectId: string | null;

  @Column({ name: 'assignment_id', type: 'uuid' })
  assignmentId: string;

  @Column({ name: 'assayer_id', type: 'uuid', nullable: true })
  assayerId: string | null;

  @Column({ type: 'varchar', length: 30, default: BillingState.UNBILLED })
  state: BillingState;

  /** A held line cannot be invoiced. Not a state: a hold is a flag on wherever the line is. */
  @Column({ name: 'on_hold', type: 'boolean', default: false })
  onHold: boolean;

  @Column({ name: 'hold_reason', type: 'text', nullable: true })
  holdReason: string | null;

  /** The day the work was delivered — what the invoice line is dated. */
  @Column({ name: 'service_date', type: 'date', nullable: true })
  serviceDate: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  // ── Money: base + travel + adjustment = taxable; taxable + GST − TDS = total ──
  @Column({ name: 'base_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  baseAmount: number;

  @Column({ name: 'travel_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  travelAmount: number;

  /** A per-job correction, editable only while UNBILLED. The reason travels with it. */
  @Column({ name: 'adjustment_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  adjustmentAmount: number;

  @Column({ name: 'adjustment_reason', type: 'text', nullable: true })
  adjustmentReason: string | null;

  @Column({ name: 'tax_rate', type: 'decimal', precision: 6, scale: 2, default: 0 })
  taxRate: number;

  @Column({ name: 'taxable_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  taxableAmount: number;

  @Column({ name: 'tax_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  taxAmount: number;

  // TDS is withheld at a rate (e.g. 10% u/s 194J); the rate is stored so the amount can be
  // recomputed on an adjustment.
  @Column({ name: 'tds_rate', type: 'decimal', precision: 6, scale: 2, default: 0 })
  tdsRate: number;

  @Column({ name: 'tds_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  tdsAmount: number;

  @Column({ name: 'total_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  totalAmount: number;

  @Column({ length: 3, default: 'INR' })
  currency: string;

  // ── Collection ──
  @Column({ name: 'paid_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  paidAmount: number;

  @Column({ name: 'outstanding_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  outstandingAmount: number;

  @Column({ name: 'invoice_id', type: 'uuid', nullable: true })
  invoiceId: string | null;

  @ManyToOne(() => ClientEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'client_id' })
  client: ClientEntity;

  @ManyToOne(() => ProjectEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity | null;

  // RESTRICT, not SET NULL: a line is money against an assignment, and an assignment that has
  // been billed cannot quietly disappear from under it. The data-reset tool surfaces this edge
  // so a wipe of assignments has to include billing on purpose.
  @ManyToOne(() => AssignmentEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'assignment_id' })
  assignment: AssignmentEntity;

  @ManyToOne(() => BillingInvoiceEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'invoice_id' })
  invoice: BillingInvoiceEntity | null;
}
