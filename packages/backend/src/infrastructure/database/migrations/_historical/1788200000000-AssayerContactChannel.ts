import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `assayers.preferred_contact_channel` — the dual-channel model's switch.
 *
 * Not every assayer uses a smartphone, so an in-app offer is not a channel they all have. The
 * desk works phone-first for those people: offers surface as call tasks in the Operations Inbox,
 * outcomes are recorded on their behalf (backed by call_logs), and the SLA auto-decline is
 * suppressed for them. AUTO (the default) derives the channel from whether the assayer has an
 * active device token; APP/PHONE are explicit overrides set on the profile.
 */
export class AssayerContactChannel1788200000000 implements MigrationInterface {
  name = 'AssayerContactChannel1788200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "assayers" ADD COLUMN IF NOT EXISTS "preferred_contact_channel" varchar(10) NOT NULL DEFAULT 'AUTO'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assayers" DROP COLUMN IF EXISTS "preferred_contact_channel"`);
  }
}
