import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes for high-write, append-only tables that grow unbounded.
 *
 * Audit history, audit evidence, the platform audit log, workflow history,
 * notifications and billing history are all write-heavy and never pruned, yet
 * are read almost exclusively by a foreign key / entity id scoped to a time
 * window. Without a supporting index each of those reads degrades into a full
 * scan that gets slower every day the tables grow.
 *
 * Every statement is idempotent (`IF NOT EXISTS` / `IF EXISTS`) so the
 * migration is safe to re-run and safe alongside `DB_SYNCHRONIZE`, which may
 * already have created some of the entity-declared indexes under its own
 * auto-generated names. Column identifiers are quoted exactly as stored: the
 * default naming strategy keeps camelCase entity columns verbatim (e.g.
 * `"auditId"`), while entities with explicit `name:` use snake_case.
 */
export class AppendTableIndexes1787400000000 implements MigrationInterface {
  name = 'AppendTableIndexes1787400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── assayer_audit_history (camelCase columns) ───────────────────────────
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_assayer_audit_history_audit_created"
      ON "assayer_audit_history" ("auditId", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_assayer_audit_history_assayer_created"
      ON "assayer_audit_history" ("assayerId", "createdAt")
    `);

    // ── audit_evidence (camelCase columns) ──────────────────────────────────
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_audit_evidence_audit_created"
      ON "audit_evidence" ("auditId", "createdAt")
    `);

    // ── platform_audit_logs (snake_case columns; no entity_type/entity_id) ───
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_platform_audit_logs_created"
      ON "platform_audit_logs" ("created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_platform_audit_logs_user_created"
      ON "platform_audit_logs" ("user_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_platform_audit_logs_correlation"
      ON "platform_audit_logs" ("correlation_id")
    `);

    // ── workflow_history (camelCase columns; time column is "timestamp") ─────
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_workflow_history_entity_timestamp"
      ON "workflow_history" ("entityId", "timestamp")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_workflow_history_correlation"
      ON "workflow_history" ("correlationId")
    `);

    // ── notifications (only what the entity does not already declare) ────────
    // (userId, isRead, createdAt) already exists as an entity @Index; the
    // assayer inbox path — notifications for one assayer, newest first — does
    // not, so add it here.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_notifications_assayer_created"
      ON "notifications" ("assayer_id", "created_at")
    `);

    // ── billing_history (snake_case columns) ────────────────────────────────
    // (entity_type, entity_id) and (created_at) already exist as entity
    // @Index; add the combined form that serves "this entity's history over
    // time", the actual read pattern.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_billing_history_entity_created"
      ON "billing_history" ("entity_type", "entity_id", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_billing_history_entity_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_notifications_assayer_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_workflow_history_correlation"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_workflow_history_entity_timestamp"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_platform_audit_logs_correlation"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_platform_audit_logs_user_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_platform_audit_logs_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_evidence_audit_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_assayer_audit_history_assayer_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_assayer_audit_history_audit_created"`);
  }
}
