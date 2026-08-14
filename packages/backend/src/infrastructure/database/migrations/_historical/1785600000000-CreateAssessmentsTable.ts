import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `assessments` table and the `call_logs` table, neither of
 * which was ever created by any prior migration despite both being real,
 * live tables (per AssessmentEntity in
 * packages/backend/src/modules/project/assessment.entity.ts and
 * CallLogEntity in packages/backend/src/modules/project/call-log.entity.ts).
 *
 * Also adds the `assessment_id` FK column to `assignments`, `documents`,
 * and `validation_cases` — none of whose original CREATE TABLE migrations
 * (1784653336579-InitialMigration.ts for assignments;
 * 1784653659604-AddDocumentsAndValidation.ts for documents and
 * validation_cases) defined this column, even though the entities have
 * declared it for a while and it is referenced live.
 *
 * All object names below (table/enum/index/constraint names) were taken
 * verbatim from the live `fapoms-postgres` schema (verified 2026-07-30) so
 * that, if ever applied to a genuinely fresh database, the result is
 * byte-for-byte identical (including constraint names) to what's already
 * running. Every statement is written defensively (IF NOT EXISTS / guarded
 * DO blocks that check pg_constraint by name) so this migration is also
 * safe to run against a database — like the current live one — that
 * already has some or all of these objects; in that case it is a no-op.
 *
 * NOTE: This migration is NOT executed as part of this change. It is the
 * highest-risk item in this batch (new table + new FK columns on
 * business-critical, actively-written tables) and must be reviewed by a
 * human — and ideally dry-run against a copy of the live DB — before it is
 * ever applied anywhere.
 */
export class CreateAssessmentsTable1785600000000 implements MigrationInterface {
  name = 'CreateAssessmentsTable1785600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- 1. Enum types for assessments ------------------------------------
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."assessments_status_enum" AS ENUM(
          'PENDING_PLANNING', 'ASSESSOR_RECOMMENDED', 'IN_NEGOTIATION', 'ASSIGNED_AND_SCHEDULED',
          'UNASSIGNED', 'AWAITING_CLIENT_DATA', 'CLIENT_DATA_RECEIVED', 'PDF_GENERATED',
          'READY_FOR_DISPATCH', 'DISPATCHED_TO_ASSESSOR', 'AUDITED_PDF_RECEIVED', 'SENT_TO_DATA_ENTRY',
          'DATA_ENTRY_IN_PROGRESS', 'CLARIFICATION_NEEDED', 'REPORT_FINALIZED', 'PENDING_HEAD_APPROVAL',
          'DELIVERED_TO_CLIENT', 'COMPLETED'
        );
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."assessments_priority_enum" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);

    // ---- 2. "assessments" table --------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "assessments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_by" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by" character varying,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version" integer NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "project_id" uuid NOT NULL,
        "branch_id" uuid NOT NULL,
        "status" "public"."assessments_status_enum" NOT NULL DEFAULT 'PENDING_PLANNING',
        "packet_size" integer,
        "assigned_assessor_id" uuid,
        "audit_date" date,
        "agreed_fee" numeric(12,2),
        "coverage_flag" boolean NOT NULL DEFAULT false,
        "priority" "public"."assessments_priority_enum" NOT NULL DEFAULT 'MEDIUM',
        "zone_id" uuid,
        "remarks" text,
        CONSTRAINT "PK_a3442bd80a00e9111cefca57f6c" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_18904497714587c1df720c5a8e" ON "assessments" ("status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_54d31f8e2afb3703d668b6aa6c" ON "assessments" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_6577096b5a1206636f32c5dfb8" ON "assessments" ("branch_id")`);

    await this.addForeignKeyIfMissing(
      queryRunner,
      'assessments',
      'project_id',
      `ALTER TABLE "assessments" ADD CONSTRAINT "FK_54d31f8e2afb3703d668b6aa6c4" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await this.addForeignKeyIfMissing(
      queryRunner,
      'assessments',
      'branch_id',
      `ALTER TABLE "assessments" ADD CONSTRAINT "FK_6577096b5a1206636f32c5dfb81" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // ---- 3. "call_logs" table (also missing from every prior migration) ---
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "call_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_by" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by" character varying,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version" integer NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "assessment_id" uuid NOT NULL,
        "assessor_id" uuid NOT NULL,
        "called_by" uuid NOT NULL,
        "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "outcome" character varying(50) NOT NULL,
        "negotiated_fee" numeric(12,2),
        "notes" text,
        CONSTRAINT "PK_aa08476bcc13bfdf394261761e9" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_557615b6faa9a5062da37b6433" ON "call_logs" ("assessment_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_5e53679ddba47fd76f462f7a0b" ON "call_logs" ("assessor_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_640446f3b62db5ddf89cb7bfdf" ON "call_logs" ("called_by")`);

    await this.addForeignKeyIfMissing(
      queryRunner,
      'call_logs',
      'assessment_id',
      `ALTER TABLE "call_logs" ADD CONSTRAINT "FK_557615b6faa9a5062da37b6433e" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await this.addForeignKeyIfMissing(
      queryRunner,
      'call_logs',
      'assessor_id',
      `ALTER TABLE "call_logs" ADD CONSTRAINT "FK_5e53679ddba47fd76f462f7a0b1" FOREIGN KEY ("assessor_id") REFERENCES "assayers"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await this.addForeignKeyIfMissing(
      queryRunner,
      'call_logs',
      'called_by',
      `ALTER TABLE "call_logs" ADD CONSTRAINT "FK_640446f3b62db5ddf89cb7bfdf5" FOREIGN KEY ("called_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    // ---- 4. "assessment_id" FK column on the 4 dependent tables ------------
    // assignments
    await queryRunner.query(`ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "assessment_id" uuid`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_60e677583d6072e2f924fb4a11" ON "assignments" ("assessment_id")`);
    await this.addForeignKeyIfMissing(
      queryRunner,
      'assignments',
      'assessment_id',
      `ALTER TABLE "assignments" ADD CONSTRAINT "FK_60e677583d6072e2f924fb4a119" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // documents
    await queryRunner.query(`ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "assessment_id" uuid`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_15ddaded9b846811dfdd45b618" ON "documents" ("assessment_id")`);
    await this.addForeignKeyIfMissing(
      queryRunner,
      'documents',
      'assessment_id',
      `ALTER TABLE "documents" ADD CONSTRAINT "FK_15ddaded9b846811dfdd45b618d" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // validation_cases (SET NULL on delete, per ValidationCaseEntity)
    await queryRunner.query(`ALTER TABLE "validation_cases" ADD COLUMN IF NOT EXISTS "assessment_id" uuid`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_d034b39e07d216d3d428796882" ON "validation_cases" ("assessment_id")`);
    await this.addForeignKeyIfMissing(
      queryRunner,
      'validation_cases',
      'assessment_id',
      `ALTER TABLE "validation_cases" ADD CONSTRAINT "FK_d034b39e07d216d3d4287968822" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "validation_cases" DROP CONSTRAINT IF EXISTS "FK_d034b39e07d216d3d4287968822"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_d034b39e07d216d3d428796882"`);
    await queryRunner.query(`ALTER TABLE "validation_cases" DROP COLUMN IF EXISTS "assessment_id"`);

    await queryRunner.query(`ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "FK_15ddaded9b846811dfdd45b618d"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_15ddaded9b846811dfdd45b618"`);
    await queryRunner.query(`ALTER TABLE "documents" DROP COLUMN IF EXISTS "assessment_id"`);

    await queryRunner.query(`ALTER TABLE "assignments" DROP CONSTRAINT IF EXISTS "FK_60e677583d6072e2f924fb4a119"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_60e677583d6072e2f924fb4a11"`);
    await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN IF EXISTS "assessment_id"`);

    await queryRunner.query(`DROP TABLE IF EXISTS "call_logs"`);

    await queryRunner.query(`DROP TABLE IF EXISTS "assessments"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."assessments_priority_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."assessments_status_enum"`);
  }

  /**
   * Adds a FK constraint only if no foreign key already exists on
   * (table, column) — regardless of its name. This guards against creating
   * a duplicate, differently-named FK if this migration is ever run against
   * a database (like the current live one) where the equivalent constraint
   * already exists under TypeORM's auto-generated name.
   */
  private async addForeignKeyIfMissing(
    queryRunner: QueryRunner,
    table: string,
    column: string,
    addConstraintSql: string,
  ): Promise<void> {
    const existing = await queryRunner.query(
      `
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name = $1
          AND kcu.column_name = $2
      `,
      [table, column],
    );
    if (!existing || existing.length === 0) {
      await queryRunner.query(addConstraintSql);
    }
  }
}
