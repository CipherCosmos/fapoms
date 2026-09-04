import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';

/**
 * Fine-grained UI interaction telemetry — the "click by click" trail, kept privacy-first.
 *
 * This is the granular front-end activity the owner asked for (page views, the control someone used,
 * a filter they applied) on TOP of the server-side audit trail. It is deliberately NOT part of the
 * immutable, hash-chained audit evidence: it is high-volume operational analytics, so it lives in
 * its own table with ordinary retention (the UI_TELEMETRY class — short by default, in the spirit of
 * DPDP data-minimisation) and is purged, not sealed.
 *
 * The privacy line is the important part. A telemetry row records WHAT someone did and WHERE — an
 * action's label, the route — never the DATA they were looking at or typed. There is no value
 * column, the client is built to send descriptors not contents, and the ingestion service scrubs
 * anything PII-shaped that slips through anyway. Identity (user, session, IP) comes from the
 * authenticated request context, never from the client payload.
 */
@Entity('activity_telemetry')
@Index('IDX_activity_telemetry_user', ['userId'])
@Index('IDX_activity_telemetry_occurred', ['occurredAt'])
export class ActivityTelemetryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'session_id', type: 'uuid', nullable: true })
  sessionId: string | null;

  @Column({
    name: 'event_type',
    type: 'varchar',
    length: 24,
    comment: 'PAGE_VIEW | ACTION | FILTER | SEARCH | ERROR — a closed allowlist.',
  })
  eventType: string;

  @Column({ name: 'path', type: 'varchar', length: 300, nullable: true })
  path: string | null;

  @Column({
    name: 'label',
    type: 'varchar',
    length: 160,
    nullable: true,
    comment: 'The action/element descriptor — never a field value.',
  })
  label: string | null;

  @Column({ name: 'ip_address', type: 'varchar', length: 50, nullable: true })
  ipAddress: string | null;

  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;
}
