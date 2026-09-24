import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ONE ASSAYER, SEVERAL BRANCHES ON THE SAME DAY.
 *
 * Owner decision 2026-09-24 (E2): an assayer may be given several branches on one day, with no
 * limit. `idx_assignments_single_active_assayer_day` (migration 1796300000000) was a partial UNIQUE
 * index on `(assayer_id, scheduled_date)` over the in-flight statuses, i.e. the database's half of
 * the old one-job-per-day rule. The application half (`ConstraintEvaluator.checkDoubleBooking`, the
 * day-planner cap, the reassignment pre-check, the integrity scan) is removed in the same change.
 *
 * Only the UNIQUENESS goes. Lookups by assayer and day are still served by the non-unique
 * `idx_assignments_assayer_day (assayer_id, scheduled_date, status) WHERE is_active` (migration
 * 1790300000000). The one-open-job-per-BRANCH rule (`idx_assignments_single_active_branch`) is
 * untouched.
 *
 * `down()` recreates the index as it was. It will fail if, by then, any assayer holds two in-flight
 * assignments on one date — which is now legitimate data, so a rollback has to decide what to do
 * with those rows first; the migration will not silently cancel anybody's work to make room.
 */
export class SeveralBranchesPerAssayerDay1800800000000 implements MigrationInterface {
  name = 'SeveralBranchesPerAssayerDay1800800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assignments_single_active_assayer_day"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_assignments_single_active_assayer_day"
      ON "assignments" ("assayer_id", "scheduled_date")
      WHERE "is_active" = true AND "scheduled_date" IS NOT NULL
      AND "status" IN ('PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS')
    `);
  }
}
