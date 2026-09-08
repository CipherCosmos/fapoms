import { Entity, Column, Index, ManyToOne, JoinColumn, PrimaryGeneratedColumn, CreateDateColumn, Unique } from 'typeorm';
import { OnboardingDocument, DocumentVerification } from '@fapoms/shared';
import { AssayerEntity } from './assayer.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';

@Entity('assayer_document_versions')
@Index(['documentId'])
@Index(['assayerId', 'requirement'])
@Unique(['documentId', 'version'])
export class AssayerDocumentVersionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'document_id', type: 'uuid' })
  documentId: string;

  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @Column({ type: 'varchar', length: 40 })
  requirement: OnboardingDocument;

  @Column({ type: 'int' })
  version: number;

  @Column({ name: 'file_path', type: 'text' })
  filePath: string;

  @Column({ name: 'file_checksum', type: 'varchar', length: 64, nullable: true })
  fileChecksum: string | null;

  @Column({ name: 'content_sha256', type: 'varchar', length: 64, nullable: true })
  contentSha256: string | null;

  @Column({ name: 'storage_object_id', type: 'text', nullable: true })
  storageObjectId: string | null;

  @Column({ name: 'file_size', type: 'bigint', nullable: true })
  fileSize: number | null;

  @Column({ name: 'mime_type', type: 'varchar', length: 100, nullable: true })
  mimeType: string | null;

  @CreateDateColumn({ name: 'uploaded_at', type: 'timestamptz' })
  uploadedAt: Date;

  @Column({ name: 'uploaded_by', type: 'uuid', nullable: true })
  uploadedBy: string | null;

  @Column({ name: 'verification_status', type: 'varchar', length: 20, default: DocumentVerification.PENDING })
  verificationStatus: DocumentVerification;

  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;

  @Column({ name: 'verified_by', type: 'uuid', nullable: true })
  verifiedBy: string | null;

  @Column({ name: 'rejection_reason', type: 'varchar', length: 40, nullable: true })
  rejectionReason: string | null;

  @Column({ name: 'superseded_by_version_id', type: 'uuid', nullable: true })
  supersededByVersionId: string | null;

  @Column({ name: 'superseded_at', type: 'timestamptz', nullable: true })
  supersededAt: Date | null;

  @ManyToOne(() => AssayerDocumentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_id' })
  document: AssayerDocumentEntity;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;
}
