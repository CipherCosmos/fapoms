import { Entity, Column, OneToOne, OneToMany } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import type { ClientConfigurationEntity } from './client-configuration.entity';
import type { ClientContactEntity } from './client-contact.entity';
import type { ClientContractEntity } from './client-contract.entity';
import type { ClientBillingEntity } from './client-billing.entity';

@Entity('clients')
export class ClientEntity extends BaseEntity {
  @Column({ name: 'client_code', unique: true, length: 50 })
  clientCode: string;

  @Column({ length: 255 })
  name: string;

  @Column({ name: 'display_name', length: 255 })
  displayName: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  website: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  industry: string | null;

  @Column({ name: 'client_type', length: 50, default: 'OTHER' })
  clientType: string;

  @Column({ name: 'registration_number', type: 'varchar', length: 100, nullable: true })
  registrationNumber: string | null;

  @Column({ name: 'tax_id', type: 'varchar', length: 100, nullable: true })
  taxId: string | null;

  @Column({ name: 'lifecycle_status', length: 50, default: 'PROSPECT' })
  lifecycleStatus: string;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({ name: 'contact_person', type: 'varchar', length: 200, nullable: true })
  contactPerson: string | null;

  @Column({ name: 'contact_email', type: 'varchar', length: 255, nullable: true })
  contactEmail: string | null;

  @Column({ name: 'contact_phone', type: 'varchar', length: 20, nullable: true })
  contactPhone: string | null;

  @Column({ type: 'text', nullable: true })
  address: string | null;

  @OneToOne('ClientConfigurationEntity', 'client', { cascade: true, eager: true })
  configuration: any;

  @OneToMany('ClientContactEntity', 'client', { cascade: true })
  contacts: ClientContactEntity[];

  @OneToMany('ClientContractEntity', 'client', { cascade: true })
  contracts: ClientContractEntity[];

  @OneToOne('ClientBillingEntity', 'client', { cascade: true })
  billing: ClientBillingEntity;

  @Column({ type: 'varchar', length: 50, default: 'MEDIUM' })
  priority: string;

  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  budget: number | null;

  @Column({ name: 'preferred_assayers', type: 'jsonb', nullable: true })
  preferredAssayers: string[] | null;

  @Column({ name: 'restricted_assayers', type: 'jsonb', nullable: true })
  restrictedAssayers: string[] | null;

  @Column({ name: 'planning_preferences', type: 'jsonb', nullable: true })
  planningPreferences: Record<string, any> | null;
}
