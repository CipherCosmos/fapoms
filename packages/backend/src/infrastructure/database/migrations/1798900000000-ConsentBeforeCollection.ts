import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * THE NOTICE A CANDIDATE WAS SHOWN, AND THEIR RIGHT TO TAKE IT BACK.
 *
 * Consent used to be a tick-box on the last step of the form, recorded as the bare string "v1" with
 * no notice behind it: by the time it was ticked, the name, PAN, Aadhaar, bank account and every
 * scan had already been collected and saved. These columns carry the other half — the exact wording
 * accepted, and the withdrawal the DPDP Act gives every person.
 *
 * Existing rows keep their "v1" stamp and get no notice text, which is the honest record: those
 * candidates were never shown one.
 */
export class ConsentBeforeCollection1798900000000 implements MigrationInterface {
  name = 'ConsentBeforeCollection1798900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assayer_applications"
        ADD COLUMN IF NOT EXISTS "consent_notice" jsonb,
        ADD COLUMN IF NOT EXISTS "consent_withdrawn_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "consent_withdrawal_reason" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assayer_applications"
        DROP COLUMN IF EXISTS "consent_notice",
        DROP COLUMN IF EXISTS "consent_withdrawn_at",
        DROP COLUMN IF EXISTS "consent_withdrawal_reason"
    `);
  }
}
