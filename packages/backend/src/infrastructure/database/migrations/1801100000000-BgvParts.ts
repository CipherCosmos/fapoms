import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * THE THREE PARTS OF A BACKGROUND VERIFICATION (owner, 2026-09-24) — see `bgv-parts.ts` in shared.
 *
 * A background verification is recorded as clear only with its address check (physical or
 * digital), CIBIL check and court check on it. CIBIL already had its columns (`cibil_band`,
 * `cibil_score`); the address and court checks get theirs here. Nullable and additive: checks
 * recorded before today carry none, and nothing is back-filled — nobody knows what those agencies
 * checked, and a guess here would read as a finding.
 */
export class BgvParts1801100000000 implements MigrationInterface {
  name = 'BgvParts1801100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "assayer_background_checks" ADD COLUMN IF NOT EXISTS "address_check_method" varchar(10)`);
    await q.query(`ALTER TABLE "assayer_background_checks" ADD COLUMN IF NOT EXISTS "address_check_result" varchar(20)`);
    await q.query(`ALTER TABLE "assayer_background_checks" ADD COLUMN IF NOT EXISTS "court_check_result" varchar(20)`);
    await q.query(`
      DO $$ BEGIN
        ALTER TABLE "assayer_background_checks" ADD CONSTRAINT "CHK_assayer_background_checks_address_method"
          CHECK ("address_check_method" IS NULL OR "address_check_method" IN ('PHYSICAL', 'DIGITAL'));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        ALTER TABLE "assayer_background_checks" ADD CONSTRAINT "CHK_assayer_background_checks_address_result"
          CHECK ("address_check_result" IS NULL OR "address_check_result" IN ('VERIFIED', 'DISCREPANCY', 'UNABLE_TO_VERIFY'));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        ALTER TABLE "assayer_background_checks" ADD CONSTRAINT "CHK_assayer_background_checks_court_result"
          CHECK ("court_check_result" IS NULL OR "court_check_result" IN ('NO_RECORD', 'CIVIL_CASE', 'CRIMINAL_CASE'));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const c of ['court_result', 'address_result', 'address_method']) {
      await q.query(`ALTER TABLE "assayer_background_checks" DROP CONSTRAINT IF EXISTS "CHK_assayer_background_checks_${c}"`);
    }
    for (const c of ['court_check_result', 'address_check_result', 'address_check_method']) {
      await q.query(`ALTER TABLE "assayer_background_checks" DROP COLUMN IF EXISTS "${c}"`);
    }
  }
}
