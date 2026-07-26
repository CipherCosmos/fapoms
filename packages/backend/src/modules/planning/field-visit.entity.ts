import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';

export enum FieldVisitStatus {
  READY = 'READY',
  DISPATCHED = 'DISPATCHED',
  TRAVELLING = 'TRAVELLING',
  ARRIVED = 'ARRIVED',
  AUDIT_STARTED = 'AUDIT_STARTED',
  EVIDENCE_COLLECTION = 'EVIDENCE_COLLECTION',
  AUDIT_COMPLETED = 'AUDIT_COMPLETED',
  DELIVERABLE_PREPARATION = 'DELIVERABLE_PREPARATION',
  SUBMITTED = 'SUBMITTED',
  HANDOVER_READY = 'HANDOVER_READY',
}

@Entity('operations_field_visits')
@Index(['branchId'])
@Index(['assayerId'])
@Index(['status'])
export class FieldVisitEntity extends BaseEntity {
  @Column({ name: 'coverage_plan_id', type: 'uuid' })
  coveragePlanId: string;

  @Column({ name: 'execution_group_id', type: 'uuid' })
  executionGroupId: string;

  @Column({ name: 'branch_id', type: 'uuid' })
  branchId: string;

  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @Column({ name: 'planned_date', type: 'date' })
  plannedDate: string;

  @Column({
    type: 'enum',
    enum: FieldVisitStatus,
    default: FieldVisitStatus.READY,
  })
  status: FieldVisitStatus;

  @Column({ name: 'actual_start_time', type: 'timestamptz', nullable: true })
  actualStartTime: Date | null;

  @Column({ name: 'actual_end_time', type: 'timestamptz', nullable: true })
  actualEndTime: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  evidenceReadiness: {
    documentsCollected: boolean;
    photosCollected: boolean;
    formsCompleted: boolean;
    missingEvidenceList: string[];
  };

  @Column({ type: 'text', nullable: true })
  completionSummary: string | null;
}
