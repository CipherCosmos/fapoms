import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';

export enum OperationsExceptionCategory {
  UNCOVERABLE_BRANCH = 'UNCOVERABLE_BRANCH',
  CAPACITY_EXCEEDED = 'CAPACITY_EXCEEDED',
  SCHEDULE_CONFLICT = 'SCHEDULE_CONFLICT',
  COMMERCIAL_DISCREPANCY = 'COMMERCIAL_DISCREPANCY',
  CERTIFICATION_EXPIRED = 'CERTIFICATION_EXPIRED',
  ROUTE_UNREACHABLE = 'ROUTE_UNREACHABLE',
}

export enum OperationsExceptionStatus {
  UNRESOLVED = 'UNRESOLVED',
  RESOLVED = 'RESOLVED',
  BYPASSED = 'BYPASSED',
}

@Entity('operations_exceptions')
@Index(['projectId'])
@Index(['status'])
export class OperationsExceptionEntity extends BaseEntity {
  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  @Column({ name: 'target_entity_id', type: 'uuid', nullable: true })
  targetEntityId: string | null;

  @Column({
    type: 'enum',
    enum: OperationsExceptionCategory,
  })
  category: OperationsExceptionCategory;

  @Column({
    type: 'enum',
    enum: OperationsExceptionStatus,
    default: OperationsExceptionStatus.UNRESOLVED,
  })
  status: OperationsExceptionStatus;

  @Column({ type: 'text' })
  message: string;

  @Column({ type: 'text', nullable: true })
  overrideJustification: string | null;
}
