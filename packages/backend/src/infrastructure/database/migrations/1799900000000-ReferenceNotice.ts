import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TELLING A REFEREE.
 *
 * When a candidate is approved, each person they named as a reference is told HR may call them.
 * These record whether that happened, how, and — where it could not reach them every way it might
 * have — why, so the record never shows a silent gap or claims a text went that the gateway refused.
 */
export class ReferenceNotice1799900000000 implements MigrationInterface {
  name = 'ReferenceNotice1799900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assayer_references"
        ADD COLUMN IF NOT EXISTS "notified_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "notified_via" varchar(40),
        ADD COLUMN IF NOT EXISTS "notice_problem" varchar(300)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assayer_references"
        DROP COLUMN IF EXISTS "notice_problem",
        DROP COLUMN IF EXISTS "notified_via",
        DROP COLUMN IF EXISTS "notified_at"
    `);
  }
}
