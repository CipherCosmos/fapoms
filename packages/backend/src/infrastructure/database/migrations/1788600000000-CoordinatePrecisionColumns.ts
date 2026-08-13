import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Record how precise each stored coordinate is.
 *
 * Branches and assayers carried a latitude and a longitude and nothing else, so a coordinate
 * resolved to a mapped building and one that had fallen back to a state centroid were the same
 * two numbers by the time anything read them. That is not an abstract concern: the
 * assayer-matching radius, the conflict-of-interest floor, the travel-cost calculation and the
 * "no assayer within serviceable range" flag all measure distances between these points, and on
 * this database 40 of 82 branches shared a coordinate with another branch because they had all
 * fallen back to the same city or state centroid.
 *
 * `geo_source` also carries `'manual'`, which is load-bearing rather than informational: it is
 * how a hand-placed pin survives every future re-geocode, import and backfill.
 *
 * Additive and reversible. Existing rows get NULL, which `needsBetterFix` reads as "unknown, and
 * therefore due a re-resolve" — the honest default for a coordinate with no recorded provenance.
 */
export class CoordinatePrecisionColumns1788600000000 implements MigrationInterface {
  name = 'CoordinatePrecisionColumns1788600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['branches', 'assayers']) {
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "geo_source" varchar(20)`);
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "geo_accuracy_meters" integer`);
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "geo_matched_name" varchar(500)`);
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "geo_resolved_at" timestamptz`);
      // The precision worklist and the backfill both scan for coarse rows; without this they
      // sequential-scan the whole table every time an operator opens the page.
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "IDX_${table}_geo_accuracy" ON "${table}" ("geo_accuracy_meters")`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping these loses every manual pin's protected status — the coordinates survive, but
    // the next backfill would overwrite hand-placed ones. Stated here because that is the cost
    // of reverting, and it is not obvious from the column names.
    for (const table of ['branches', 'assayers']) {
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_${table}_geo_accuracy"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "geo_resolved_at"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "geo_matched_name"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "geo_accuracy_meters"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "geo_source"`);
    }
  }
}
