import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { BillingConflictStatus, BillingConflictAction, BillingConflictSeverity, BillingEntityType } from '@fapoms/shared';

/**
 * A conflict between billing records (spec §8). Conflict management is kept
 * separate from duplicate detection (spec §7): duplicates are automatically
 * flagged at creation, whereas conflicts are manually raised and resolved with
 * an explicit action, reason, and audit trail.
 */
@Entity('billing_conflicts')
@Index(['status'])
@Index(['severity'])
@Index(['entityType'])
export class BillingConflictEntity extends BaseEntity {
  @Column({ name: 'conflict_number', length: 50, unique: true })
  conflictNumber: string;

  @Column({ type: 'varchar', length: 20, default: BillingConflictSeverity.WARNING })
  severity: BillingConflictSeverity;

  @Column({ name: 'entity_type', type: 'varchar', length: 20 })
  entityType: BillingEntityType;

  @Column({ name: 'entry_ids', type: 'jsonb' })
  entryIds: string[];

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ name: 'created_by_id', type: 'uuid' })
  createdById: string;

  @Column({ type: 'varchar', length: 20, default: BillingConflictStatus.OPEN })
  status: BillingConflictStatus;

  @Column({ name: 'resolution_action', type: 'varchar', length: 20, nullable: true })
  resolutionAction: BillingConflictAction | null;

  @Column({ name: 'resolution_note', type: 'text', nullable: true })
  resolutionNote: string | null;

  @Column({ name: 'resolved_by', type: 'uuid', nullable: true })
  resolvedById: string | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @Column({ name: 'blocks_billing', type: 'boolean', default: false })
  blocksBilling: boolean;
}
