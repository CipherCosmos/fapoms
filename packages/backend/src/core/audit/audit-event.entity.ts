/**
 * FAPOMS — Audit Event Entity
 *
 * Immutable, append-only audit trail per Part 6 §11.
 * Records every business event with:
 *   - Event Type, Time, Initiating User
 *   - Related Entity, Previous State, New State
 *   - Optional Remarks
 *
 * This table must NEVER have UPDATE or DELETE operations.
 */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('audit_events')
@Index(['entityType', 'entityId'])
@Index(['occurredAt'])
@Index(['userId'])
@Index(['category'])
export class AuditEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'varchar',
    length: 50,
    comment: 'Event category: OPERATIONAL, USER, WORKFLOW, SYSTEM',
  })
  category: string;

  @Column({
    name: 'event_type',
    type: 'varchar',
    length: 100,
    comment: 'Specific event type, e.g. ASSIGNMENT_ACCEPTED, PROJECT_CREATED',
  })
  eventType: string;

  @Column({
    name: 'entity_type',
    type: 'varchar',
    length: 100,
    comment: 'Type of entity this event relates to, e.g. PROJECT, ASSIGNMENT',
  })
  entityType: string;

  @Column({
    name: 'entity_id',
    type: 'uuid',
    comment: 'ID of the entity this event relates to',
  })
  entityId: string;

  @Column({
    name: 'previous_state',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  previousState: string | null;

  @Column({
    name: 'new_state',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  newState: string | null;

  @Column({
    name: 'user_id',
    type: 'uuid',
    nullable: true,
    comment: 'User who triggered the event (null for system events)',
  })
  userId: string | null;

  @Column({
    name: 'user_display_name',
    type: 'varchar',
    length: 200,
    nullable: true,
  })
  userDisplayName: string | null;

  @Column({
    name: 'ip_address',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  ipAddress: string | null;

  @Column({
    type: 'text',
    nullable: true,
  })
  remarks: string | null;

  @Column({
    type: 'jsonb',
    nullable: true,
    comment: 'Additional structured data about the event',
  })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({
    name: 'occurred_at',
    type: 'timestamptz',
  })
  occurredAt: Date;
}
