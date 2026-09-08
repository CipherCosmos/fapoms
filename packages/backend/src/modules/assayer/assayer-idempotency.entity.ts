import { Entity, Column, Index, ManyToOne, JoinColumn, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';
import { AssayerEntity } from './assayer.entity';

@Entity('assayer_idempotency_records')
@Index(['organizationId', 'clientRequestId'], { unique: true })
@Index(['assayerId'])
export class AssayerIdempotencyEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'client_request_id', type: 'varchar', length: 100 })
  clientRequestId: string;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @Column({ type: 'varchar', length: 50 })
  command: string;

  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId: string | null;

  @Column({ name: 'request_hash', type: 'varchar', length: 64 })
  requestHash: string;

  @Column({ name: 'response_payload', type: 'jsonb' })
  responsePayload: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;
}
