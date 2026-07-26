import { Entity, Column, Index, OneToMany, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';

export enum ExecutionGroupStatus {
  DRAFT = 'DRAFT',
  DISPATCHED = 'DISPATCHED',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
  CONFIRMED = 'CONFIRMED',
  READY = 'READY',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

@Entity('operations_execution_groups')
@Index(['assayerId'])
export class OperationsExecutionGroupEntity extends BaseEntity {
  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @Column({ type: 'text', nullable: true })
  name: string | null;

  @Column({
    type: 'enum',
    enum: ExecutionGroupStatus,
    default: ExecutionGroupStatus.DRAFT,
  })
  status: ExecutionGroupStatus;

  @Column({ name: 'total_fee', type: 'numeric', precision: 10, scale: 2, default: 0 })
  totalFee: number;

  @Column({ type: 'jsonb', nullable: true })
  logisticsPreferences: any; // Hotels, travel allowances, itinerary preferences

  @OneToMany(() => AssignmentEntity, (a) => a.executionGroup)
  assignments: AssignmentEntity[];
}
