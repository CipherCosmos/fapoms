import { MigrationInterface, QueryRunner } from 'typeorm';
import { ReconcileRolePermissions1792000000000 } from './1792000000000-ReconcileRolePermissions';

/**
 * THE APPROVAL BEFORE TRAINING (owner, 2026-09-23).
 *
 * A stage between background verification and training — FINAL_APPROVAL — where a senior holding
 * the new ASSAYER:APPROVE:ORGANIZATION permission (Admin by default; grantable to any custom role)
 * approves, rejects with a reason, or asks HR for more. `assayer_onboarding_approvals` keeps one
 * row per round, with its conversation, so every decision and every question is on file.
 *
 * `ADD VALUE` inside the migration transaction is allowed on Postgres 12+ provided nothing in the
 * same transaction uses the value — nothing here does.
 */
export class FinalApproval1800400000000 implements MigrationInterface {
  name = 'FinalApproval1800400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."assayers_lifecycle_status_enum" ADD VALUE IF NOT EXISTS 'FINAL_APPROVAL' AFTER 'BACKGROUND_VERIFICATION'`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "assayer_onboarding_approvals" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_by" varchar,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_by" varchar,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "version" integer NOT NULL DEFAULT 1,
        "is_active" boolean NOT NULL DEFAULT true,
        "assayer_id" uuid NOT NULL,
        "round" integer NOT NULL,
        "status" varchar(20) NOT NULL,
        "events" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "submitted_by" uuid,
        "decided_by" uuid,
        "decided_at" timestamptz,
        CONSTRAINT "PK_assayer_onboarding_approvals" PRIMARY KEY ("id"),
        CONSTRAINT "FK_assayer_onboarding_approvals_assayer" FOREIGN KEY ("assayer_id") REFERENCES "assayers"("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_assayer_onboarding_approvals_round" UNIQUE ("assayer_id", "round"),
        CONSTRAINT "CHK_assayer_onboarding_approvals_status"
          CHECK ("status" IN ('PENDING', 'INFO_REQUESTED', 'APPROVED', 'REJECTED'))
      )
    `);
    // The approver's queue: open rounds.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assayer_onboarding_approvals_open"
        ON "assayer_onboarding_approvals" ("status") WHERE "status" IN ('PENDING', 'INFO_REQUESTED')
    `);
    // At most one open round per person: a second would be two conversations about one decision.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_assayer_onboarding_approvals_one_open"
        ON "assayer_onboarding_approvals" ("assayer_id") WHERE "status" IN ('PENDING', 'INFO_REQUESTED')
    `);
    /*
      The status projection check listed the nine stages that project to INACTIVE by name, so the
      first person moved into FINAL_APPROVAL would have been refused by the database. Restated as
      the rule `operationalStatusFor` actually applies — everything but ACTIVE and SUSPENDED is
      INACTIVE — so the next stage added cannot trip it the same way. (A rule kept as a list of the
      instances that existed that day goes stale; this one did.)
    */
    await queryRunner.query(`ALTER TABLE "assayers" DROP CONSTRAINT IF EXISTS "chk_assayers_lifecycle_status_projection"`);
    await queryRunner.query(`
      ALTER TABLE "assayers"
      ADD CONSTRAINT "chk_assayers_lifecycle_status_projection"
      CHECK (
        (lifecycle_status::text = 'ACTIVE' AND status::text = 'ACTIVE') OR
        (lifecycle_status::text = 'SUSPENDED' AND status::text = 'SUSPENDED') OR
        (lifecycle_status::text NOT IN ('ACTIVE', 'SUSPENDED') AND status::text = 'INACTIVE')
      )
    `);
    // The new permission, and Admin's grant of it — whatever ROLE_PERMISSIONS says at deploy time.
    await new ReconcileRolePermissions1792000000000().up(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "assayer_onboarding_approvals"`);
    // An enum value cannot be dropped in Postgres; FINAL_APPROVAL stays, unused.
  }
}
