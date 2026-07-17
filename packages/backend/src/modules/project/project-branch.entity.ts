/**
 * FAPOMS — Project Branch Entity
 *
 * Represents a single branch's participation in an audit project (Part 2 §5, Part 6 §4).
 */

import { Entity, Column, Index, ManyToOne, JoinColumn, OneToOne } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ProjectEntity } from './project.entity';
import { BranchEntity } from '../branch/branch.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectBranchStatus, Priority } from '@fapoms/shared';

@Entity('project_branches')
@Index(['projectId'])
@Index(['branchId'])
@Index(['status'])
export class ProjectBranchEntity extends BaseEntity {
  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  @Column({ name: 'branch_id', type: 'uuid' })
  branchId: string;

  @Column({
    type: 'enum',
    enum: ProjectBranchStatus,
    default: ProjectBranchStatus.IMPORTED,
  })
  status: ProjectBranchStatus;

  @Column({
    type: 'enum',
    enum: Priority,
    default: Priority.MEDIUM,
  })
  priority: Priority;

  @Column({ name: 'zone_id', type: 'uuid', nullable: true })
  zoneId: string | null;

  @Column({ name: 'scheduled_date', type: 'date', nullable: true })
  scheduledDate: Date | null;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;

  @ManyToOne(() => ProjectEntity, (p) => p.projectBranches, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @ManyToOne(() => BranchEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'branch_id' })
  branch: BranchEntity;

  @OneToOne(() => AssignmentEntity, (a) => a.projectBranch, { nullable: true })
  assignment: AssignmentEntity | null;
}
