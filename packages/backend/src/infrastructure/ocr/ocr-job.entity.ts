import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { DocumentEntity } from '../../modules/document/document.entity';

export enum OcrJobStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

@Entity('ocr_jobs')
@Index(['documentId'])
@Index(['status'])
export class OcrJobEntity extends BaseEntity {
  @Column({ name: 'document_id', type: 'uuid' })
  documentId: string;

  @Column({ name: 'external_job_id', type: 'varchar', length: 150, nullable: true })
  externalJobId: string | null;

  @Column({
    type: 'enum',
    enum: OcrJobStatus,
    default: OcrJobStatus.PENDING,
  })
  status: OcrJobStatus;

  @Column({ name: 'ocr_payload', type: 'jsonb', nullable: true })
  ocrPayload: any | null;

  @Column({ name: 'retry_count', type: 'integer', default: 0 })
  retryCount: number;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  @ManyToOne(() => DocumentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_id' })
  document: DocumentEntity;
}
