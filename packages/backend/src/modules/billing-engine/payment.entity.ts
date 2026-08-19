import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { BillingInvoiceEntity } from './invoice.entity';
import { AssayerPayableEntity } from './payable.entity';
import { PaymentMethod, PaymentDirection } from '@fapoms/shared';

/**
 * Every real movement of money, in either direction.
 *
 * INBOUND rows are client payments against an invoice; OUTBOUND rows are disbursements against
 * an approved assayer payable. Keeping both in one table is what makes this the single financial
 * record: cash-flow, the assayer's statement and the payment history are all reads over one
 * place.
 *
 * A payment has no status. It happened, or it was reversed — and a reversal is `isActive = false`
 * plus a history row, after which the invoice's or payable's paid total is recomputed from the
 * active rows. Every aggregate already filters on `is_active`, and a negative row would break
 * both "Σ amount = cash" and the per-reference uniqueness below.
 *
 * `UQ_billing_payments_inbound_ref` / `UQ_billing_payments_outbound_ref` (migration
 * 1791500000000) make a retried POST under the same reference a no-op rather than a second
 * payment.
 */
@Entity('billing_payments')
@Index(['invoiceId'])
@Index(['paymentReference'])
@Index(['direction'])
@Index(['payableId'])
@Index(['assayerId'])
export class BillingPaymentEntity extends BaseEntity {
  @Column({ name: 'payment_reference', length: 100 })
  paymentReference: string;

  @Column({ type: 'varchar', length: 10, default: PaymentDirection.INBOUND })
  direction: PaymentDirection;

  @Column({ type: 'varchar', length: 20 })
  method: PaymentMethod;

  @Column({ type: 'decimal', precision: 14, scale: 2 })
  amount: number;

  @Column({ length: 3, default: 'INR' })
  currency: string;

  /** The date the money moved — received (INBOUND) or paid out (OUTBOUND). */
  @Column({ name: 'received_date', type: 'date', nullable: true })
  receivedDate: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  // ── INBOUND leg: which invoice this settles ───────────────────────────────
  @Column({ name: 'invoice_id', type: 'uuid', nullable: true })
  invoiceId: string | null;

  // ── OUTBOUND leg: what we paid an assayer ────────────────────────────────
  @Column({ name: 'payable_id', type: 'uuid', nullable: true })
  payableId: string | null;

  /** Denormalised so an assayer's statement never needs a join to be filtered. */
  @Column({ name: 'assayer_id', type: 'uuid', nullable: true })
  assayerId: string | null;

  /** Balance owed to the assayer after this disbursement was applied. */
  @Column({ name: 'running_balance', type: 'decimal', precision: 14, scale: 2, nullable: true })
  runningBalance: number | null;

  // Nullable because an OUTBOUND disbursement has no client invoice behind it.
  @ManyToOne(() => BillingInvoiceEntity, (inv) => inv.payments, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'invoice_id' })
  invoice: BillingInvoiceEntity | null;

  @ManyToOne(() => AssayerPayableEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'payable_id' })
  payable: AssayerPayableEntity | null;
}
