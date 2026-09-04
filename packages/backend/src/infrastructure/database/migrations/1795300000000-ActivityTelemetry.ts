import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The UI interaction telemetry table.
 *
 * High-volume operational analytics (page views, actions, filters), kept privacy-first — descriptors
 * not data — and purged on the UI_TELEMETRY retention class rather than sealed like the audit trail.
 * Indexed by user (for the admin timeline) and by occurred_at (for the batched retention purge).
 */
export class ActivityTelemetry1795300000000 implements MigrationInterface {
  name = 'ActivityTelemetry1795300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "activity_telemetry" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"     uuid NOT NULL,
        "session_id"  uuid,
        "event_type"  varchar(24) NOT NULL,
        "path"        varchar(300),
        "label"       varchar(160),
        "ip_address"  varchar(50),
        "metadata"    jsonb,
        "occurred_at" timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_activity_telemetry_user" ON "activity_telemetry" ("user_id");`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_activity_telemetry_occurred" ON "activity_telemetry" ("occurred_at");`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_activity_telemetry_occurred";`);
    await q.query(`DROP INDEX IF EXISTS "IDX_activity_telemetry_user";`);
    await q.query(`DROP TABLE IF EXISTS "activity_telemetry";`);
  }
}
