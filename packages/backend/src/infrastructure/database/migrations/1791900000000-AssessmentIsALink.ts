import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The assessment stops keeping a lifecycle nobody read.
 *
 * `assessments` exists so a document has something to hang off for one project and one branch.
 * On top of that it carried an eighteen-state `status` column, plus `audit_date`,
 * `assigned_assessor_id`, `agreed_fee`, `packet_size`, `coverage_flag`, `priority`, `zone_id`
 * and `remarks`.
 *
 * Every one of them was write-only. Nothing compared them, no query filtered on them, no API
 * returned them and no screen showed them — `assessmentStatusLabel` existed, was re-exported by
 * the web app, and was never called. The only reads of `status` anywhere were the guards
 * deciding whether to write it again.
 *
 * Keeping it cost real code: a document→assessment status map with its own forward-only
 * ordering, a branch→assessment status map, and writes from the document service, the
 * assignment service, the validation service and two controllers — four places translating
 * between three vocabularies for the same pipeline. The facts they were copying live where they
 * are actually read: the audit date and the packet count on `project_branches`, the assayer and
 * the agreed fee on `assignments`, and the paperwork's position on `documents.status`.
 *
 * `down()` restores the columns and the enum type. It cannot restore their values, and nothing
 * ever depended on them.
 */
export class AssessmentIsALink1791900000000 implements MigrationInterface {
  name = 'AssessmentIsALink1791900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_18904497714587c1df720c5a8e"`);
    for (const col of [
      'status', 'packet_size', 'assigned_assessor_id', 'audit_date',
      'agreed_fee', 'coverage_flag', 'priority', 'zone_id', 'remarks',
    ]) {
      await q.query(`ALTER TABLE "assessments" DROP COLUMN IF EXISTS "${col}"`);
    }
    // The enum types go with the columns that were their only users. `assessments_priority_enum`
    // is dropped guardedly: `Priority` is shared, but this type is its own Postgres object.
    await q.query(`DROP TYPE IF EXISTS "public"."assessments_status_enum"`);
    await q.query(`DROP TYPE IF EXISTS "public"."assessments_priority_enum"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."assessments_status_enum" AS ENUM(
          'PENDING_PLANNING', 'ASSESSOR_RECOMMENDED', 'IN_NEGOTIATION', 'ASSIGNED_AND_SCHEDULED',
          'UNASSIGNED', 'AWAITING_CLIENT_DATA', 'CLIENT_DATA_RECEIVED', 'PDF_GENERATED',
          'READY_FOR_DISPATCH', 'DISPATCHED_TO_ASSESSOR', 'AUDITED_PDF_RECEIVED',
          'SENT_TO_DATA_ENTRY', 'DATA_ENTRY_IN_PROGRESS', 'CLARIFICATION_NEEDED',
          'REPORT_FINALIZED', 'PENDING_HEAD_APPROVAL', 'DELIVERED_TO_CLIENT', 'COMPLETED');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."assessments_priority_enum" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'URGENT');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await q.query(`ALTER TABLE "assessments" ADD COLUMN IF NOT EXISTS "status" "public"."assessments_status_enum" NOT NULL DEFAULT 'PENDING_PLANNING'`);
    await q.query(`ALTER TABLE "assessments" ADD COLUMN IF NOT EXISTS "packet_size" integer`);
    await q.query(`ALTER TABLE "assessments" ADD COLUMN IF NOT EXISTS "assigned_assessor_id" uuid`);
    await q.query(`ALTER TABLE "assessments" ADD COLUMN IF NOT EXISTS "audit_date" date`);
    await q.query(`ALTER TABLE "assessments" ADD COLUMN IF NOT EXISTS "agreed_fee" numeric(12,2)`);
    await q.query(`ALTER TABLE "assessments" ADD COLUMN IF NOT EXISTS "coverage_flag" boolean NOT NULL DEFAULT false`);
    await q.query(`ALTER TABLE "assessments" ADD COLUMN IF NOT EXISTS "priority" "public"."assessments_priority_enum" NOT NULL DEFAULT 'MEDIUM'`);
    await q.query(`ALTER TABLE "assessments" ADD COLUMN IF NOT EXISTS "zone_id" uuid`);
    await q.query(`ALTER TABLE "assessments" ADD COLUMN IF NOT EXISTS "remarks" text`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_18904497714587c1df720c5a8e" ON "assessments" ("status")`);
  }
}
