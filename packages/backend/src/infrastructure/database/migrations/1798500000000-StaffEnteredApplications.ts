import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The application gate becomes the ONE way into the roster — including for HR itself.
 *
 * The owner approved the drawing where all three intake routes (HR desk, web self-service,
 * mobile self-service) pass through the application record and its review, and chose
 * maker–checker for the HR route: the person who types a candidate in must not be the person
 * who approves them. That is the same rule this product already applies to money, where the
 * booker cannot approve and the approver cannot pay.
 *
 * `source` is how the rule knows where to bite. On a SELF_SERVICE application the candidate is
 * the maker — the HR user who merely sent the invite may review it. On an HR_DESK application
 * the creating staff account IS the maker, and `approve()` refuses them.
 *
 * `extended_profile` carries what the wizard collects beyond the application's own columns —
 * bank and identity details, commercial rates, per-client standings, emergency contacts,
 * workload caps — held as a document until approval, because none of it should exist as live
 * roster data for a person who may yet be rejected. Promotion applies it after the record is
 * created, through the same guarded services the wizard used to call directly.
 */
export class StaffEnteredApplications1798500000000 implements MigrationInterface {
  name = 'StaffEnteredApplications1798500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assayer_applications"
        ADD COLUMN IF NOT EXISTS "source" character varying(20) NOT NULL DEFAULT 'SELF_SERVICE'
    `);
    await queryRunner.query(`
      ALTER TABLE "assayer_applications"
        ADD COLUMN IF NOT EXISTS "extended_profile" jsonb
    `);
    // The two values the code knows. A third intake someday must say so here first.
    await queryRunner.query(`
      ALTER TABLE "assayer_applications"
        ADD CONSTRAINT "chk_assayer_applications_source"
        CHECK ("source" IN ('SELF_SERVICE', 'HR_DESK'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assayer_applications" DROP CONSTRAINT IF EXISTS "chk_assayer_applications_source"`);
    await queryRunner.query(`ALTER TABLE "assayer_applications" DROP COLUMN IF EXISTS "extended_profile"`);
    await queryRunner.query(`ALTER TABLE "assayer_applications" DROP COLUMN IF EXISTS "source"`);
  }
}
