import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enrich `audit_events` for banking / DPDP compliance.
 *
 * The trail recorded who (user id + name), what (event + coarse previous/new state), where
 * (ip_address, populated on only a few paths) and when. A trail that has to serve as forensic
 * evidence and support non-repudiation (RBI IT-Governance MD 2023) and DPDP access logging needs
 * more: the actor's ROLE at the time, the USER-AGENT of their client, the SESSION the action
 * belonged to, the REQUEST id that ties it to the logs, the OUTCOME (so refused/failed actions are
 * auditable, not only successes), and a structured field-level BEFORE/AFTER for edits.
 *
 * Adding columns is DDL, not a row UPDATE, so the `audit_events_immutable` trigger (which fires
 * only BEFORE UPDATE OR DELETE on rows) does not block this. Every column is nullable: existing
 * rows keep NULLs, and from here forward the ambient request context populates them. `outcome` is
 * left nullable rather than defaulted so historical rows are honestly "unknown" rather than
 * retroactively asserted to have succeeded; new rows always carry a value from the domain object.
 */
export class AuditEventsComplianceColumns1795000000000 implements MigrationInterface {
  name = 'AuditEventsComplianceColumns1795000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "audit_events"
        ADD COLUMN IF NOT EXISTS "actor_role" varchar(100),
        ADD COLUMN IF NOT EXISTS "user_agent" text,
        ADD COLUMN IF NOT EXISTS "session_id" varchar(64),
        ADD COLUMN IF NOT EXISTS "request_id" varchar(100),
        ADD COLUMN IF NOT EXISTS "outcome" varchar(20),
        ADD COLUMN IF NOT EXISTS "before" jsonb,
        ADD COLUMN IF NOT EXISTS "after" jsonb;
    `);

    // "Everything that happened in this session" is the per-session history the ask centres on.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_audit_events_session_id"
        ON "audit_events" ("session_id");
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_audit_events_session_id";`);
    await q.query(`
      ALTER TABLE "audit_events"
        DROP COLUMN IF EXISTS "actor_role",
        DROP COLUMN IF EXISTS "user_agent",
        DROP COLUMN IF EXISTS "session_id",
        DROP COLUMN IF EXISTS "request_id",
        DROP COLUMN IF EXISTS "outcome",
        DROP COLUMN IF EXISTS "before",
        DROP COLUMN IF EXISTS "after";
    `);
  }
}
