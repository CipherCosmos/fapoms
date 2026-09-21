import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ONE LEDGER FOR EVERY MESSAGE, EMAIL OR TEXT.
 *
 * `outbound_emails` was built for the email queue. SMS joins on the same lifecycle — record, claim,
 * retry, sweep, erase the body on settle — so it gets a `channel` on the same table rather than a
 * second table with a second copy of every rule. Renamed to say what it now holds.
 */
export class OutboundMessages1799500000000 implements MigrationInterface {
  name = 'OutboundMessages1799500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "outbound_emails" RENAME TO "outbound_messages"`);
    await queryRunner.query(`ALTER TABLE "outbound_messages" RENAME CONSTRAINT "PK_outbound_emails" TO "PK_outbound_messages"`);
    await queryRunner.query(`ALTER TABLE "outbound_messages" RENAME CONSTRAINT "CHK_outbound_emails_status" TO "CHK_outbound_messages_status"`);
    await queryRunner.query(`ALTER INDEX IF EXISTS "idx_outbound_emails_unsettled" RENAME TO "idx_outbound_messages_unsettled"`);
    await queryRunner.query(`ALTER INDEX IF EXISTS "idx_outbound_emails_entity" RENAME TO "idx_outbound_messages_entity"`);
    await queryRunner.query(`
      ALTER TABLE "outbound_messages"
        ADD COLUMN IF NOT EXISTS "channel" varchar(8) NOT NULL DEFAULT 'EMAIL'
    `);
    await queryRunner.query(`
      ALTER TABLE "outbound_messages"
        ADD CONSTRAINT "CHK_outbound_messages_channel" CHECK ("channel" IN ('EMAIL', 'SMS'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "outbound_messages" WHERE "channel" <> 'EMAIL'`);
    await queryRunner.query(`ALTER TABLE "outbound_messages" DROP CONSTRAINT IF EXISTS "CHK_outbound_messages_channel"`);
    await queryRunner.query(`ALTER TABLE "outbound_messages" DROP COLUMN IF EXISTS "channel"`);
    await queryRunner.query(`ALTER INDEX IF EXISTS "idx_outbound_messages_entity" RENAME TO "idx_outbound_emails_entity"`);
    await queryRunner.query(`ALTER INDEX IF EXISTS "idx_outbound_messages_unsettled" RENAME TO "idx_outbound_emails_unsettled"`);
    await queryRunner.query(`ALTER TABLE "outbound_messages" RENAME CONSTRAINT "CHK_outbound_messages_status" TO "CHK_outbound_emails_status"`);
    await queryRunner.query(`ALTER TABLE "outbound_messages" RENAME CONSTRAINT "PK_outbound_messages" TO "PK_outbound_emails"`);
    await queryRunner.query(`ALTER TABLE "outbound_messages" RENAME TO "outbound_emails"`);
  }
}
