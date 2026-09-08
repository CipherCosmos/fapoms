import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssignmentEntity } from './assignment.entity';
import { AssayerEntity } from '../assayer/assayer.entity';

@Entity('assignment_reassignments')
@Index(['assignmentId', 'createdAt'])
export class AssignmentReassignmentEntity extends BaseEntity {
  @Column({ name: 'assignment_id', type: 'uuid' })
  assignmentId: string;

  @Column({ name: 'previous_assayer_id', type: 'uuid', nullable: true })
  previousAssayerId: string | null;

  @Column({ name: 'new_assayer_id', type: 'uuid' })
  newAssayerId: string;

  @Column({ name: 'reassigned_by', type: 'uuid' })
  reassignedBy: string;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ name: 'request_id', type: 'varchar', length: 100, nullable: true })
  requestId: string | null;

  @Column({ name: 'ownership_started_at', type: 'timestamptz' })
  ownershipStartedAt: Date;

  @Column({ name: 'ownership_ended_at', type: 'timestamptz', nullable: true })
  ownershipEndedAt: Date | null;

  @ManyToOne(() => AssignmentEntity, (a) => a.reassignments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assignment_id' })
  assignment: AssignmentEntity;

  @ManyToOne(() => AssayerEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'previous_assayer_id' })
  previousAssayer: AssayerEntity | null;

  @ManyToOne(() => AssayerEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'new_assayer_id' })
  newAssayer: AssayerEntity;
}
