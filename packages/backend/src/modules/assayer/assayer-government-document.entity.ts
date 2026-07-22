import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerEntity } from './assayer.entity';

@Entity('assayer_government_documents')
@Index(['assayerId'])
@Index(['documentType'])
@Index(['verificationStatus'])
export class AssayerGovernmentDocumentEntity extends BaseEntity {
  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;

  @Column({ name: 'document_type', length: 50 })
  documentType: string;

  @Column({ name: 'document_number', length: 100 })
  documentNumber: string;

  @Column({ name: 'expiry_date', type: 'date', nullable: true })
  expiryDate: Date | null;

  @Column({ name: 'verification_status', length: 20, default: 'PENDING' })
  verificationStatus: string;

  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;

  @Column({ name: 'verified_by', type: 'uuid', nullable: true })
  verifiedBy: string | null;

  @Column({ name: 'file_paths', type: 'jsonb', default: [] })
  filePaths: string[];

  @Column({ type: 'text', nullable: true })
  remarks: string | null;
}
