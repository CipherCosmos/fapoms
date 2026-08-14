import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Converts `assayers.status` and `assayers.lifecycle_status` from plain
 * varchar(50) columns into real Postgres ENUM types, matching every other
 * status-bearing table in the schema (projects, project_branches,
 * assignments, assessments, documents, validation_cases, schedules all use
 * enum-typed status columns already). AssayerEntity already imports
 * AssayerStatus / AssayerLifecycleStatus from @fapoms/shared for the column
 * `default:` values, but the columns themselves were left as bare varchar.
 *
 * Verified against live data in `fapoms-postgres` (2026-07-30): the only
 * distinct values present are 'ACTIVE' for both `status` and
 * `lifecycle_status`, so the USING casts below are safe for the current
 * dataset. Re-verify before running against any environment whose data may
 * differ.
 *
 * NOTE: This migration is NOT executed as part of this change — it is
 * written for human review before being run, per project policy on altering
 * enum types against the live database.
 */
export class ConvertAssayerStatusColumnsToEnum1785500000000 implements MigrationInterface {
  name = 'ConvertAssayerStatusColumnsToEnum1785500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Create the two enum types (guarded so this migration is re-run safe).
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."assayers_status_enum" AS ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."assayers_lifecycle_status_enum" AS ENUM(
          'INVITED', 'DOCUMENT_VERIFICATION', 'BACKGROUND_VERIFICATION', 'TRAINING',
          'ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'INACTIVE', 'RESIGNED', 'TERMINATED', 'ARCHIVED'
        );
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);

    // 2. Convert "status": varchar(50) -> enum. Postgres requires an explicit
    // USING cast when changing an existing column's type to an enum type.
    await queryRunner.query(`ALTER TABLE "assayers" ALTER COLUMN "status" DROP DEFAULT`);
    await queryRunner.query(`
      ALTER TABLE "assayers"
      ALTER COLUMN "status" TYPE "public"."assayers_status_enum"
      USING "status"::text::"public"."assayers_status_enum"
    `);
    await queryRunner.query(`
      ALTER TABLE "assayers" ALTER COLUMN "status" SET DEFAULT 'ACTIVE'::"public"."assayers_status_enum"
    `);

    // 3. Convert "lifecycle_status": varchar(50) -> enum.
    await queryRunner.query(`ALTER TABLE "assayers" ALTER COLUMN "lifecycle_status" DROP DEFAULT`);
    await queryRunner.query(`
      ALTER TABLE "assayers"
      ALTER COLUMN "lifecycle_status" TYPE "public"."assayers_lifecycle_status_enum"
      USING "lifecycle_status"::text::"public"."assayers_lifecycle_status_enum"
    `);
    await queryRunner.query(`
      ALTER TABLE "assayers" ALTER COLUMN "lifecycle_status" SET DEFAULT 'INVITED'::"public"."assayers_lifecycle_status_enum"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revert "lifecycle_status" -> varchar(50)
    await queryRunner.query(`ALTER TABLE "assayers" ALTER COLUMN "lifecycle_status" DROP DEFAULT`);
    await queryRunner.query(`
      ALTER TABLE "assayers"
      ALTER COLUMN "lifecycle_status" TYPE character varying(50)
      USING "lifecycle_status"::text
    `);
    await queryRunner.query(`ALTER TABLE "assayers" ALTER COLUMN "lifecycle_status" SET DEFAULT 'INVITED'`);

    // Revert "status" -> varchar(50)
    await queryRunner.query(`ALTER TABLE "assayers" ALTER COLUMN "status" DROP DEFAULT`);
    await queryRunner.query(`
      ALTER TABLE "assayers"
      ALTER COLUMN "status" TYPE character varying(50)
      USING "status"::text
    `);
    await queryRunner.query(`ALTER TABLE "assayers" ALTER COLUMN "status" SET DEFAULT 'ACTIVE'`);

    await queryRunner.query(`DROP TYPE IF EXISTS "public"."assayers_lifecycle_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."assayers_status_enum"`);
  }
}
