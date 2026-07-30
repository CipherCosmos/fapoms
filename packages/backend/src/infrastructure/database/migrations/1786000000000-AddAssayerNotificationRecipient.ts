import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a notification be addressed to an assayer.
 *
 * `notifications.user_id` was NOT NULL with a hard FK to `users`. Assayers are a separate
 * identity space — they authenticate straight from the `assayers` table and have no `users`
 * row (verified: zero assayer emails match any user). So every attempt to notify an assayer
 * threw FK violation FK_9a8a82462cab47c73d25f49261f, and because callers wrap notification
 * sends in try/catch it failed *silently*: audit PDFs were dispatched and clarification
 * queries raised with the assayer never actually told.
 *
 * The read path already expected this to work — an assayer's JWT carries `sub: assayer.id`
 * and `findMyNotifications` looks notifications up by that id — so the schema was the only
 * thing out of step.
 *
 * Rather than dropping the constraint and letting `user_id` become an untyped "recipient id",
 * both columns are nullable with their own FK and exactly one is populated per row, keeping
 * referential integrity for each recipient type.
 *
 * Additive and safe: existing rows all have `user_id` set and are untouched.
 */
export class AddAssayerNotificationRecipient1786000000000 implements MigrationInterface {
  name = 'AddAssayerNotificationRecipient1786000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "assayer_id" uuid`);
    await queryRunner.query(`ALTER TABLE "notifications" ALTER COLUMN "user_id" DROP NOT NULL`);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_name = 'notifications' AND kcu.column_name = 'assayer_id'
        ) THEN
          ALTER TABLE "notifications"
            ADD CONSTRAINT "FK_notifications_assayer_id"
            FOREIGN KEY ("assayer_id") REFERENCES "assayers"("id") ON DELETE CASCADE;
        END IF;
      END $$;
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_notifications_assayer_id" ON "notifications" ("assayer_id")`);

    // Exactly one recipient per row.
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CHK_notifications_one_recipient') THEN
          ALTER TABLE "notifications"
            ADD CONSTRAINT "CHK_notifications_one_recipient"
            CHECK (("user_id" IS NOT NULL AND "assayer_id" IS NULL)
                OR ("user_id" IS NULL AND "assayer_id" IS NOT NULL));
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "CHK_notifications_one_recipient"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_notifications_assayer_id"`);
    await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "FK_notifications_assayer_id"`);
    // Rows addressed to assayers cannot satisfy a NOT NULL user_id; remove them before restoring it.
    await queryRunner.query(`DELETE FROM "notifications" WHERE "user_id" IS NULL`);
    await queryRunner.query(`ALTER TABLE "notifications" ALTER COLUMN "user_id" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "notifications" DROP COLUMN IF EXISTS "assayer_id"`);
  }
}
