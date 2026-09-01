import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The other end of the on-site window.
 *
 * `check-in` has existed since the beginning and records the one moment the platform knows for
 * certain that an assayer was at a branch. Nothing recorded when they left. So an assignment's
 * attendance evidence was a start with no end: time on site could not be stated, a visit that
 * was abandoned after ten minutes looked identical to one that ran all day, and the travel
 * assessment had an arrival to measure a journey towards and nothing to measure the return from.
 *
 * Columns mirror the check-in set exactly — same names, same types, same nullability — because
 * they are the same evidence about the opposite moment, and a reader who understands one should
 * not have to learn a second shape. Distance is stored the same way too: computed once, from the
 * branch coordinate, at the moment it is recorded.
 *
 * All nullable, no backfill. Every assignment that already exists genuinely has no departure
 * recorded, and inventing one would be fabricating attendance evidence in a system whose whole
 * purpose is to hold it.
 */
export class AssignmentCheckOut1794100000000 implements MigrationInterface {
  name = 'AssignmentCheckOut1794100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assignments"
        ADD COLUMN IF NOT EXISTS "checked_out_at" TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS "check_out_latitude" DECIMAL(10,7) NULL,
        ADD COLUMN IF NOT EXISTS "check_out_longitude" DECIMAL(10,7) NULL,
        ADD COLUMN IF NOT EXISTS "check_out_accuracy_meters" INTEGER NULL,
        ADD COLUMN IF NOT EXISTS "check_out_distance_meters" INTEGER NULL
    `);

    /**
     * "Still on site" is the question this gets asked most: everyone who checked in today and has
     * not checked out. Partial, so the index covers only the rows that can answer it rather than
     * every assignment ever completed.
     */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assignments_on_site"
        ON "assignments" ("checked_in_at")
        WHERE "checked_in_at" IS NOT NULL AND "checked_out_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assignments_on_site"`);
    await queryRunner.query(`
      ALTER TABLE "assignments"
        DROP COLUMN IF EXISTS "check_out_distance_meters",
        DROP COLUMN IF EXISTS "check_out_accuracy_meters",
        DROP COLUMN IF EXISTS "check_out_longitude",
        DROP COLUMN IF EXISTS "check_out_latitude",
        DROP COLUMN IF EXISTS "checked_out_at"
    `);
  }
}
