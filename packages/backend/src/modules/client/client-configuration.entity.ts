import { Entity, Column, OneToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import type { ClientEntity } from './client.entity';

@Entity('client_configurations')
export class ClientConfigurationEntity extends BaseEntity {
  @Column({ name: 'client_id', type: 'uuid' })
  clientId: string;

  @OneToOne('ClientEntity', 'configuration', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'client_id' })
  client: any;

  @Column({
    name: 'import_mapping',
    type: 'jsonb',
    nullable: true,
    comment: 'Custom mapping of Excel columns to FAPOMS schema fields',
  })
  importMapping: Record<string, string> | null;

  @Column({
    name: 'working_days',
    type: 'jsonb',
    nullable: true,
    comment: 'List of working days (0=Sunday, 1=Monday, ..., 6=Saturday)',
  })
  workingDays: number[] | null;

  @Column({
    name: 'default_radius',
    type: 'decimal',
    precision: 5,
    scale: 2,
    default: 50.00,
    comment: 'Default assignment search radius in kilometers',
  })
  defaultRadius: number;

  @Column({
    name: 'sla_rules',
    type: 'jsonb',
    nullable: true,
    comment: 'SLA parameters such as maximum response time, scheduling windows',
  })
  slaRules: Record<string, any> | null;

  @Column({ name: 'service_level', type: 'varchar', length: 50, nullable: true, comment: 'SLA tier: PREMIUM, STANDARD, BASIC' })
  serviceLevel: string | null;

  @Column({ name: 'max_response_time_hours', type: 'int', nullable: true, comment: 'Maximum response time in hours' })
  maxResponseTimeHours: number | null;

  @Column({ name: 'penalty_rate', type: 'decimal', precision: 5, scale: 2, nullable: true, comment: 'Penalty rate for SLA breaches (%)' })
  penaltyRate: number | null;

  @Column({ name: 'service_hours', type: 'jsonb', nullable: true, comment: 'Service hours configuration' })
  serviceHours: Record<string, any> | null;

  @Column({ name: 'effective_from', type: 'timestamptz' })
  effectiveFrom: Date;

  @Column({ name: 'effective_to', type: 'timestamptz', nullable: true })
  effectiveTo: Date | null;
}
