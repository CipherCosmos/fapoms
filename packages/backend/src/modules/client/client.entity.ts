/**
 * FAPOMS — Client Entity
 *
 * Represents corporate clients (banks/financial institutions)
 * that request audits (Part 2 §2, Part 5 §3).
 */

import { Entity, Column, OneToOne } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import type { ClientConfigurationEntity } from './client-configuration.entity';

@Entity('clients')
export class ClientEntity extends BaseEntity {
  @Column({ name: 'client_code', unique: true, length: 50 })
  clientCode: string;

  @Column({ length: 255 })
  name: string;

  @Column({ name: 'display_name', length: 255 })
  displayName: string;

  @Column({ name: 'contact_person', type: 'varchar', length: 200, nullable: true })
  contactPerson: string | null;

  @Column({ name: 'contact_email', type: 'varchar', length: 255, nullable: true })
  contactEmail: string | null;

  @Column({ name: 'contact_phone', type: 'varchar', length: 20, nullable: true })
  contactPhone: string | null;

  @Column({ type: 'text', nullable: true })
  address: string | null;

  // Use a string resolver for the target entity to avoid runtime circular import reference errors
  @OneToOne('ClientConfigurationEntity', 'client', { cascade: true, eager: true })
  configuration: any;
}
