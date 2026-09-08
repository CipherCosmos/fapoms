import { Entity, Column, Index, ManyToOne, JoinColumn, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';
import { AssignmentEntity } from './assignment.entity';

@Entity('assignment_idempotency_records')
@Index(['clientRequestId'], { unique: true })
@Index(['assignmentId'])
export class AssignmentIdempotencyEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'client_request_id', type: 'varchar', length: 100, unique: true })
  clientRequestId: string;

  @Column({ name: 'assignment_id', type: 'uuid' })
  assignmentId: string;

  @Column({ type: 'varchar', length: 50 })
  command: string;

  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId: string | null;

  @Column({ name: 'request_hash', type: 'varchar', length: 64 })
  requestHash: string;

  @Column({ name: 'entity_version', type: 'int' })
  entityVersion: number;

  @Column({ name: 'response_payload', type: 'jsonb' })
  responsePayload: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => AssignmentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assignment_id' })
  assignment: AssignmentEntity;
}
