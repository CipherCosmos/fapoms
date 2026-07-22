import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerEntity } from './assayer.entity';

@Entity('assayer_remarks')
@Index(['assayerId'])
@Index(['category'])
export class AssayerRemarkEntity extends BaseEntity {
  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;

  @Column({ name: 'author_id', type: 'uuid' })
  authorId: string;

  @Column({ name: 'author_name', length: 200 })
  authorName: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ length: 50, default: 'GENERAL' })
  category: string;

  @Column({ length: 50, default: 'PUBLIC' })
  visibility: string;

  @Column({ name: 'attachment_paths', type: 'jsonb', default: [] })
  attachmentPaths: string[];
}
