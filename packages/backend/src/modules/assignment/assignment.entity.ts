import { Entity, Column, Index, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AssessmentEntity } from '../project/assessment.entity';
import { ProjectEntity } from '../project/project.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { OperationsExecutionGroupEntity } from '../planning/operations-execution-group.entity';
import { AssignmentStatus, Priority } from '@fapoms/shared';

@Entity('assignments')
@Index(['assignmentNumber'])
@Index(['projectBranchId'])
@Index(['assessmentId'])
@Index(['projectId'])
@Index(['assayerId'])
// Hot-path filters on status / (sla_status,status) / (assayer_id,scheduled_date,status) are indexed
// as partial indexes in migration 1788100000000-IndexAssignmentHotFilters (migration-only, matching
// how the project_branches.scheduled_date index is managed).
export class AssignmentEntity extends BaseEntity {
  @Column({ name: 'assignment_number', length: 50, unique: true })
  assignmentNumber: string;

  @Column({ name: 'project_branch_id', type: 'uuid', nullable: true })
  projectBranchId: string | null;

  @Column({ name: 'assessment_id', type: 'uuid', nullable: true })
  assessmentId: string | null;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @Column({
    type: 'enum',
    enum: AssignmentStatus,
    default: AssignmentStatus.PENDING,
  })
  status: AssignmentStatus;

  @Column({
    type: 'enum',
    enum: Priority,
    default: Priority.MEDIUM,
  })
  priority: Priority;

  @Column({ name: 'proposed_fee', type: 'decimal', precision: 12, scale: 2, nullable: true })
  proposedFee: number | null;

  @Column({ name: 'agreed_fee', type: 'decimal', precision: 12, scale: 2, nullable: true })
  agreedFee: number | null;

  // ── Check-in evidence ───────────────────────────────────────────────────
  /**
   * Where the assayer actually was when they checked in.
   *
   * This was previously appended to `remarks` as free text, which made the single most
   * important fact in a collateral audit — was the worker physically at the branch —
   * unqueryable and unusable as evidence. Declared as real columns here (not only in a
   * migration) because DB_SYNCHRONIZE=true drops anything it cannot see in the decorators.
   */
  @Column({ name: 'check_in_latitude', type: 'decimal', precision: 10, scale: 7, nullable: true })
  checkInLatitude: number | null;

  @Column({ name: 'check_in_longitude', type: 'decimal', precision: 10, scale: 7, nullable: true })
  checkInLongitude: number | null;

  /** GPS uncertainty radius reported by the device. A 5 m fix and a 2 km fix are not equal evidence. */
  @Column({ name: 'check_in_accuracy_meters', type: 'integer', nullable: true })
  checkInAccuracyMeters: number | null;

  /** Distance from the branch's own coordinates, so an out-of-geofence check-in is discoverable. */
  @Column({ name: 'check_in_distance_meters', type: 'integer', nullable: true })
  checkInDistanceMeters: number | null;

  @Column({ name: 'checked_in_at', type: 'timestamptz', nullable: true })
  checkedInAt: Date | null;

  @Column({ name: 'scheduled_date', type: 'date', nullable: true })
  scheduledDate: Date | null;

  @Column({ name: 'auto_schedule', type: 'boolean', default: true })
  autoSchedule: boolean;

  @Column({ name: 'completion_date', type: 'date', nullable: true })
  completionDate: Date | null;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;

  @Column({ name: 'sync_token', type: 'varchar', length: 100, nullable: true })
  syncToken: string | null;

  @Column({ name: 'negotiation_count', type: 'integer', default: 0 })
  negotiationCount: number;

  @Column({ name: 'entity_version', type: 'integer', default: 1 })
  entityVersion: number;

  @Column({ name: 'sla_due_date', type: 'timestamptz', nullable: true })
  slaDueDate: Date | null;

  @Column({ name: 'sla_status', type: 'varchar', length: 50, default: 'COMPLIANT' })
  slaStatus: string;

  @Column({ name: 'cancel_reason', type: 'text', nullable: true })
  cancelReason: string | null;

  @Column({ name: 'reject_reason', type: 'text', nullable: true })
  rejectReason: string | null;

  @ManyToOne(() => ProjectBranchEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'project_branch_id' })
  projectBranch: ProjectBranchEntity | null;

  @ManyToOne(() => AssessmentEntity, (a) => a.assignments, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'assessment_id' })
  assessment: AssessmentEntity | null;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;

  @Column({ name: 'execution_group_id', type: 'uuid', nullable: true })
  executionGroupId: string | null;

  @ManyToOne(() => OperationsExecutionGroupEntity, (eg) => eg.assignments, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'execution_group_id' })
  executionGroup: OperationsExecutionGroupEntity | null;

  /**
   * Reimbursement claims raised against this visit.
   *
   * Declared by entity name rather than an imported class: ExpenseEntity already points back
   * here, and importing it would close a cycle between the two modules. The mobile earnings
   * screen reads `assignment.expenses`, which is why this is loaded with the assayer's
   * assignment list — without it that screen totals an array that is never populated and
   * reports ₹0 regardless of what was claimed.
   */
  @OneToMany('ExpenseEntity', 'assignment')
  expenses: any[];
}
