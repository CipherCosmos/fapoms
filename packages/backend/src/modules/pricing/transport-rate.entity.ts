import { Entity, Column, Index } from 'typeorm';
import { TravelMode } from '@fapoms/shared';
import { BaseEntity } from '../../core/entities/base.entity';

/**
 * What a kilometre actually costs by each way of getting there, for each part of the country.
 *
 * Until this table existed the platform had exactly one number for travel — a per-km rate on the
 * client's contract (₹8 by default) — applied identically whether the assayer rides their own
 * two-wheeler through Kerala or takes a taxi across Delhi. The desk had nothing to ground a
 * travel figure in when making or negotiating an offer, so travel money was argued in free-text
 * remarks and settled by feel.
 *
 * A row here says: travelling by `mode` in `scope`, expect `baseFare` to start plus `perKmRate`
 * per kilometre. The quote engine resolves the most specific applicable rows for a branch's
 * place and recommends an amount from them *before* the offer goes out (see
 * `TransportRateService.estimate` and `FeePolicyService.quote`).
 *
 * Scoping is deliberately limited to what the branch data can actually support — NATIONAL,
 * REGION (the closed six-value enum), and STATE (canonicalised names). District and city exist
 * on branches but as polluted free text (the RBL import writes district into the city column),
 * so scoping by them would silently fail to match; do not add those levels without a data
 * cleanup first.
 *
 * Rates are effective-dated rather than edited in place wherever history matters: yesterday's
 * offer was recommended from yesterday's rate, and that must remain inspectable after fuel
 * prices move. `isActive=false` retires a row without destroying that history.
 */
export type TransportRateScope = 'NATIONAL' | 'REGION' | 'STATE';

@Entity('transport_rates')
// Declared on the entity AND in the migration: dev runs synchronize=true, which rebuilds the
// table from this class and silently drops any index that lives only in the migration.
@Index('idx_transport_rates_scope', ['scopeType', 'scopeValue'])
@Index('idx_transport_rates_mode', ['mode'])
export class TransportRateEntity extends BaseEntity {
  /** One of the shared `TravelMode` values. Stored as text; validated at the service edge. */
  @Column({ type: 'varchar', length: 30 })
  mode: TravelMode;

  @Column({ name: 'scope_type', type: 'varchar', length: 20 })
  scopeType: TransportRateScope;

  /**
   * NULL for NATIONAL; a `Region` enum value for REGION; a canonical state name (exactly as
   * `canonicalStateName` returns it) for STATE. Never a raw import spelling — the service
   * canonicalises on write so lookups can compare by equality.
   */
  @Column({ name: 'scope_value', type: 'varchar', length: 60, nullable: true })
  scopeValue: string | null;

  /**
   * The cost of setting out at all: a bus ticket's minimum slab, an auto's meter drop, a
   * taxi's base charge. Zero for own vehicles, where only distance costs money.
   */
  @Column({ name: 'base_fare', type: 'decimal', precision: 10, scale: 2, default: 0 })
  baseFare: number;

  @Column({ name: 'per_km_rate', type: 'decimal', precision: 10, scale: 4 })
  perKmRate: number;

  /**
   * Marks the mode the desk recommends by default in this scope — the one whose cost becomes
   * the offer's travel component. Without a preferred row the estimate falls back to the
   * cheapest mode, which is defensible but blunt; preference is how policy like "reimburse at
   * bus rate in the South, own-vehicle rate in the North-East" is expressed.
   */
  @Column({ name: 'is_preferred', type: 'boolean', default: false })
  isPreferred: boolean;

  @Column({ name: 'effective_from', type: 'date' })
  effectiveFrom: string;

  /** NULL = open-ended. Setting this is how a rate is retired without losing its history. */
  @Column({ name: 'effective_to', type: 'date', nullable: true })
  effectiveTo: string | null;

  /** Why this rate is what it is — "state transport fare revision Apr 2026", etc. */
  @Column({ type: 'text', nullable: true })
  notes: string | null;
}
