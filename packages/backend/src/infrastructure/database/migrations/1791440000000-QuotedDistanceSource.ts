import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Record how the quoted distance on an offer was measured.
 *
 * ## Why
 *
 * `assignments.quoted_distance_km` freezes the home→branch distance the travel allowance was
 * priced from. Since August 2026 that figure comes from a road router (OSRM) with a great-circle
 * estimate as the labelled fallback, and the two differ by 11–56 % on real pairs from this
 * database (the straight line always under-states the road). The routing layer says which one it
 * returned — `RouteResult.source` — but the assignment threw the label away, so a fee quoted from
 * a straight line while the router was down was indistinguishable, forever, from one quoted by
 * road. Two places care:
 *
 *   - Audit: "why was this assayer paid travel for 164 km when the road is 213 km?" has an
 *     answer only if the row says the 164 was an estimate.
 *   - Travel verification compares the movement trail against `quoted_distance_km`. A trail that
 *     covers the whole road will read *over* a straight-line quote; knowing the quote was an
 *     estimate keeps that from looking like an over-claim.
 *
 * ## The change
 *
 * `quoted_distance_source varchar(10) NULL` — `'OSRM'` or `'ESTIMATE'`, written at offer time
 * next to the distance and never moved by negotiation, exactly like the other `quoted_*` columns.
 * NULL for rows with no quoted distance and for every offer made before this column existed. No
 * backfill: those older figures were haversine-derived and could honestly be stamped ESTIMATE,
 * but stamping history with a value nobody recorded at the time is the kind of tidiness an audit
 * column must not have — a NULL says "unrecorded", which is the truth. No CHECK constraint
 * either: the writer is one code path with a two-value union type, and a constraint would turn
 * a future third source (a self-hosted router, say) into a failed offer instead of a new label.
 */
export class QuotedDistanceSource1791440000000 implements MigrationInterface {
  name = 'QuotedDistanceSource1791440000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assignments"
        ADD COLUMN IF NOT EXISTS "quoted_distance_source" character varying(10)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN IF EXISTS "quoted_distance_source"`);
  }
}
