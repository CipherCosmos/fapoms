import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The declaration a candidate signs has to survive becoming an employee.
 *
 * `assayer_applications` records `consent_accepted_at` and `consent_version`, and submitting is
 * refused without them — "You must accept the declaration and consent before submitting." Then
 * promotion copied thirteen fields onto the new assayer and neither of those two was among them,
 * because `assayers` had nowhere to put them. So the one artefact with a compliance life of its
 * own — what this person agreed to, and which wording of it — lived only on a row whose purpose
 * ends the moment it is approved.
 *
 * Nullable, and stays null for everybody already on the roster: a consent nobody recorded cannot
 * be invented by a migration, and a default here would manufacture exactly the false record this
 * column exists to keep honest. The record screen reads a blank as "not on file", which for those
 * rows is the truth.
 */
export class CarryConsentOntoTheRecord1798700000000 implements MigrationInterface {
  name = 'CarryConsentOntoTheRecord1798700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assayers"
        ADD COLUMN IF NOT EXISTS "consent_accepted_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "consent_version" character varying(20)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assayers"
        DROP COLUMN IF EXISTS "consent_version",
        DROP COLUMN IF EXISTS "consent_accepted_at"
    `);
  }
}
