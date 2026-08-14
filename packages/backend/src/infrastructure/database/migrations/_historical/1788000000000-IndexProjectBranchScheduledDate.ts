import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes project_branches.scheduled_date for the date-range scans that filter on it — the operations
 * dashboard's "due this week" query, the document auto-dispatch worker, and the scheduling views all do
 * `WHERE is_active = true AND scheduled_date BETWEEN … `. There was an index on status/project_id/
 * branch_id but none on scheduled_date, so those range filters fell back to a sequential scan of the
 * whole table.
 *
 * Partial + covering the exact predicate shape (active rows with a date), so it stays small and is used
 * for both the range filter and the IS NOT NULL check. Validate the plan with EXPLAIN on production data.
 */
export class IndexProjectBranchScheduledDate1788000000000 implements MigrationInterface {
  name = 'IndexProjectBranchScheduledDate1788000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_project_branches_scheduled_date_active"
         ON "project_branches" ("scheduled_date")
       WHERE "is_active" = true AND "scheduled_date" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_project_branches_scheduled_date_active"`);
  }
}
