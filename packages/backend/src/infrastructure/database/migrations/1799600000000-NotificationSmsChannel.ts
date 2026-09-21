import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TEXT MESSAGES AS A NOTIFICATION CHANNEL.
 *
 * The SMS leg gets the same bookkeeping the email leg has had since 1789300000000, and for the same
 * reason: its own lifecycle, separate from `status` (in-app/push) and from `email_status`. Sharing a
 * column would let one channel settling DELIVERED read as "the text went", and trip the other
 * channel's terminal-state guard — the interaction that once silently stopped every dual-channel
 * push. Column types mirror the email columns exactly (baseline 1784000000000).
 *
 * NULL sms_status = this row never owed anyone a text, which is every row today: no shipped event
 * carries SMS, and one only does once an administrator switches it on for that event.
 *
 * `notification_preferences.sms` defaults to true like every other channel: absence of an explicit
 * `false` means opted in, and a row created because somebody touched a different switch must not
 * arrive pre-muted (the bug the `email` column's old `false` default caused).
 */
export class NotificationSmsChannel1799600000000 implements MigrationInterface {
  name = 'NotificationSmsChannel1799600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notifications"
        ADD COLUMN IF NOT EXISTS "sms_status" character varying(16),
        ADD COLUMN IF NOT EXISTS "texted_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "sms_failure_reason" text
    `);

    // The stranded-text sweep polls for PENDING rows; the partial index keeps that poll from
    // scanning the whole (large, mostly-settled) notifications table every five minutes.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notifications_sms_pending"
      ON "notifications" ("created_at")
      WHERE "sms_status" = 'PENDING'
    `);

    await queryRunner.query(`
      ALTER TABLE "notification_preferences"
        ADD COLUMN IF NOT EXISTS "sms" boolean NOT NULL DEFAULT true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "sms"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_notifications_sms_pending"`);
    await queryRunner.query(`
      ALTER TABLE "notifications"
        DROP COLUMN IF EXISTS "sms_status",
        DROP COLUMN IF EXISTS "texted_at",
        DROP COLUMN IF EXISTS "sms_failure_reason"
    `);
  }
}
