import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Give the candidate pre-filter's three-way OR a BitmapOr plan.
 *
 * `findNearbyActiveAssayerIds` in `recommendation.engine.ts` filters on
 * `(is_live_enabled = true OR location IS NULL OR ST_DWithin(location::geography, ...))`.
 * The geography arm already has a matching GiST index (`idx_assayers_location_geography`,
 * from 1790300000000-RestoreScaleIndexes), but the other two arms had no index at all — and
 * Postgres will not build a BitmapOr plan unless every arm of the OR has *some* indexable
 * qual. Confirmed with EXPLAIN (ANALYZE, BUFFERS) plus `enable_seqscan = off`: even forced off,
 * the planner produced a plain Seq Scan, because it never had an alternative path to consider,
 * not because cost estimation picked the scan over one.
 *
 * These two small, partial, id-only indexes close the other two arms:
 *   - `is_live_enabled = true` is the common case, so the partial index only carries rows
 *     that satisfy it — cheap to build, cheap to scan.
 *   - `location IS NULL` is the "no coordinates yet" case; same reasoning.
 * Neither needs to carry any column beyond `id` — the planner only needs a TID bitmap out of
 * each arm before it heap-fetches and rechecks the real predicate.
 *
 * With both in place the planner produces:
 *   BitmapOr
 *     -> Bitmap Index Scan on idx_assayers_is_live_enabled_true
 *     -> Bitmap Index Scan on idx_assayers_location_null
 *     -> Bitmap Index Scan on idx_assayers_location_geography
 * and it picks that plan on its own cost estimate — no seqscan override needed.
 */
export class CandidatePrefilterBitmapOr1794650000000 implements MigrationInterface {
  name = 'CandidatePrefilterBitmapOr1794650000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assayers_is_live_enabled_true"
      ON "assayers" ("id")
      WHERE "is_live_enabled" = true
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assayers_location_null"
      ON "assayers" ("id")
      WHERE "location" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assayers_location_null"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assayers_is_live_enabled_true"`);
  }
}
