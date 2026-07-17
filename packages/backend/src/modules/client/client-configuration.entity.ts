/**
 * FAPOMS — Client Configuration Entity
 *
 * Represents specific SLA rules, custom import configurations, and operational parameters (Part 5 §3).
 */

import { Entity, Column, OneToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import type { ClientEntity } from './client.entity';

@Entity('client_configurations')
export class ClientConfigurationEntity extends BaseEntity {
  @Column({ name: 'client_id', type: 'uuid' })
  clientId: string;

  // Use a string resolver for the target entity to avoid runtime circular import reference errors
  @OneToOne('ClientEntity', 'configuration', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'client_id' })
  client: any; // typed as any at runtime to prevent metadata errors

  @Column({ 
    name: 'import_mapping', 
    type: 'jsonb', 
    nullable: true,
    comment: 'Custom mapping of Excel columns to FAPOMS schema fields'
  })
  importMapping: Record<string, string> | null;

  @Column({ 
    name: 'working_days', 
    type: 'jsonb', 
    nullable: true,
    comment: 'List of working days (0=Sunday, 1=Monday, ..., 6=Saturday)'
  })
  workingDays: number[] | null;

  @Column({ 
    name: 'default_radius', 
    type: 'decimal', 
    precision: 5, 
    scale: 2, 
    default: 50.00,
    comment: 'Default assignment search radius in kilometers'
  })
  defaultRadius: number;

  @Column({ 
    name: 'sla_rules', 
    type: 'jsonb', 
    nullable: true,
    comment: 'SLA parameters such as maximum response time, scheduling windows'
  })
  slaRules: Record<string, any> | null;

  @Column({ name: 'effective_from', type: 'timestamptz' })
  effectiveFrom: Date;

  @Column({ name: 'effective_to', type: 'timestamptz', nullable: true })
  effectiveTo: Date | null;
}
