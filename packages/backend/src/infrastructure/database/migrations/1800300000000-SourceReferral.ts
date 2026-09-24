import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WHO REFERRED AN ASSAYER.
 *
 * Separate from the three references a candidate gives for background verification — those vouch
 * for them; this is who brought them to us. Recorded at intake on the interview, carried on the
 * application (`extendedProfile.sourceReferral`) and kept on the person at approval.
 */
export class SourceReferral1800300000000 implements MigrationInterface {
  name = 'SourceReferral1800300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assayer_interviews" ADD COLUMN IF NOT EXISTS "source_referral" jsonb`);
    await queryRunner.query(`ALTER TABLE "assayers" ADD COLUMN IF NOT EXISTS "source_referral" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assayers" DROP COLUMN IF EXISTS "source_referral"`);
    await queryRunner.query(`ALTER TABLE "assayer_interviews" DROP COLUMN IF EXISTS "source_referral"`);
  }
}
