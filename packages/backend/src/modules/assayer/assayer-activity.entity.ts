import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerEntity } from './assayer.entity';

@Entity('assayer_activities')
@Index(['assayerId'])
@Index(['occurredAt'])
export class AssayerActivityEntity extends BaseEntity {
  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;

  @Column({ name: 'event_type', length: 100 })
  eventType: string;

  @Column({ name: 'previous_state', type: 'varchar', length: 50, nullable: true })
  previousState: string | null;

  @Column({ name: 'new_state', type: 'varchar', length: 50, nullable: true })
  newState: string | null;

  @Column({ name: 'performed_by', type: 'uuid' })
  performedBy: string;

  @Column({ name: 'performed_by_name', type: 'varchar', length: 200, nullable: true })
  performedByName: string | null;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;

  @Column({ name: 'occurred_at', type: 'timestamptz', default: () => 'NOW()' })
  occurredAt: Date;
}
