import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CHECKS DONE OVER TIME (owner, 2026-09-23) — see `periodic-checks.ts` in shared.
 *
 *  - `check_type` on every check: BGV, POLICE, CREDIT or IDENTITY. Every row on file today is a
 *    background verification, so the default is BGV and nothing is back-filled by guesswork.
 *  - The senior's review of an adverse re-check on somebody already working: PENDING until decided,
 *    then KEPT (kept working) or SUSPENDED, with who, when and why.
 *  - `assayers.compliance_hold`: set while such a review is pending — the person is held from new
 *    work until it is decided. Cleared only by the decision.
 */
export class PeriodicChecks1800500000000 implements MigrationInterface {
  name = 'PeriodicChecks1800500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "assayer_background_checks" ADD COLUMN IF NOT EXISTS "check_type" varchar(20) NOT NULL DEFAULT 'BGV'`);
    await q.query(`ALTER TABLE "assayer_background_checks" ADD COLUMN IF NOT EXISTS "review_status" varchar(20)`);
    await q.query(`ALTER TABLE "assayer_background_checks" ADD COLUMN IF NOT EXISTS "reviewed_by" uuid`);
    await q.query(`ALTER TABLE "assayer_background_checks" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamptz`);
    await q.query(`ALTER TABLE "assayer_background_checks" ADD COLUMN IF NOT EXISTS "review_reason" text`);
    await q.query(`
      DO $$ BEGIN
        ALTER TABLE "assayer_background_checks" ADD CONSTRAINT "CHK_assayer_background_checks_type"
          CHECK ("check_type" IN ('BGV', 'POLICE', 'CREDIT', 'IDENTITY'));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        ALTER TABLE "assayer_background_checks" ADD CONSTRAINT "CHK_assayer_background_checks_review"
          CHECK ("review_status" IS NULL OR "review_status" IN ('PENDING', 'KEPT', 'SUSPENDED'));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    // "The latest check of each type" — asked of every candidate in a planning run.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "idx_assayer_background_checks_latest"
        ON "assayer_background_checks" ("assayer_id", "check_type", "checked_on" DESC)
    `);
    await q.query(`ALTER TABLE "assayers" ADD COLUMN IF NOT EXISTS "compliance_hold" jsonb`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "assayers" DROP COLUMN IF EXISTS "compliance_hold"`);
    await q.query(`DROP INDEX IF EXISTS "idx_assayer_background_checks_latest"`);
    await q.query(`ALTER TABLE "assayer_background_checks" DROP CONSTRAINT IF EXISTS "CHK_assayer_background_checks_review"`);
    await q.query(`ALTER TABLE "assayer_background_checks" DROP CONSTRAINT IF EXISTS "CHK_assayer_background_checks_type"`);
    for (const c of ['review_reason', 'reviewed_at', 'reviewed_by', 'review_status', 'check_type']) {
      await q.query(`ALTER TABLE "assayer_background_checks" DROP COLUMN IF EXISTS "${c}"`);
    }
  }
}
