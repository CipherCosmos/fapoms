import { MigrationInterface, QueryRunner } from 'typeorm';
import { resolveRegion } from '@fapoms/shared';

/**
 * Normalises `assayers.region` and `assayers.preferred_regions` onto the canonical `Region`
 * enum, the same treatment `branches.region` got in the previous migration.
 *
 * Separate from that migration because it already shipped; folding this in would have meant
 * editing an applied migration, which is worse than one more file.
 *
 * The data here is closer to correct than the branch data was — it holds `'South'`, `'West'`,
 * `'North'`, `'East'` — but the casing is inconsistent (`'south'` alongside `'South'`), and
 * `IN ('SOUTH')` matches neither. Scoping the workforce list by region needs the same closed
 * vocabulary the branches use, or an operator scoped to South sees an arbitrary subset of the
 * assayers who actually work there.
 */
export class NormalizeAssayerRegions1788400000000 implements MigrationInterface {
  name = 'NormalizeAssayerRegions1788400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "assayers_region_backup"`);
    await queryRunner.query(
      `CREATE TABLE "assayers_region_backup" AS
         SELECT "id", "region", "preferred_regions" FROM "assayers"`,
    );

    // --- assayers.region ---------------------------------------------------
    const regions: Array<{ region: string | null }> = await queryRunner.query(
      `SELECT DISTINCT "region" FROM "assayers" WHERE "region" IS NOT NULL`,
    );
    for (const row of regions) {
      const resolved = resolveRegion(row.region);
      if (!resolved || resolved === row.region) continue;
      await queryRunner.query(`UPDATE "assayers" SET "region" = $1 WHERE "region" = $2`, [
        resolved,
        row.region,
      ]);
    }

    // --- assayers.preferred_regions (jsonb array of strings) ---------------
    // Rewritten per row: the arrays are short and few, and doing it in SQL would mean
    // reimplementing the state→region map in plpgsql, where it would immediately drift from
    // the TypeScript one that every other code path uses.
    const rows: Array<{ id: string; preferred_regions: string[] | null }> =
      await queryRunner.query(
        `SELECT "id", "preferred_regions" FROM "assayers"
          WHERE "preferred_regions" IS NOT NULL AND jsonb_array_length("preferred_regions") > 0`,
      );
    for (const row of rows) {
      const source = Array.isArray(row.preferred_regions) ? row.preferred_regions : [];
      const mapped = source.map((r) => resolveRegion(r) ?? r);
      // Deduplicate: two spellings of one region collapse into a single canonical entry.
      const next = [...new Set(mapped)];
      if (next.length === source.length && next.every((v, i) => v === source[i])) continue;
      await queryRunner.query(`UPDATE "assayers" SET "preferred_regions" = $1::jsonb WHERE "id" = $2`, [
        JSON.stringify(next),
        row.id,
      ]);
    }

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_assayers_region" ON "assayers" ("region")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assayers_region"`);
    const exists: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT to_regclass('public.assayers_region_backup') IS NOT NULL AS exists`,
    );
    if (exists?.[0]?.exists) {
      await queryRunner.query(
        `UPDATE "assayers" a
            SET "region" = k."region", "preferred_regions" = k."preferred_regions"
           FROM "assayers_region_backup" k WHERE k."id" = a."id"`,
      );
      await queryRunner.query(`DROP TABLE "assayers_region_backup"`);
    }
  }
}
