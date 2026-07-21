/**
 * FAPOMS — Branch Entity
 *
 * Represents a physical bank branch owned by a client (Part 2 §4, Part 5 §4).
 * Stores geographic points using PostGIS to support coordinates search.
 */

import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ClientEntity } from '../client/client.entity';

@Entity('branches')
@Index(['branchCode'])
@Index(['solId'])
@Index(['clientId'])
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

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  latitude: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  longitude: number | null;

  // PostGIS spatial point for proximity queries (SRID 4326 represents WGS 84 GPS coordinates)
  @Column({
    type: 'geometry',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  @Index({ spatial: true })
  location: any | null;

  @Column({ name: 'client_id', type: 'uuid', nullable: true })
  clientId: string | null;

  @ManyToOne(() => ClientEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'client_id' })
  client: ClientEntity | null;

  @Column({ name: 'risk_score', type: 'decimal', precision: 5, scale: 2, default: 0.00 })
  riskScore: number;

  @Column({ type: 'varchar', length: 50, default: 'STANDARD' })
  complexity: string;

  @Column({ name: 'estimated_duration_hours', type: 'decimal', precision: 5, scale: 2, default: 8.00 })
  estimatedDurationHours: number;

  @Column({ name: 'required_competencies', type: 'jsonb', nullable: true })
  requiredCompetencies: string[] | null;
}
