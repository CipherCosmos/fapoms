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
// The data-entry desk queue: type + status + assignee, ordered by received_at. Also in
// 1790300000000-RestoreScaleIndexes.
@Index('IDX_documents_type_status_received', ['type', 'status', 'receivedAt'], { where: '"is_active" = true' })
@Index('IDX_documents_assigned_to_user', ['assignedToUserId'], { where: '"is_active" = true AND "assigned_to_user_id" IS NOT NULL' })
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

  /**
   * For a PRE_FIELD_AUDIT_PDF: the customer-master batch it was generated from.
   *
   * One client batch produces one PDF per branch in it. Without this link there was
   * no way to ask "the batch covered ten branches — have all ten PDFs been produced
   * and sent?", because each PDF was uploaded individually with no memory of the
   * run it belonged to.
   */
  @Column({ name: 'customer_master_version_id', type: 'uuid', nullable: true })
  customerMasterVersionId: string | null;

  // ── Transport audit trail (spec §8.6) ──────────────────────────────────────────
  // "Every document carries its full history: uploaded → dispatched (auto/manual, by whom,
  // when) → received back → sent to data entry → sent to external OCR → finalized."
  // `status` alone records only where the document is now, not how or when it got there,
  // so it could not answer "where is branch X's paperwork right now, and who moved it".

  @Column({ name: 'dispatched_at', type: 'timestamptz', nullable: true })
  dispatchedAt: Date | null;

  @Column({ name: 'dispatch_method', type: 'varchar', length: 20, nullable: true })
  dispatchMethod: DispatchMethod | null;

  /**
   * The address a dispatched document was emailed to, when it went to one.
   *
   * Several clients take the packet at the branch and have the assayer collect it there, rather
   * than the assayer downloading it. Null means the old route: the assayer was notified and
   * fetches it from the app.
   */
  @Column({ name: 'dispatched_to_email', type: 'varchar', length: 320, nullable: true })
  dispatchedToEmail: string | null;

  /** User who dispatched, or null when the scheduled auto-dispatch job did it. */
  @Column({ name: 'dispatched_by', type: 'uuid', nullable: true })
  dispatchedBy: string | null;

  /** When the assayer's completed paperwork came back. */
  @Column({ name: 'received_at', type: 'timestamptz', nullable: true })
  receivedAt: Date | null;

  /** When it was handed to the Data Entry Head's queue. */
  /**
   * Which data entry team member owns this packet. SENT_TO_DATA_ENTRY recorded
   * that a packet had reached the desk but not who was working it, so the head
   * had no way to distribute and no member had a queue of their own.
   */
  @Column({ name: 'assigned_to_user_id', type: 'uuid', nullable: true })
  assignedToUserId: string | null;

  @Column({ name: 'assigned_at', type: 'timestamptz', nullable: true })
  assignedAt: Date | null;

  @Column({ name: 'assigned_by', type: 'uuid', nullable: true })
  assignedBy: string | null;

  /** Set when the member hands the processed packet back to the head. */
  @Column({ name: 'data_entry_completed_at', type: 'timestamptz', nullable: true })
  dataEntryCompletedAt: Date | null;

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
