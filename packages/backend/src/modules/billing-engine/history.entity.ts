import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { BillingEntityType } from '@fapoms/shared';

/**
 * Complete, immutable history of every billing change (spec §10): who, what,
 * when, previous/new value, reason, and the owning Client/Project/Assignment/
 * Assayer. Every state transition, adjustment, split/merge, invoice, payment,
 * dispute, cancellation, and conflict lifecycle step writes one row here.
 */
@Entity('billing_history')
@Index(['entityType', 'entityId'])
// The unified audit trail reads one entity's history newest-first. Also in
// 1790300000000-RestoreScaleIndexes.
@Index('IDX_billing_history_entity_created', ['entityType', 'entityId', 'createdAt'])
@Index(['clientId'])
@Index(['projectId'])
@Index(['assignmentId'])
@Index(['assayerId'])
@Index(['createdAt'])
export class BillingHistoryEntity extends BaseEntity {
  @Column({ name: 'client_id', type: 'uuid', nullable: true })
  clientId: string | null;

  @Column({ name: 'project_id', type: 'uuid', nullable: true })
  projectId: string | null;

  @Column({ name: 'assignment_id', type: 'uuid', nullable: true })
  assignmentId: string | null;

  @Column({ name: 'assayer_id', type: 'uuid', nullable: true })
  assayerId: string | null;

  @Column({ name: 'entity_type', type: 'varchar', length: 20 })
  entityType: BillingEntityType;

  @Column({ name: 'entity_id', type: 'uuid' })
  entityId: string;

  @Column({ type: 'varchar', length: 100 })
  action: string;

  @Column({ name: 'from_state', type: 'varchar', length: 30, nullable: true })
  fromState: string | null;

  @Column({ name: 'to_state', type: 'varchar', length: 30, nullable: true })
  toState: string | null;

  @Column({ name: 'previous_value', type: 'jsonb', nullable: true })
  previousValue: Record<string, unknown> | null;

  @Column({ name: 'new_value', type: 'jsonb', nullable: true })
  newValue: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ name: 'user_name', type: 'varchar', length: 255, nullable: true })
  userName: string | null;
}
