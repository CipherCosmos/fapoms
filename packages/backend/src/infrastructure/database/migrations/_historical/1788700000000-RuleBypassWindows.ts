import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The record of every window in which the platform's operational controls were suspended.
 *
 * Administrators can suspend named rules — the check-in geofence, certification requirements,
 * the conflict-of-interest distance floor — so a workflow can be tested end to end without
 * travelling to a branch or fabricating reference data. See modules/platform/rule-bypass.
 *
 * The table is append-only in practice: enabling writes a row, disabling stamps `revoked_at` on
 * it, and nothing is deleted. That history is the point. "Was the geofence being enforced on the
 * afternoon this check-in was recorded?" has to be answerable months later, from data, and the
 * only way that works is if the windows outlive the testing they were opened for.
 */
export class RuleBypassWindows1788700000000 implements MigrationInterface {
  name = 'RuleBypassWindows1788700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "rule_bypass_windows" (
        "id"              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_by"      varchar,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "updated_by"      varchar,
        "updated_at"      timestamptz NOT NULL DEFAULT now(),
        "version"         integer NOT NULL DEFAULT 1,
        "is_active"       boolean NOT NULL DEFAULT true,
        "rules"           jsonb NOT NULL,
        "reason"          text NOT NULL,
        "enabled_by"      uuid NOT NULL,
        "enabled_by_name" varchar(200),
        "starts_at"       timestamptz NOT NULL,
        "expires_at"      timestamptz NOT NULL,
        "revoked_at"      timestamptz,
        "revoked_by"      uuid,
        "usage_counts"    jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);

    /**
     * The lookup on the hot path: "is there a window running right now?", asked on check-in and
     * inside the recommendation engine's per-candidate loop. Partial, because the answer is
     * almost always "no" and the rows that could say otherwise are a vanishing fraction of the
     * table — an index over the whole history would grow forever to answer a question about the
     * present.
     */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rule_bypass_live"
        ON "rule_bypass_windows" ("expires_at" DESC)
        WHERE "revoked_at" IS NULL AND "is_active" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping this discards the evidence of when controls were suspended — the records
    // produced during those windows survive, with nothing left to explain them.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rule_bypass_live"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rule_bypass_windows"`);
  }
}
