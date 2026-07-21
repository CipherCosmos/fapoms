import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerEntity } from './assayer.entity';

@Entity('workforce_attributes')
@Index(['assayerId'])
@Index(['type', 'name'])
export class WorkforceAttributeEntity extends BaseEntity {
  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;

  @Column({ type: 'varchar', length: 50 })
  type: string; // 'SKILL', 'CERTIFICATION', 'LANGUAGE'

  @Column({ type: 'varchar', length: 150 })
  name: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  level: string | null; // e.g. 'BEGINNER', 'INTERMEDIATE', 'EXPERT'

  @Column({ name: 'expiry_date', type: 'timestamptz', nullable: true })
  expiryDate: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;
}
