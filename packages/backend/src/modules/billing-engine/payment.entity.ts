import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { BillingInvoiceEntity } from './invoice.entity';
import { AssayerPayableEntity } from './payable.entity';
import { PaymentMethod, PaymentStatus, PaymentDirection } from '@fapoms/shared';

/**
 * Every movement of money, in either direction.
 *
 * INBOUND rows are client payments against an invoice; OUTBOUND rows are
 * disbursements against an approved assayer payable. Keeping both in one table
 * is what makes this the single financial record: cash-flow, the assayer's
 * running balance and the payment history are all reads over this one place.
 *
 * Previously only inbound client payments were modelled here, while money paid
 * *out* to assayers lived in a separate `assayer_financial_ledger` maintained by
 * a different module — so no single query could answer "what did we pay out?".
 */
@Entity('billing_payments')
@Index(['invoice'])
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

  @Column({ name: 'received_date', type: 'date', nullable: true })
  receivedDate: string | null;

  @Column({ type: 'varchar', length: 20, default: PaymentStatus.PENDING })
  status: PaymentStatus;

  @Column({ name: 'allocated_to_entry_ids', type: 'jsonb', nullable: true })
  allocatedToEntryIds: string[] | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

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
