import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerStatus, AssayerLifecycleStatus } from '@fapoms/shared';

@Entity('assayers')
@Index(['assayerCode'])
@Index(['employeeId'])
@Index(['status'])
@Index(['lifecycleStatus'])
@Index(['state'])
@Index(['organizationId'])
@Index(['managerId'])
export class AssayerEntity extends BaseEntity {
  @Column({ name: 'assayer_code', unique: true, length: 50 })
  assayerCode: string;

  @Column({ name: 'employee_id', type: 'varchar', length: 50, unique: true, nullable: true })
  employeeId: string | null;

  @Column({ name: 'employee_code', type: 'varchar', length: 50, nullable: true })
  employeeCode: string | null;

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

  @Column({ type: 'geometry', spatialFeatureType: 'Point', srid: 4326, nullable: true })
  @Index({ spatial: true })
  location: any | null;

  @Column({ type: 'varchar', length: 50, default: AssayerStatus.ACTIVE })
  status: string;

  @Column({ name: 'lifecycle_status', type: 'varchar', length: 50, default: AssayerLifecycleStatus.INVITED })
  lifecycleStatus: string;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

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

  @Column({ name: 'joining_date', type: 'date', nullable: true })
  joiningDate: Date | null;

  @Column({ name: 'exit_date', type: 'date', nullable: true })
  exitDate: Date | null;

  @Column({ name: 'termination_date', type: 'date', nullable: true })
  terminationDate: Date | null;

  @Column({ name: 'manager_id', type: 'uuid', nullable: true })
  managerId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  department: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  region: string | null;

  @Column({ name: 'emergency_contact_name', type: 'varchar', length: 200, nullable: true })
  emergencyContactName: string | null;

  @Column({ name: 'emergency_contact_phone', type: 'varchar', length: 20, nullable: true })
  emergencyContactPhone: string | null;

  @Column({ name: 'emergency_contact_relation', type: 'varchar', length: 100, nullable: true })
  emergencyContactRelation: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  photograph: string | null;

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

  @Column({ name: 'eligible_clients', type: 'jsonb', nullable: true })
  eligibleClients: string[] | null;
}
