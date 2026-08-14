import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Email delivery bookkeeping on notifications.
 *
 * The EMAIL channel has been promised for a long time — the enum value, the preference
 * column, the settings toggle all existed — with nothing behind them able to send. Now that
 * the delivery worker actually emails, each row needs its own record of that leg: a separate
 * lifecycle from `status`, which belongs to in-app/push. Sharing one column would let push
 * marking a row DELIVERED read as "the email went" (and trip the other channel's
 * terminal-state guard — the exact interaction that once silently stopped every dual-channel
 * push).
 *
 * NULL email_status = this row never owed anyone an email.
 */
export class NotificationEmailChannel1789300000000 implements MigrationInterface {
  name = 'NotificationEmailChannel1789300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notifications"
        ADD COLUMN IF NOT EXISTS "email_status" character varying(16),
        ADD COLUMN IF NOT EXISTS "emailed_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "email_failure_reason" text
    `);

    // The stranded-email sweep polls for PENDING rows; partial index keeps that poll from
    // scanning the whole (large, mostly-settled) notifications table every five minutes.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notifications_email_pending"
      ON "notifications" ("created_at")
      WHERE "email_status" = 'PENDING'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_notifications_email_pending"`);
    await queryRunner.query(`
      ALTER TABLE "notifications"
        DROP COLUMN IF EXISTS "email_status",
        DROP COLUMN IF EXISTS "emailed_at",
        DROP COLUMN IF EXISTS "email_failure_reason"
    `);
  }
}
