import { Entity, Column, Index, ManyToOne, JoinColumn, OneToMany } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ProjectEntity } from './project.entity';
import { BranchEntity } from '../branch/branch.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AssessmentStatus, Priority } from '@fapoms/shared';

@Entity('assessments')
@Index(['projectId'])
@Index(['branchId'])
@Index(['status'])
export class AssessmentEntity extends BaseEntity {
  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  @Column({ name: 'branch_id', type: 'uuid' })
  branchId: string;

  @Column({
    type: 'enum',
    enum: AssessmentStatus,
    default: AssessmentStatus.PENDING_PLANNING,
  })
  status: AssessmentStatus;

  @Column({ name: 'packet_size', type: 'int', nullable: true })
  packetSize: number | null;

  @Column({ name: 'assigned_assessor_id', type: 'uuid', nullable: true })
  assignedAssessorId: string | null;

  @Column({ name: 'audit_date', type: 'date', nullable: true })
  auditDate: Date | null;

  @Column({ name: 'agreed_fee', type: 'decimal', precision: 12, scale: 2, nullable: true })
  agreedFee: number | null;

  @Column({ name: 'coverage_flag', type: 'boolean', default: false })
  coverageFlag: boolean;

  @Column({
    type: 'enum',
    enum: Priority,
    default: Priority.MEDIUM,
  })
  priority: Priority;

  @Column({ name: 'zone_id', type: 'uuid', nullable: true })
  zoneId: string | null;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;

  @ManyToOne(() => ProjectEntity, (p) => p.assessments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @ManyToOne(() => BranchEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'branch_id' })
  branch: BranchEntity;

  @OneToMany(() => AssignmentEntity, (a) => a.assessment)
  assignments: AssignmentEntity[];
}
