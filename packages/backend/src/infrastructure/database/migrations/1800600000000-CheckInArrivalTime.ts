import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WHICH CLOCK A CHECK-IN IS WRITTEN IN.
 *
 * Owner decision 2026-09-24: the field app may send the time the phone actually arrived at the
 * branch (a check-in sent from a basement with no signal reaches the server late). `checked_in_at`
 * takes the phone's time only when it is the same business day, recent (setting
 * `field.checkInArrivalMaxAgeHours`), not in the future, and corroborated by a location-trail fix
 * inside the check-in zone (setting `field.checkInArrivalTrailWindowMinutes`); otherwise the
 * server's receive time is used, exactly as before.
 *
 * These columns keep both sides of that decision so it can be audited: when the server received the
 * check-in, what the phone claimed, which one became `checked_in_at`, and why. All nullable and
 * additive — every existing row, and every check-in from an app that sends no arrival time, keeps
 * the meaning it had. Nothing is backfilled: a receive time nobody recorded is not invented.
 */
export class CheckInArrivalTime1800600000000 implements MigrationInterface {
  name = 'CheckInArrivalTime1800600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assignments"
        ADD COLUMN IF NOT EXISTS "check_in_received_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "check_in_claimed_arrival_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "check_in_time_source" varchar(16),
        ADD COLUMN IF NOT EXISTS "check_in_time_outcome" varchar(32)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assignments"
        DROP COLUMN IF EXISTS "check_in_time_outcome",
        DROP COLUMN IF EXISTS "check_in_time_source",
        DROP COLUMN IF EXISTS "check_in_claimed_arrival_at",
        DROP COLUMN IF EXISTS "check_in_received_at"
    `);
  }
}
