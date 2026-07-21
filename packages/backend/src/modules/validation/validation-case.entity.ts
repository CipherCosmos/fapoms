import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { ValidationStatus } from '@fapoms/shared';

@Entity('validation_cases')
@Index(['projectBranchId'])
@Index(['status'])
export class ValidationCaseEntity extends BaseEntity {
  @Column({ name: 'project_branch_id', type: 'uuid' })
  projectBranchId: string;

  @Column({
    type: 'enum',
    enum: ValidationStatus,
    default: ValidationStatus.PENDING,
  })
  status: ValidationStatus;

  @Column({ name: 'ocr_result', type: 'jsonb', nullable: true })
  ocrResult: any | null;

  @Column({ name: 'reviewer_id', type: 'uuid', nullable: true })
  reviewerId: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamp with time zone', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;

  @Column({ name: 'correction_notes', type: 'text', nullable: true })
  correctionNotes: string | null;

  @ManyToOne(() => ProjectBranchEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_branch_id' })
  projectBranch: ProjectBranchEntity;
}
