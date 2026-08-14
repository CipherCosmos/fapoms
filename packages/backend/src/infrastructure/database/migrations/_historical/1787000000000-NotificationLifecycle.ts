import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives a notification a lifecycle, an identity and a reason for existing.
 *
 * The table shipped with seven useful columns — recipient, title, message,
 * `is_read`, link — which is enough to render a row and nothing else. It could
 * not answer: what kind of event was this, did it ever actually reach the
 * person, which channel carried it, was it deliberately suppressed, or is this
 * the third copy of something already sent. Those are exactly the questions the
 * notification centre, push retry and the audit trail all need.
 *
 * Everything added is nullable or defaulted so the existing rows stay valid and
 * the deploy needs no backfill window. Existing rows are then classified in one
 * pass: anything already read becomes `READ`, everything else `DELIVERED`,
 * because a row that exists was, by the old code path, already in someone's
 * inbox — calling those `PENDING` would make the queue try to re-send history.
 */
export class NotificationLifecycle1787000000000 implements MigrationInterface {
  name = 'NotificationLifecycle1787000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const add = async (col: string, ddl: string) => {
      await queryRunner.query(`ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "${col}" ${ddl}`);
    };

    // ── Classification: what this notification is about ──────────────────
    await add('type', 'varchar(64)');
    await add('category', `varchar(32) NOT NULL DEFAULT 'SYSTEM'`);
    await add('priority', `varchar(16) NOT NULL DEFAULT 'NORMAL'`);

    // ── Delivery lifecycle ───────────────────────────────────────────────
    await add('status', `varchar(16) NOT NULL DEFAULT 'PENDING'`);
    await add('channels', `jsonb NOT NULL DEFAULT '["IN_APP"]'::jsonb`);
    await add('sent_at', 'timestamptz');
    await add('delivered_at', 'timestamptz');
    await add('read_at', 'timestamptz');
    await add('failed_at', 'timestamptz');
    await add('failure_reason', 'text');
    await add('attempts', 'integer NOT NULL DEFAULT 0');

    // ── Traceability / deep linking ──────────────────────────────────────
    await add('entity_type', 'varchar(64)');
    await add('entity_id', 'uuid');
    await add('payload', 'jsonb');
    // Which event caused this, so a notification can be traced back to the
    // business action that produced it.
    await add('source_event_id', 'uuid');
    // The actor whose action triggered it — used to avoid notifying someone
    // about their own action.
    await add('actor_user_id', 'uuid');

    // ── Deduplication ────────────────────────────────────────────────────
    // One logical event fanned out to five people is five rows sharing a
    // `group_key`; the same event re-fired is caught by `dedupe_key`.
    await add('dedupe_key', 'varchar(200)');
    await add('group_key', 'varchar(200)');

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_notifications_dedupe"
      ON "notifications" ("dedupe_key") WHERE "dedupe_key" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_notifications_status" ON "notifications" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_notifications_category" ON "notifications" ("category")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_notifications_entity" ON "notifications" ("entity_type", "entity_id")
    `);
    // The notification centre's primary read: my unread, newest first.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_notifications_user_unread"
      ON "notifications" ("user_id", "is_read", "created_at" DESC)
    `);

    // Classify pre-existing rows (see class comment for why not PENDING).
    await queryRunner.query(`
      UPDATE "notifications"
      SET "status" = CASE WHEN "is_read" THEN 'READ' ELSE 'DELIVERED' END,
          "delivered_at" = COALESCE("delivered_at", "created_at"),
          "read_at" = CASE WHEN "is_read" THEN COALESCE("read_at", "updated_at") ELSE "read_at" END,
          "type" = COALESCE("type", 'LEGACY')
      WHERE "status" = 'PENDING'
    `);

    /**
     * Per-user, per-category delivery preferences.
     *
     * Absence of a row means "send on every channel" — opt-out rather than
     * opt-in, so adding this table cannot silently mute anyone who has never
     * visited the preferences screen.
     */
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_preferences" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_by" varchar, "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_by" varchar, "updated_at" timestamptz NOT NULL DEFAULT now(),
        "version" integer NOT NULL DEFAULT 1,
        "is_active" boolean NOT NULL DEFAULT true,
        "user_id" uuid,
        "assayer_id" uuid,
        "category" varchar(32) NOT NULL,
        "in_app" boolean NOT NULL DEFAULT true,
        "push" boolean NOT NULL DEFAULT true,
        "email" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_notification_preferences" PRIMARY KEY ("id"),
        CONSTRAINT "FK_notif_pref_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_notif_pref_assayer" FOREIGN KEY ("assayer_id") REFERENCES "assayers"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_notif_pref_recipient" CHECK (
          ("user_id" IS NOT NULL AND "assayer_id" IS NULL) OR
          ("user_id" IS NULL AND "assayer_id" IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_notif_pref_user_cat"
      ON "notification_preferences" ("user_id", "category") WHERE "user_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_notif_pref_assayer_cat"
      ON "notification_preferences" ("assayer_id", "category") WHERE "assayer_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_preferences"`);
    for (const idx of [
      'UQ_notifications_dedupe', 'IDX_notifications_status', 'IDX_notifications_category',
      'IDX_notifications_entity', 'IDX_notifications_user_unread',
    ]) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${idx}"`);
    }
    for (const col of [
      'type', 'category', 'priority', 'status', 'channels', 'sent_at', 'delivered_at',
      'read_at', 'failed_at', 'failure_reason', 'attempts', 'entity_type', 'entity_id',
      'payload', 'source_event_id', 'actor_user_id', 'dedupe_key', 'group_key',
    ]) {
      await queryRunner.query(`ALTER TABLE "notifications" DROP COLUMN IF EXISTS "${col}"`);
    }
  }
}
