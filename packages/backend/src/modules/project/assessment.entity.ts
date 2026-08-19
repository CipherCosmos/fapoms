import { Entity, Column, Index, ManyToOne, JoinColumn, OneToMany } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ProjectEntity } from './project.entity';
import { BranchEntity } from '../branch/branch.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
/**
 * The row a project's paperwork for one branch hangs off.
 *
 * It used to carry a lifecycle of its own — an eighteen-state `status` — plus `audit_date`,
 * `assigned_assessor_id`, `agreed_fee`, `packet_size`, `coverage_flag`, `priority`, `zone_id`
 * and `remarks`. Every one of them was written and none was ever read: no query filtered on
 * them, no screen showed them, and no decision consulted them. Three services carried code
 * whose only job was keeping that decoration in step with the project branch and the
 * assignment — which are where the audit date, the assayer and the fee actually live.
 *
 * What remains is what it is for: the link a document is attached to.
 */
@Entity('assessments')
@Index(['projectId'])
@Index(['branchId'])
export class AssessmentEntity extends BaseEntity {
  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  @Column({ name: 'branch_id', type: 'uuid' })
  branchId: string;

  @ManyToOne(() => ProjectEntity, (p) => p.assessments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @ManyToOne(() => BranchEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'branch_id' })
  branch: BranchEntity;

  @OneToMany(() => AssignmentEntity, (a) => a.assessment)
  assignments: AssignmentEntity[];
}
