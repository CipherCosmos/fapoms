import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WHY THE OFFICE CHECKED SOMEBODY IN.
 *
 * Owner decision 2026-09-24 (E12): ADMIN/OPERATIONS may still check an assayer in on their behalf
 * (skipping the day and distance rules, as before), but only with a written reason, and the record
 * must say it was the office. The existing `check_in_time_outcome` already says so
 * (`NOT_FROM_ASSAYER`, "Checked in by the office"); this column keeps the reason beside it so the
 * web record can show it. Nullable and additive: NULL on every assayer check-in and on every row
 * written before this change. Cleared, like the rest of the check-in evidence, when a job is reused
 * for or reassigned to another assayer.
 */
export class OfficeCheckInReason1800900000000 implements MigrationInterface {
  name = 'OfficeCheckInReason1800900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "check_in_office_reason" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN IF EXISTS "check_in_office_reason"`);
  }
}
