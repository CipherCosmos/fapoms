import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AssessmentEntity } from '../project/assessment.entity';
import { DocumentStatus, DocumentType } from '@fapoms/shared';

@Entity('documents')
@Index(['projectBranchId'])
@Index(['assessmentId'])
@Index(['status'])
@Index(['type'])
export class DocumentEntity extends BaseEntity {
  @Column({ name: 'project_branch_id', type: 'uuid', nullable: true })
  projectBranchId: string | null;

  @Column({ name: 'assessment_id', type: 'uuid', nullable: true })
  assessmentId: string | null;

  @Column({ name: 'file_name', length: 255 })
  fileName: string;

  @Column({ name: 'file_path', type: 'text' })
  filePath: string;

  @Column({ name: 'file_size', type: 'integer' })
  fileSize: number;

  @Column({ name: 'mime_type', type: 'varchar', length: 100, nullable: true })
  mimeType: string | null;

  @Column({
    type: 'enum',
    enum: DocumentType,
  })
  type: DocumentType;

  @Column({
    type: 'enum',
    enum: DocumentStatus,
    default: DocumentStatus.UPLOADED,
  })
  status: DocumentStatus;

  @Column({ name: 'doc_version', type: 'integer', default: 1 })
  docVersion: number;

  @ManyToOne(() => ProjectBranchEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'project_branch_id' })
  projectBranch: ProjectBranchEntity | null;

  @ManyToOne(() => AssessmentEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'assessment_id' })
  assessment: AssessmentEntity | null;
}
