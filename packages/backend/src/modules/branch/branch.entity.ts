import { Entity, Column, Index, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ClientEntity } from '../client/client.entity';
import type { ZoneEntity } from '../zone/zone.entity';
import type { BranchContactEntity } from './branch-contact.entity';
import type { BranchDocumentEntity } from './branch-document.entity';

@Entity('branches')
@Index(['branchCode'])
@Index(['solId'])
@Index(['clientId'])
@Index(['region'])
@Index(['zoneId'])
export class BranchEntity extends BaseEntity {
  @Column({ name: 'branch_code', length: 50 })
  branchCode: string;

  @Column({ name: 'sol_id', type: 'varchar', length: 50, nullable: true })
  solId: string | null;

  @Column({ length: 255 })
  name: string;

  @Column({ type: 'text' })
  address: string;

  @Column({ length: 100 })
  state: string;

  @Column({ length: 100 })
  district: string;

  @Column({ length: 100 })
  city: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  pincode: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  region: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  territory: string | null;

  @Column({ name: 'zone_id', type: 'uuid', nullable: true })
  zoneId: string | null;

  @Column({ name: 'branch_type', type: 'varchar', length: 50, nullable: true })
  branchType: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string | null;

  @Column({ name: 'manager_name', type: 'varchar', length: 200, nullable: true })
  managerName: string | null;

  @Column({ name: 'opening_date', type: 'date', nullable: true })
  openingDate: string | null;

  @Column({ name: 'last_audit_date', type: 'date', nullable: true })
  lastAuditDate: string | null;

  @Column({ name: 'operating_hours', type: 'jsonb', nullable: true })
  operatingHours: Record<string, any> | null;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  latitude: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  longitude: number | null;

  @Column({
    type: 'geometry',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  @Index({ spatial: true })
  location: any | null;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({ name: 'client_id', type: 'uuid', nullable: true })
  clientId: string | null;

  @ManyToOne(() => ClientEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'client_id' })
  client: ClientEntity | null;

  @Column({ name: 'risk_score', type: 'decimal', precision: 5, scale: 2, default: 0.00 })
  riskScore: number;

  @Column({ name: 'risk_category', type: 'varchar', length: 20, nullable: true })
  riskCategory: string | null;

  @Column({ type: 'varchar', length: 50, default: 'STANDARD' })
  complexity: string;

  @Column({ name: 'estimated_duration_hours', type: 'decimal', precision: 5, scale: 2, default: 8.00 })
  estimatedDurationHours: number;

  @Column({ name: 'required_competencies', type: 'jsonb', nullable: true })
  requiredCompetencies: string[] | null;

  @OneToMany('BranchContactEntity', 'branch', { cascade: true })
  contacts: BranchContactEntity[];

  @OneToMany('BranchDocumentEntity', 'branch', { cascade: true })
  documents: BranchDocumentEntity[];
}
