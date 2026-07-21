/**
 * FAPOMS — Assayer Entity
 *
 * Represents an independent assayer/auditor in the field (Part 2 §6, Part 5 §5).
 * Contains contact information, banking details, primary state, and PostGIS location.
 */

import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerStatus } from '@fapoms/shared';

@Entity('assayers')
@Index(['assayerCode'])
@Index(['status'])
@Index(['state'])
export class AssayerEntity extends BaseEntity {
  @Column({ name: 'assayer_code', unique: true, length: 50 })
  assayerCode: string;

  @Column({ name: 'first_name', length: 100 })
  firstName: string;

  @Column({ name: 'last_name', length: 100 })
  lastName: string;

  @Column({ name: 'display_name', length: 200 })
  displayName: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string | null;

  @Column({ length: 20 })
  phone: string;

  @Column({ name: 'alternate_phone', type: 'varchar', length: 20, nullable: true })
  alternatePhone: string | null;

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

  // PostGIS spatial point for proximity queries
  @Column({
    type: 'geometry',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  @Index({ spatial: true })
  location: any | null;

  @Column({
    type: 'varchar',
    length: 50,
    default: AssayerStatus.REGISTERED,
    comment: 'Assayer status: REGISTERED, ACTIVE, INACTIVE, BUSY, SUSPENDED',
  })
  status: string;

  @Column({ name: 'pan_number', type: 'varchar', length: 20, nullable: true })
  panNumber: string | null;

  @Column({ name: 'bank_account_number', type: 'varchar', length: 50, nullable: true })
  bankAccountNumber: string | null;

  @Column({ name: 'ifsc_code', type: 'varchar', length: 20, nullable: true })
  ifscCode: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ name: 'employment_type', type: 'varchar', length: 50, default: 'INTERNAL' })
  employmentType: string;

  @Column({ type: 'jsonb', nullable: true })
  skills: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  certifications: { name: string; expiryDate: string }[] | null;

  @Column({ type: 'jsonb', nullable: true })
  languages: string[] | null;

  @Column({ name: 'preferred_regions', type: 'jsonb', nullable: true })
  preferredRegions: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  specializations: string[] | null;

  @Column({ name: 'experience_years', type: 'int', default: 0 })
  experienceYears: number;

  @Column({ name: 'performance_rating', type: 'decimal', precision: 3, scale: 2, default: 5.00 })
  performanceRating: number;

  @Column({ type: 'jsonb', nullable: true })
  leaves: { startDate: string; endDate: string }[] | null;

  @Column({ name: 'working_hours', type: 'jsonb', nullable: true })
  workingHours: { start: string; end: string } | null;

  @Column({ name: 'max_daily_workload', type: 'int', default: 3 })
  maxDailyWorkload: number;

  @Column({ name: 'max_weekly_workload', type: 'int', default: 15 })
  maxWeeklyWorkload: number;
}
