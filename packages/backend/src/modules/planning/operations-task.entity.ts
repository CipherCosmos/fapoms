import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';

export enum OperationsTaskPriority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export enum OperationsTaskStatus {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  RESOLVED = 'RESOLVED',
  DISMISSED = 'DISMISSED',
}

@Entity('operations_tasks')
@Index(['projectId'])
@Index(['status'])
export class OperationsTaskEntity extends BaseEntity {
  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text' })
  reason: string;

  @Column({
    type: 'enum',
    enum: OperationsTaskPriority,
    default: OperationsTaskPriority.MEDIUM,
  })
  priority: OperationsTaskPriority;

  @Column({
    type: 'enum',
    enum: OperationsTaskStatus,
    default: OperationsTaskStatus.OPEN,
  })
  status: OperationsTaskStatus;

  @Column({ name: 'due_time', type: 'timestamptz', nullable: true })
  dueTime: Date | null;

  @Column({ name: 'owner_id', type: 'uuid', nullable: true })
  ownerId: string | null;

  @Column({ type: 'text', nullable: true })
  resolutionJustification: string | null;
}
