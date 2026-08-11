import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds an opt-in live location to assayers, separate from their home address.
 *
 * Assayers already carry home coordinates (`latitude`/`longitude`). Ride-hailing
 * style planning wants to rank by *where the person actually is right now*, not
 * where they live — but only if the assayer explicitly agrees to share it. These
 * columns let the mobile app push a live position and toggle sharing on/off,
 * without ever overwriting the home address. `is_live_enabled` defaults to
 * false, so nothing changes for any assayer until they opt in.
 */
export class AssayerLiveLocation1787200000000 implements MigrationInterface {
  name = 'AssayerLiveLocation1787200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assayers"
        ADD COLUMN IF NOT EXISTS "is_live_enabled"  boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "live_latitude"    numeric(10,7),
        ADD COLUMN IF NOT EXISTS "live_longitude"   numeric(10,7),
        ADD COLUMN IF NOT EXISTS "live_location"    geometry(Point,4326)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_assayers_live_location"
      ON "assayers" USING GIST ("live_location")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_assayers_live_enabled"
      ON "assayers" ("is_live_enabled")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_assayers_live_enabled"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_assayers_live_location"`);
    await queryRunner.query(`
      ALTER TABLE "assayers"
        DROP COLUMN IF EXISTS "is_live_enabled",
        DROP COLUMN IF EXISTS "live_latitude",
        DROP COLUMN IF EXISTS "live_longitude",
        DROP COLUMN IF EXISTS "live_location"
    `);
  }
}
