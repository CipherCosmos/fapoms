import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerEntity } from './assayer.entity';

@Entity('assayer_commercial_profiles')
@Index(['assayerId'])
@Index(['effectiveStartDate', 'effectiveEndDate'])
export class AssayerCommercialProfileEntity extends BaseEntity {
  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;

  @Column({ name: 'base_fee', type: 'decimal', precision: 12, scale: 2, default: 0 })
  baseFee: number;

  @Column({ name: 'hourly_rate', type: 'decimal', precision: 12, scale: 2, default: 0 })
  hourlyRate: number;

  @Column({ name: 'daily_rate', type: 'decimal', precision: 12, scale: 2, default: 0 })
  dailyRate: number;

  @Column({ name: 'travel_reimbursement', type: 'decimal', precision: 12, scale: 2, default: 0 })
  travelReimbursement: number;

  @Column({ name: 'accommodation_allowance', type: 'decimal', precision: 12, scale: 2, default: 0 })
  accommodationAllowance: number;

  @Column({ name: 'meal_allowance', type: 'decimal', precision: 12, scale: 2, default: 0 })
  mealAllowance: number;

  @Column({ type: 'varchar', length: 10, default: 'INR' })
  currency: string;

  @Column({ name: 'effective_start_date', type: 'timestamptz' })
  effectiveStartDate: Date;

  @Column({ name: 'effective_end_date', type: 'timestamptz', nullable: true })
  effectiveEndDate: Date | null;
}
