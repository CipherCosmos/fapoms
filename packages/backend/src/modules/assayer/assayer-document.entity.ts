import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerEntity } from './assayer.entity';

@Entity('assayer_documents')
@Index(['assayerId'])
@Index(['documentType'])
export class AssayerDocumentEntity extends BaseEntity {
  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;

  @Column({ name: 'document_type', length: 50 })
  documentType: string;

  @Column({ name: 'file_name', length: 255 })
  fileName: string;

  @Column({ name: 'file_path', type: 'text' })
  filePath: string;

  @Column({ name: 'file_size', type: 'integer' })
  fileSize: number;

  @Column({ name: 'mime_type', type: 'varchar', length: 100, nullable: true })
  mimeType: string | null;

  @Column({ name: 'doc_version', type: 'integer', default: 1 })
  docVersion: number;

  @Column({ name: 'parent_document_id', type: 'uuid', nullable: true })
  parentDocumentId: string | null;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;
}
