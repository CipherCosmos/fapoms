import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Operator control over what the platform says and to whom.
 *
 * `NOTIFICATION_CATALOG` in code remains the default for all ~48 event types — reviewable in
 * a diff, which is where decisions about who gets told what belong. This table holds only the
 * deliberate departures from it: an event switched off, re-routed to different channels or
 * roles, or re-worded. Every column but `type` is nullable and null means "use the default",
 * so a later release's catalog improvements still reach every type nobody has customised, and
 * "reset to default" is a DELETE rather than a guess at the original wording.
 *
 * Deliberately empty on install: the shipped configuration is the one in code, and a table
 * pre-filled with copies of it would freeze today's defaults into every environment forever.
 */
export class NotificationSettings1789400000000 implements MigrationInterface {
  name = 'NotificationSettings1789400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_settings" (
        "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_by"               character varying,
        "created_at"               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by"               character varying,
        "updated_at"               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version"                  integer NOT NULL DEFAULT 1,
        "is_active"                boolean NOT NULL DEFAULT true,
        "type"                     character varying(64) NOT NULL,
        "enabled"                  boolean NOT NULL DEFAULT true,
        "channels"                 jsonb,
        "priority"                 character varying(16),
        "roles"                    jsonb,
        "title_template"           text,
        "body_template"            text,
        "link_template"            character varying(255),
        "email_subject_template"   text,
        "email_body_template"      text,
        "collapse_window_seconds"  integer,
        "notes"                    text
      )
    `);

    // One override per type — the resolver reads them into a map keyed by type, and a second
    // row would silently win or lose by insertion order. Declared on the entity too:
    // synchronize rebuilds tables from the entity and drops migration-only indexes.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_notification_settings_type"
      ON "notification_settings" ("type")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_settings"`);
  }
}
