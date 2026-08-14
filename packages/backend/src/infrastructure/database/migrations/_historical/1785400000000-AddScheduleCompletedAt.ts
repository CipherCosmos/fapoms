import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddScheduleCompletedAt1785400000000 implements MigrationInterface {
  name = 'AddScheduleCompletedAt1785400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "schedules"
      ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMPTZ NULL
    `);

    // Backfill: set completed_at from updated_at for schedules already in COMPLETED status
    await queryRunner.query(`
      UPDATE "schedules"
      SET "completed_at" = "updated_at"
      WHERE "status" = 'COMPLETED' AND "completed_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "schedules"
      DROP COLUMN IF EXISTS "completed_at"
    `);
  }
}
