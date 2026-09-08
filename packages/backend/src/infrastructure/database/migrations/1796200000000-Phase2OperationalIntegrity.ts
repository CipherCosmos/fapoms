import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2 Operational Integrity Migration:
 *
 * 1. idx_assignments_single_active_branch:
 *    Conditional UNIQUE index ensuring exactly one active assignment per project branch:
 *    WHERE is_active = true AND project_branch_id IS NOT NULL
 *    AND status IN ('PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS')
 *    Prevents concurrent coordinators from creating or accepting dual active assignments for the same branch.
 *
 * 2. assignment_reassignments:
 *    Explicit historical lineage structure for assignment ownership changes.
 *    Captures previous assayer, new assayer, actor, reason, timestamps, and request/correlation IDs.
 *
 * 3. Employment-date integrity:
 *    CHECK constraints on assayers ensuring exit_date and termination_date are >= joining_date.
 *    Declared NOT VALID so existing legacy rows with contradictory dates do not fail migration,
 *    while all new inserts and updates are strictly prevented from violating the invariant.
 */
export class Phase2OperationalIntegrity1796200000000 implements MigrationInterface {
  name = 'Phase2OperationalIntegrity1796200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Single active assignment per project branch
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_assignments_single_active_branch"
      ON "assignments" ("project_branch_id")
      WHERE "is_active" = true AND "project_branch_id" IS NOT NULL
      AND "status" IN ('PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS')
    `);

    // 2. Reassignment lineage table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "assignment_reassignments" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "assignment_id" uuid NOT NULL REFERENCES "assignments"("id") ON DELETE CASCADE,
        "previous_assayer_id" uuid REFERENCES "assayers"("id") ON DELETE SET NULL,
        "new_assayer_id" uuid NOT NULL REFERENCES "assayers"("id") ON DELETE RESTRICT,
        "reassigned_by" uuid NOT NULL,
        "reason" text,
        "request_id" varchar(100),
        "ownership_started_at" timestamptz NOT NULL,
        "ownership_ended_at" timestamptz NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" uuid,
        "updated_by" uuid
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assignment_reassignments_assignment_created"
      ON "assignment_reassignments" ("assignment_id", "created_at" DESC)
    `);

    // 3. Employment date constraints (NOT VALID for legacy safety)
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_assayers_employment_dates_sane'
        ) THEN
          ALTER TABLE "assayers"
          ADD CONSTRAINT "chk_assayers_employment_dates_sane"
          CHECK ("exit_date" IS NULL OR "joining_date" IS NULL OR "exit_date" >= "joining_date")
          NOT VALID;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_assayers_termination_dates_sane'
        ) THEN
          ALTER TABLE "assayers"
          ADD CONSTRAINT "chk_assayers_termination_dates_sane"
          CHECK ("termination_date" IS NULL OR "joining_date" IS NULL OR "termination_date" >= "joining_date")
          NOT VALID;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assayers" DROP CONSTRAINT IF EXISTS "chk_assayers_termination_dates_sane"`);
    await queryRunner.query(`ALTER TABLE "assayers" DROP CONSTRAINT IF EXISTS "chk_assayers_employment_dates_sane"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "assignment_reassignments"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assignments_single_active_branch"`);
  }
}
