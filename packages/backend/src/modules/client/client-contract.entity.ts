import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import type { ClientEntity } from './client.entity';

@Entity('client_contracts')
@Index(['clientId'])
export class ClientContractEntity extends BaseEntity {
  @Column({ name: 'client_id', type: 'uuid' })
  clientId: string;

  @ManyToOne('ClientEntity', 'contracts', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'client_id' })
  client: ClientEntity;

  @Column({ name: 'contract_number', unique: true, length: 50 })
  contractNumber: string;

  @Column({ length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'signed_date', type: 'date', nullable: true })
  signedDate: string | null;

  @Column({ name: 'effective_from', type: 'date' })
  effectiveFrom: string;

  @Column({ name: 'effective_to', type: 'date', nullable: true })
  effectiveTo: string | null;

  @Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
  value: number | null;

  @Column({ length: 3, default: 'INR' })
  currency: string;

  @Column({ type: 'varchar', length: 50, default: 'DRAFT' })
  status: string;

  @Column({ type: 'jsonb', nullable: true })
  terms: Record<string, any> | null;

  @Column({ name: 'document_url', type: 'varchar', length: 500, nullable: true })
  documentUrl: string | null;
}
