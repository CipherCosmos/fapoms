import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import type { BranchEntity } from './branch.entity';

@Entity('branch_documents')
@Index(['branchId'])
export class BranchDocumentEntity extends BaseEntity {
  @Column({ name: 'branch_id', type: 'uuid' })
  branchId: string;

  @ManyToOne('BranchEntity', 'documents', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'branch_id' })
  branch: BranchEntity;

  @Column({ name: 'file_name', length: 255 })
  fileName: string;

  @Column({ name: 'file_path', type: 'text' })
  filePath: string;

  @Column({ name: 'file_size', type: 'integer' })
  fileSize: number;

  @Column({ name: 'mime_type', type: 'varchar', length: 100, nullable: true })
  mimeType: string | null;

  @Column({ length: 50 })
  category: string;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;
}
