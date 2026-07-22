import { Entity, Column, OneToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import type { ClientEntity } from './client.entity';

@Entity('client_billing')
export class ClientBillingEntity extends BaseEntity {
  @Column({ name: 'client_id', type: 'uuid', unique: true })
  clientId: string;

  @OneToOne('ClientEntity', 'billing', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'client_id' })
  client: ClientEntity;

  @Column({ name: 'payment_terms', length: 200 })
  paymentTerms: string;

  @Column({ length: 3, default: 'INR' })
  currency: string;

  @Column({ name: 'tax_identifier', type: 'varchar', length: 100, nullable: true })
  taxIdentifier: string | null;

  @Column({ name: 'invoice_cycle', length: 50 })
  invoiceCycle: string;

  @Column({ name: 'billing_address', type: 'text' })
  billingAddress: string;

  @Column({ name: 'bank_account', type: 'varchar', length: 50, nullable: true })
  bankAccount: string | null;

  @Column({ name: 'bank_name', type: 'varchar', length: 200, nullable: true })
  bankName: string | null;

  @Column({ name: 'ifsc_code', type: 'varchar', length: 20, nullable: true })
  ifscCode: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;
}
