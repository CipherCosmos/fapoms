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
// "Everything that happened in this session" — the per-session history the compliance ask centres on.
@Index('IDX_audit_events_session_id', ['sessionId'])
// The inbox's field-issue list reads by event_type on every load; without this it was two full
// scans of the widest table in the schema per page view. Also in 1790300000000-RestoreScaleIndexes.
@Index('IDX_audit_events_event_type_occurred', ['eventType', 'occurredAt'])
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
    name: 'actor_role',
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: "Actor's primary role at the time of the event, for non-repudiation.",
  })
  actorRole: string | null;

  @Column({
    name: 'user_agent',
    type: 'text',
    nullable: true,
    comment: 'Raw User-Agent of the actor client, stored unparsed.',
  })
  userAgent: string | null;

  @Column({
    name: 'session_id',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: 'Durable session id (access token sid), links the event to a device session.',
  })
  sessionId: string | null;

  @Column({
    name: 'request_id',
    type: 'varchar',
    length: 100,
    nullable: true,
    comment: 'Correlation/request id shared with logs, to trace one action across services.',
  })
  requestId: string | null;

  @Column({
    name: 'outcome',
    type: 'varchar',
    length: 20,
    nullable: true,
    comment: 'SUCCESS, FAILURE or DENIED — so refused and failed actions are auditable too.',
  })
  outcome: string | null;

  @Column({
    name: 'before',
    type: 'jsonb',
    nullable: true,
    comment: 'Structured field-level before-values of an edit. Never holds a sensitive value.',
  })
  before: Record<string, unknown> | null;

  @Column({
    name: 'after',
    type: 'jsonb',
    nullable: true,
    comment: 'Structured field-level after-values of an edit. Never holds a sensitive value.',
  })
  after: Record<string, unknown> | null;

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
