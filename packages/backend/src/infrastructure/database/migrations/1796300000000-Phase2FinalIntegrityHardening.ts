import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2 Final Integrity Hardening Migration:
 *
 * 1. idx_assignments_single_active_assayer_day:
 *    Conditional UNIQUE index ensuring an assayer has at most ONE active assignment per calendar day:
 *    WHERE is_active = true AND scheduled_date IS NOT NULL
 *    AND status IN ('PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS')
 *    Provides authoritative database-level protection against Race B (concurrent double-booking).
 *
 * 2. assignment_idempotency_records:
 *    Authoritative database table storing committed client request idempotency records.
 *    Captures clientRequestId (UNIQUE), command, assignmentId, actorId, requestHash, resultingEntityVersion,
 *    and serialized responsePayload.
 *
 * 3. assignment_reassignments:
 *    Alters ownership_ended_at to NULLABLE so the current active ownership has ownership_ended_at IS NULL.
 *    Adds partial unique index idx_assignment_reassignments_active_owner on (assignment_id)
 *    WHERE ownership_ended_at IS NULL AND is_active = true, enforcing at most one current owner.
 *
 * 4. assignments.current_ownership_started_at:
 *    Adds nullable timestamptz column to assignments for tracking start of current assignment ownership.
 *    Does not fabricate historical dates for legacy assignments (left NULL where unproven).
 */
export class Phase2FinalIntegrityHardening1796300000000 implements MigrationInterface {
  name = 'Phase2FinalIntegrityHardening1796300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Single active assignment per assayer per calendar day
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_assignments_single_active_assayer_day"
      ON "assignments" ("assayer_id", "scheduled_date")
      WHERE "is_active" = true AND "scheduled_date" IS NOT NULL
      AND "status" IN ('PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS')
    `);

    // 2. Authoritative Idempotency Records Table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "assignment_idempotency_records" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "client_request_id" varchar(100) NOT NULL UNIQUE,
        "assignment_id" uuid NOT NULL REFERENCES "assignments"("id") ON DELETE CASCADE,
        "command" varchar(50) NOT NULL,
        "actor_id" uuid,
        "request_hash" varchar(64) NOT NULL,
        "entity_version" integer NOT NULL,
        "response_payload" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assignment_idempotency_req_hash"
      ON "assignment_idempotency_records" ("client_request_id", "request_hash")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assignment_idempotency_assignment"
      ON "assignment_idempotency_records" ("assignment_id")
    `);

    // 3. Lineage enhancements: Make ownership_ended_at nullable for active ownership
    await queryRunner.query(`
      ALTER TABLE "assignment_reassignments"
      ALTER COLUMN "ownership_ended_at" DROP NOT NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_assignment_reassignments_active_owner"
      ON "assignment_reassignments" ("assignment_id")
      WHERE "ownership_ended_at" IS NULL AND "is_active" = true
    `);

    // 4. Add current_ownership_started_at to assignments (nullable, zero fabrication of legacy facts)
    await queryRunner.query(`
      ALTER TABLE "assignments"
      ADD COLUMN IF NOT EXISTS "current_ownership_started_at" timestamptz NULL
    `);

    // 5. Harmonize CK_assayer_payables_status check constraint to include 'VOIDED'
    await queryRunner.query(`ALTER TABLE "assayer_payables" DROP CONSTRAINT IF EXISTS "CK_assayer_payables_status"`);
    await queryRunner.query(`
      ALTER TABLE "assayer_payables"
      ADD CONSTRAINT "CK_assayer_payables_status"
      CHECK (status IN ('PENDING', 'APPROVED', 'PAID', 'VOIDED'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assignments"
      DROP COLUMN IF EXISTS "current_ownership_started_at"
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_assignment_reassignments_active_owner"
    `);

    await queryRunner.query(`
      ALTER TABLE "assignment_reassignments"
      ALTER COLUMN "ownership_ended_at" SET NOT NULL
    `);

    await queryRunner.query(`
      DROP TABLE IF EXISTS "assignment_idempotency_records"
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_assignments_single_active_assayer_day"
    `);
  }
}
