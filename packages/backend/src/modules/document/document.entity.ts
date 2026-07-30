import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AssessmentEntity } from '../project/assessment.entity';
import { DocumentStatus, DocumentType, DispatchMethod } from '@fapoms/shared';

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

  // ── Transport audit trail (spec §8.6) ──────────────────────────────────────────
  // "Every document carries its full history: uploaded → dispatched (auto/manual, by whom,
  // when) → received back → sent to data entry → sent to external OCR → finalized."
  // `status` alone records only where the document is now, not how or when it got there,
  // so it could not answer "where is branch X's paperwork right now, and who moved it".

  @Column({ name: 'dispatched_at', type: 'timestamptz', nullable: true })
  dispatchedAt: Date | null;

  @Column({ name: 'dispatch_method', type: 'varchar', length: 20, nullable: true })
  dispatchMethod: DispatchMethod | null;

  /** User who dispatched, or null when the scheduled auto-dispatch job did it. */
  @Column({ name: 'dispatched_by', type: 'uuid', nullable: true })
  dispatchedBy: string | null;

  /** When the assayer's completed paperwork came back. */
  @Column({ name: 'received_at', type: 'timestamptz', nullable: true })
  receivedAt: Date | null;

  /** When it was handed to the Data Entry Head's queue. */
  @Column({ name: 'sent_to_data_entry_at', type: 'timestamptz', nullable: true })
  sentToDataEntryAt: Date | null;

  /** When ops manually pushed it into the external OCR application. */
  @Column({ name: 'sent_to_external_ocr_at', type: 'timestamptz', nullable: true })
  sentToExternalOcrAt: Date | null;

  @ManyToOne(() => ProjectBranchEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'project_branch_id' })
  projectBranch: ProjectBranchEntity | null;

  @ManyToOne(() => AssessmentEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'assessment_id' })
  assessment: AssessmentEntity | null;
}
