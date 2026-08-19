import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Remove the second, unused model of field work.
 *
 * Alongside assignments — which is how field work actually happens, and now also how money is
 * booked — the planning module carried a parallel "operations execution" model: field visits
 * with their own ten-state lifecycle, field incidents, control-centre tasks and exceptions, and
 * execution groups with negotiation conversations. Six tables, six entities, three services and
 * twelve HTTP routes.
 *
 * Nothing reached it. Neither the web app nor the mobile app called any of the twelve routes,
 * and the only server-side callers were the three services those routes themselves invoke. The
 * live path for the same job is the assignment's own check-in, field-issue and comment flow.
 * This is the "parallel platform layer" this codebase removed once before, regrown in planning.
 *
 * `assignments.execution_group_id` goes with it: the column existed only so a visit could be
 * grouped under an execution package, it is referenced by no query outside the deleted services,
 * and no assignment has ever carried a value.
 *
 * `down()` restores structure, not content — there was none to lose.
 */
export class RemoveUnusedFieldOperations1791700000000 implements MigrationInterface {
  name = 'RemoveUnusedFieldOperations1791700000000';

  public async up(q: QueryRunner): Promise<void> {
    // Children first: conversations and visits point at execution groups, incidents at visits.
    await q.query(`DROP TABLE IF EXISTS "operations_execution_conversations"`);
    await q.query(`DROP TABLE IF EXISTS "operations_field_incidents"`);
    await q.query(`DROP TABLE IF EXISTS "operations_field_visits"`);
    await q.query(`DROP TABLE IF EXISTS "operations_tasks"`);
    await q.query(`DROP TABLE IF EXISTS "operations_exceptions"`);
    // The FK from assignments has to go before the table it points at.
    await q.query(`ALTER TABLE "assignments" DROP COLUMN IF EXISTS "execution_group_id"`);
    await q.query(`DROP TABLE IF EXISTS "operations_execution_groups"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "operations_execution_groups" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_by" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_by" character varying,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "coverage_plan_id" uuid, "assayer_id" uuid, "name" character varying(200),
        "status" character varying(30) NOT NULL DEFAULT 'DRAFT',
        "logistics_preferences" jsonb,
        CONSTRAINT "PK_operations_execution_groups" PRIMARY KEY ("id"))
    `);
    await q.query(`ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "execution_group_id" uuid`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS "operations_exceptions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_by" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_by" character varying,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "project_id" uuid, "category" character varying(40), "message" text,
        "target_entity_id" uuid, "resolved_at" TIMESTAMP WITH TIME ZONE, "resolved_by" uuid,
        "justification" text,
        CONSTRAINT "PK_operations_exceptions" PRIMARY KEY ("id"))
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS "operations_tasks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_by" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_by" character varying,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "project_id" uuid, "title" character varying(300), "description" text,
        "priority" character varying(20) NOT NULL DEFAULT 'MEDIUM',
        "resolved_at" TIMESTAMP WITH TIME ZONE, "resolved_by" uuid, "justification" text,
        CONSTRAINT "PK_operations_tasks" PRIMARY KEY ("id"))
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS "operations_field_visits" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_by" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_by" character varying,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "coverage_plan_id" uuid, "execution_group_id" uuid, "branch_id" uuid, "assayer_id" uuid,
        "planned_date" date, "status" character varying(30) NOT NULL DEFAULT 'READY',
        CONSTRAINT "PK_operations_field_visits" PRIMARY KEY ("id"))
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS "operations_field_incidents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_by" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_by" character varying,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "field_visit_id" uuid, "severity" character varying(20), "message" text,
        "resolved_at" TIMESTAMP WITH TIME ZONE, "resolved_by" uuid, "justification" text,
        CONSTRAINT "PK_operations_field_incidents" PRIMARY KEY ("id"))
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS "operations_execution_conversations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_by" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_by" character varying,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "execution_group_id" uuid, "sender" character varying(20), "message" text,
        "fee_override" numeric(12,2), "date_override" date,
        CONSTRAINT "PK_operations_execution_conversations" PRIMARY KEY ("id"))
    `);
  }
}
