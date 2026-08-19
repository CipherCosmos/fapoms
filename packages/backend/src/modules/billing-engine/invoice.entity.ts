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
 *   DRAFT → ISSUED ("Sent") → PAID   (+ CANCELLED, which returns its lines to UNBILLED)
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
