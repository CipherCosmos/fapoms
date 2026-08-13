import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../core/entities/base.entity';

/**
 * The current rule-bypass window, as a row.
 *
 * In the database rather than an environment variable or process memory for two reasons that
 * both matter. The backend runs as more than one process, and a control that is on in one and
 * off in another is worse than no control at all — an assayer's check-in would succeed or fail
 * depending on which container answered. And a bypass has to be *auditable after the fact*: who
 * turned it on, when, why, and what it covered, long after it expired.
 *
 * Rows are never updated in place and never deleted. Each enable writes a new row and each
 * disable closes the current one, so the table is a history of every window the controls were
 * suspended in — which is the record an auditor would ask for first.
 */
@Entity('rule_bypass_windows')
export class RuleBypassWindowEntity extends BaseEntity {
  /** The rules suspended in this window — values of the shared `BypassableRule` enum. */
  @Column({ type: 'jsonb' })
  rules: string[];

  /** Free text, required. "Testing check-in flow for the RBL pilot" — not optional, on purpose. */
  @Column({ type: 'text' })
  reason: string;

  @Column({ name: 'enabled_by', type: 'uuid' })
  enabledBy: string;

  /** Denormalised so the banner and the audit trail read correctly after the user is deleted. */
  @Column({ name: 'enabled_by_name', type: 'varchar', length: 200, nullable: true })
  enabledByName: string | null;

  @Column({ name: 'starts_at', type: 'timestamptz' })
  startsAt: Date;

  /**
   * When this window stops applying, with no further action from anyone.
   *
   * The realistic failure mode is not abuse — it is somebody suspending the geofence on a
   * Friday to test one screen, and nobody noticing it is still off three weeks later. Capped at
   * MAX_BYPASS_HOURS so a window cannot be opened indefinitely even deliberately.
   */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /** Set when someone turns it off before it expires. Null while running or expired naturally. */
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ name: 'revoked_by', type: 'uuid', nullable: true })
  revokedBy: string | null;

  /**
   * How many times each rule was actually skipped in this window.
   *
   * The difference between "we turned the geofence off for two hours" and "we turned the
   * geofence off and 40 check-ins used it" is the difference between a note and a finding.
   * Counted per rule so the closing record says exactly what the window was used for.
   */
  @Column({ name: 'usage_counts', type: 'jsonb', default: () => "'{}'::jsonb" })
  usageCounts: Record<string, number>;
}
