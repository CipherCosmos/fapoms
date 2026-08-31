import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { OverridableScoreKey } from '@fapoms/shared';

/**
 * A human's stated correction to one computed qualification score.
 *
 * The computed number and the override travel together everywhere — the API returns
 * `{computed, override, effective}` and screens show both, so an adjusted score is never
 * mistaken for a measured one. The reason is NOT NULL by design: an unexplained override is
 * indistinguishable from a mistake, and this row may end up justifying a number on paper a
 * partner bank was handed.
 *
 * `clientId` null means the override addresses the profile-level score; set, it addresses that
 * partner's score only. One LIVE override per (assayer, dimension, client-slot) — enforced by a
 * partial unique index in the migration, because a plain unique constraint cannot treat two
 * NULL clients as the same slot. Clearing an override soft-deletes it, so the history of who
 * adjusted what, when, and why survives — the same append-only philosophy as the background
 * check table.
 */
@Entity('assayer_score_overrides')
@Index(['assayerId'])
@Index(['assayerId', 'clientId'])
export class AssayerScoreOverrideEntity extends BaseEntity {
  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  /** Null = the profile-level score; set = the score for that partner only. */
  @Column({ name: 'client_id', type: 'uuid', nullable: true })
  clientId: string | null;

  /** A dimension key from the shared vocabulary, or 'overall'. */
  @Column({ name: 'dimension', type: 'varchar', length: 40 })
  dimension: OverridableScoreKey;

  /** 0–100, CHECK-constrained in the migration so a bad write cannot slip past a DTO. */
  @Column({ name: 'value', type: 'int' })
  value: number;

  /** Why a human moved the number. Required — see the class doc. */
  @Column({ name: 'reason', type: 'text' })
  reason: string;

  @Column({ name: 'set_by', type: 'uuid', nullable: true })
  setBy: string | null;

  @Column({ name: 'set_at', type: 'timestamptz', default: () => 'now()' })
  setAt: Date;
}
