import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * When a message held back by a broken channel may be tried again.
 *
 * A mail server refusing our login (EAUTH/535), or an SMS gateway refusing our key or unreachable,
 * is a fault of the CHANNEL: every message gets the same answer, and every one becomes deliverable
 * once the credential or the network is fixed. Those messages used to be settled FAILED for good.
 * Now, once their quick retries are spent, they go back to QUEUED with `retry_after` set, and the
 * two-minute sweep leaves them alone until it passes. Null for everything else.
 */
export class OutboundMessageRetryAfter1801600000000 implements MigrationInterface {
  name = 'OutboundMessageRetryAfter1801600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "outbound_messages" ADD COLUMN IF NOT EXISTS "retry_after" TIMESTAMPTZ NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "outbound_messages" DROP COLUMN IF EXISTS "retry_after"`);
  }
}
