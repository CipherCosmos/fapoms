import { MigrationInterface, QueryRunner } from 'typeorm';
import { resolveRegion } from '@fapoms/shared';

/**
 * Normalises `branches.region` onto the canonical `Region` enum and adds `users.regions`.
 *
 * ## Why the backfill is needed
 *
 * `branches.region` was free text and two seeders disagreed about what belongs in it: the demo
 * seed wrote `'West'` / `'South'` / `'Central'`, the RBL seed wrote the *state name*. A global
 * region filter over that column would have listed "Maharashtra" and "West" as sibling options,
 * and picking either would hide every branch recorded under the other convention — the filter
 * would look like it worked while quietly dropping rows.
 *
 * The backfill resolves each branch's region from its `state` first (the field that is reliably
 * populated), falling back to interpreting the existing `region` string as a legacy alias.
 * Anything `resolveRegion` cannot place is left untouched rather than guessed at: an
 * unrecognised value stays visible under "All regions" and gets fixed by a human.
 *
 * ## Reversibility
 *
 * The pre-migration values are copied into `branches_region_backup` before anything is
 * rewritten, and `down()` restores from it. Without that this migration would be one-way —
 * the original strings are not recoverable from the normalised ones.
 *
 * ## users.regions
 *
 * The assigned-region scope for operators. `NULL` or `{}` means "all regions" (the existing
 * behaviour, so every current account keeps full visibility until someone is deliberately
 * narrowed). A non-empty array restricts what `ScopeContext` will let the request read.
 */
export class NormalizeRegionsAndUserRegionScope1788300000000 implements MigrationInterface {
  name = 'NormalizeRegionsAndUserRegionScope1788300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- users.regions -----------------------------------------------------
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "regions" text[] NULL`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "users"."regions" IS 'Assigned operational regions. NULL or empty means all regions.'`,
    );

    // --- snapshot before rewriting ----------------------------------------
    await queryRunner.query(`DROP TABLE IF EXISTS "branches_region_backup"`);
    await queryRunner.query(
      `CREATE TABLE "branches_region_backup" AS SELECT "id", "region" FROM "branches"`,
    );

    // --- backfill branches.region -----------------------------------------
    // One UPDATE per distinct (state, region) pair. Branch volumes are in the thousands and
    // distinct pairs in the dozens, so this is a handful of indexed statements, not a row loop.
    const pairs: Array<{ state: string | null; region: string | null }> =
      await queryRunner.query(`SELECT DISTINCT "state", "region" FROM "branches"`);

    for (const pair of pairs) {
      const resolved = resolveRegion(pair.state) ?? resolveRegion(pair.region);
      if (!resolved || resolved === pair.region) continue;

      await queryRunner.query(
        `UPDATE "branches" SET "region" = $1
           WHERE "state" IS NOT DISTINCT FROM $2
             AND "region" IS NOT DISTINCT FROM $3`,
        [resolved, pair.state, pair.region],
      );
    }

    // The column is filtered on constantly once the global scope filter ships.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_branches_region_state" ON "branches" ("region", "state")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_branches_region_state"`);

    const backupExists: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT to_regclass('public.branches_region_backup') IS NOT NULL AS exists`,
    );
    if (backupExists?.[0]?.exists) {
      await queryRunner.query(
        `UPDATE "branches" b SET "region" = k."region"
           FROM "branches_region_backup" k WHERE k."id" = b."id"`,
      );
      await queryRunner.query(`DROP TABLE "branches_region_backup"`);
    }

    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "regions"`);
  }
}
