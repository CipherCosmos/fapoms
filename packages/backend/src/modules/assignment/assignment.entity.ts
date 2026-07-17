/**
 * FAPOMS — Assignment Entity
 *
 * Represents an operational commitment assigning an assayer to a project branch (Part 2 §8, Part 6 §5).
 */

import { Entity, Column, Index, ManyToOne, JoinColumn, OneToOne } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { ProjectEntity } from '../project/project.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssignmentStatus } from '@fapoms/shared';

@Entity('assignments')
@Index(['assignmentNumber'])
@Index(['projectBranchId'])
@Index(['projectId'])
@Index(['assayerId'])
export class AssignmentEntity extends BaseEntity {
  @Column({ name: 'assignment_number', length: 50, unique: true })
  assignmentNumber: string;

  @Column({ name: 'project_branch_id', type: 'uuid' })
  projectBranchId: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @Column({
    type: 'enum',
    enum: AssignmentStatus,
    default: AssignmentStatus.CREATED,
  })
  status: AssignmentStatus;

  @Column({ name: 'proposed_fee', type: 'decimal', precision: 12, scale: 2, nullable: true })
  proposedFee: number | null;

  @Column({ name: 'agreed_fee', type: 'decimal', precision: 12, scale: 2, nullable: true })
  agreedFee: number | null;

  @Column({ name: 'scheduled_date', type: 'date', nullable: true })
  scheduledDate: Date | null;

  @Column({ name: 'completion_date', type: 'date', nullable: true })
  completionDate: Date | null;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;

  @Column({ name: 'cancel_reason', type: 'text', nullable: true })
  cancelReason: string | null;

  @Column({ name: 'reject_reason', type: 'text', nullable: true })
  rejectReason: string | null;

  @OneToOne(() => ProjectBranchEntity, (pb) => pb.assignment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_branch_id' })
  projectBranch: ProjectBranchEntity;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;
}
