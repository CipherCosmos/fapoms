import { MigrationInterface, QueryRunner } from 'typeorm';
import { resolveRegion } from '@fapoms/shared';

/**
 * Fills `assayers.region` where it is NULL, deriving it from the assayer's state.
 *
 * The earlier `NormalizeAssayerRegions` migration only canonicalised values that were already
 * present. It could not help rows that never had one — and that is most of them: nothing on
 * the write path set the column, so every seeded assayer carried `region = NULL` while having
 * a perfectly good `state`. The consequence is silent and total: `region IN ('WEST')` matches
 * no NULL, so a region-assigned operator's map, roster and capacity tile all show an empty
 * workforce while the desk is fully staffed.
 *
 * `AssayerService.create`/`update` now derive the column on write, so this is a one-time
 * catch-up for existing rows rather than a recurring repair.
 *
 * Rows whose state cannot be resolved are left NULL on purpose. A NULL region is treated as
 * "visible to everyone" by `RegionGuardService`, which keeps the gap fixable — an assayer
 * hidden from every scoped operator is an assayer nobody can correct.
 */
export class BackfillAssayerRegionFromState1788500000000 implements MigrationInterface {
  name = 'BackfillAssayerRegionFromState1788500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const states: Array<{ state: string | null }> = await queryRunner.query(
      `SELECT DISTINCT "state" FROM "assayers" WHERE "region" IS NULL AND "state" IS NOT NULL`,
    );

    for (const row of states) {
      const resolved = resolveRegion(row.state);
      if (!resolved) continue;
      await queryRunner.query(
        `UPDATE "assayers" SET "region" = $1 WHERE "region" IS NULL AND "state" IS NOT DISTINCT FROM $2`,
        [resolved, row.state],
      );
    }
  }

  public async down(): Promise<void> {
    // Deliberately not reversible. Restoring NULLs would re-break workforce scoping, and the
    // pre-migration state carries no information the canonical value does not — the region is
    // derived from the state, which is untouched.
  }
}
