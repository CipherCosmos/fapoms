import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Brings `assignments_status_enum` to the vocabulary the application actually uses.
 *
 * The initial migration created ten values — CREATED, CANDIDATE_SELECTED, CONTACT_INITIATED,
 * NEGOTIATION, ACCEPTED, SCHEDULED, AUDIT_COMPLETED, CLOSED, REJECTED, CANCELLED — and **no
 * migration ever changed them**. Meanwhile `AssignmentStatus` in @fapoms/shared became the seven
 * the code reads today: PENDING, ACCEPTED, CHECKED_IN, IN_PROGRESS, COMPLETED, REJECTED,
 * CANCELLED. The running database has the seven because `synchronize` rewrote the type in place.
 *
 * The consequence is worse than "migrations were never run": the migration chain **cannot
 * produce the current schema**. A deploy built the way production must be built — migrations from
 * empty — would come up with an enum that rejects every status the application writes, and
 * `ReconcileAssignmentStatusDrift` (1785700000000) aborted the run outright trying to write
 * 'COMPLETED' into a type that had no such value. This migration is the step that was missing.
 *
 * Old values are mapped rather than dropped, so a database that still holds legacy rows keeps its
 * history and reads correctly afterwards:
 *
 *   CREATED, CANDIDATE_SELECTED, CONTACT_INITIATED, NEGOTIATION -> PENDING   (offer not yet taken)
 *   SCHEDULED                                                   -> ACCEPTED  (taken, not started)
 *   AUDIT_COMPLETED, CLOSED                                     -> COMPLETED (work finished)
 *
 * Idempotent: a database `synchronize` already converted has the target type and is left alone.
 */
export class ConvertAssignmentStatusEnumToCurrentVocabulary1785650000000 implements MigrationInterface {
  name = 'ConvertAssignmentStatusEnumToCurrentVocabulary1785650000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [{ needs_conversion }] = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'assignments_status_enum' AND e.enumlabel = 'CREATED'
      ) AS needs_conversion
    `);
    if (!needs_conversion) return;

    // Via text: a Postgres enum cannot be rewritten in place, and the column has to stop being
    // typed by it before the type can be replaced.
    await queryRunner.query(`ALTER TABLE "assignments" ALTER COLUMN "status" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "assignments" ALTER COLUMN "status" TYPE text USING "status"::text`);

    await queryRunner.query(`
      UPDATE "assignments" SET "status" = CASE "status"
        WHEN 'CREATED'             THEN 'PENDING'
        WHEN 'CANDIDATE_SELECTED'  THEN 'PENDING'
        WHEN 'CONTACT_INITIATED'   THEN 'PENDING'
        WHEN 'NEGOTIATION'         THEN 'PENDING'
        WHEN 'SCHEDULED'           THEN 'ACCEPTED'
        WHEN 'AUDIT_COMPLETED'     THEN 'COMPLETED'
        WHEN 'CLOSED'              THEN 'COMPLETED'
        ELSE "status"
      END
    `);

    await queryRunner.query(`DROP TYPE "public"."assignments_status_enum"`);
    await queryRunner.query(`
      CREATE TYPE "public"."assignments_status_enum" AS ENUM
        ('PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'CANCELLED')
    `);
    await queryRunner.query(`
      ALTER TABLE "assignments"
        ALTER COLUMN "status" TYPE "public"."assignments_status_enum"
        USING "status"::"public"."assignments_status_enum"
    `);
    await queryRunner.query(`ALTER TABLE "assignments" ALTER COLUMN "status" SET DEFAULT 'PENDING'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Deliberately not reversible in data terms. Four legacy values collapse into PENDING and two
    // into COMPLETED, so the original distinctions no longer exist to restore — inventing one
    // back would be worse than refusing. The type is restored; the rows keep their current
    // meaning, which is the only meaning still true.
    await queryRunner.query(`ALTER TABLE "assignments" ALTER COLUMN "status" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "assignments" ALTER COLUMN "status" TYPE text USING "status"::text`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."assignments_status_enum"`);
    await queryRunner.query(`
      CREATE TYPE "public"."assignments_status_enum" AS ENUM
        ('CREATED', 'CANDIDATE_SELECTED', 'CONTACT_INITIATED', 'NEGOTIATION', 'ACCEPTED',
         'SCHEDULED', 'AUDIT_COMPLETED', 'CLOSED', 'REJECTED', 'CANCELLED')
    `);
    await queryRunner.query(`
      UPDATE "assignments" SET "status" = CASE "status"
        WHEN 'PENDING'     THEN 'CREATED'
        WHEN 'CHECKED_IN'  THEN 'SCHEDULED'
        WHEN 'IN_PROGRESS' THEN 'SCHEDULED'
        WHEN 'COMPLETED'   THEN 'AUDIT_COMPLETED'
        ELSE "status"
      END
    `);
    await queryRunner.query(`
      ALTER TABLE "assignments"
        ALTER COLUMN "status" TYPE "public"."assignments_status_enum"
        USING "status"::"public"."assignments_status_enum"
    `);
    await queryRunner.query(`ALTER TABLE "assignments" ALTER COLUMN "status" SET DEFAULT 'CREATED'`);
  }
}
