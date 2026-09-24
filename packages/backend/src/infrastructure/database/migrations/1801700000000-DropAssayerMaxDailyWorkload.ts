import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Remove "Most jobs per day" (`assayers.max_daily_workload`).
 *
 * Owner decision 2026-09-25. The owner decided on 2026-09-24 (E2) that an assayer may take several
 * branches on one day with no limit, and the planner, the engine and the assignment write path
 * already stopped reading a per-day cap. The setting stayed on the HR forms, the record and the
 * roster export — a number HR was asked to maintain that decided nothing — and the Command Centre
 * still summed it into a "daily capacity" nobody had set deliberately (default 3 on every row).
 * Capacity there is now headcount-based; the column goes.
 *
 * Down restores the column at its old default; the values HR had typed are not recoverable, and
 * nothing reads them.
 */
export class DropAssayerMaxDailyWorkload1801700000000 implements MigrationInterface {
  name = 'DropAssayerMaxDailyWorkload1801700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assayers" DROP COLUMN IF EXISTS "max_daily_workload"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "assayers" ADD COLUMN IF NOT EXISTS "max_daily_workload" integer NOT NULL DEFAULT 3`,
    );
  }
}
