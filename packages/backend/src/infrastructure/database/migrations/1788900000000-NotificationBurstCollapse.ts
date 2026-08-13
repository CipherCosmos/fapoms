import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One bulk action should produce one notification, not one per record.
 *
 * `collapsed_count` records how many events a single notification row stands for. It is 1 for an
 * ordinary notification and higher when a burst of the same type reached the same person inside
 * that type's collapse window (see NotificationTypeDef.collapse) and was folded into the row
 * already sitting unread in their bell.
 *
 * The measured case: activating 25 assayers through `POST /assayers/bulk/lifecycle` wrote 50
 * notification rows in one minute — 25 identical "New assayer onboarded" lines into each of two
 * operations users' bells. The planning queue's bulk assign is worse in kind, because
 * ASSIGNMENT_OFFERED carries PUSH: offering one assayer forty branches meant forty pushes to one
 * phone for one operator's click.
 *
 * Nothing is lost that was not repetition. The surviving row keeps the first event's identity and
 * its text becomes the summary; every individual event is still in `audit_events`, which is where
 * "what exactly happened" is answered.
 *
 * The partial index supports the only query that reads this: "is there an open notification of
 * this type for this recipient?" — unread, live, recent. Indexing just those rows keeps it small,
 * since read and deleted notifications are the overwhelming majority of the table over time.
 */
export class NotificationBurstCollapse1788900000000 implements MigrationInterface {
  name = 'NotificationBurstCollapse1788900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notifications"
      ADD COLUMN IF NOT EXISTS "collapsed_count" integer NOT NULL DEFAULT 1
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_notifications_open_burst"
      ON "notifications" ("type", "user_id", "assayer_id", "created_at" DESC)
      WHERE "is_read" = false AND "is_active" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_notifications_open_burst"`);
    await queryRunner.query(`ALTER TABLE "notifications" DROP COLUMN IF EXISTS "collapsed_count"`);
  }
}
