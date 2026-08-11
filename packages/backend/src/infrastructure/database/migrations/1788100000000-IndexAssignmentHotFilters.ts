import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes the assignment filters that run on every hot path but had no supporting index — the table
 * previously indexed only its FK columns (project/branch/assessment/assayer/number).
 *
 *  - `status`                              — the assignments list and the dashboard status counts.
 *  - `(sla_status, status)`                — the SLA breach scanner (`WHERE sla_status = … AND status …`).
 *  - `(assayer_id, scheduled_date, status)` — the mobile "my assignments" list and the same-day
 *                                            double-booking / travel checks in `create()`.
 *
 * Partial on `is_active = true` to match how every reader filters and to keep the indexes small.
 * Validate with EXPLAIN on production data volume.
 */
export class IndexAssignmentHotFilters1788100000000 implements MigrationInterface {
  name = 'IndexAssignmentHotFilters1788100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_assignments_status_active"
         ON "assignments" ("status") WHERE "is_active" = true`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_assignments_sla_status_status_active"
         ON "assignments" ("sla_status", "status") WHERE "is_active" = true`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_assignments_assayer_date_status_active"
         ON "assignments" ("assayer_id", "scheduled_date", "status") WHERE "is_active" = true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_assignments_assayer_date_status_active"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_assignments_sla_status_status_active"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_assignments_status_active"`);
  }
}
