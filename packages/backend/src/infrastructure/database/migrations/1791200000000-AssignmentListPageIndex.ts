import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The index the assignments list pages on.
 *
 * ## Why the existing one does not serve it
 *
 * `idx_assignments_active_status_created (is_active, status, created_at DESC)` looks like it
 * should. It cannot: `status` sits between the two columns the page actually orders by, so the
 * moment a request does *not* filter by status — which is the default view of the list, the most
 * opened screen in the product — the index can no longer produce rows in `created_at` order and
 * the planner falls back to sorting the table.
 *
 * ## Measured on the 200k book (2026-08-17)
 *
 * The statement is the one `findAssignmentsPage` issues for the page's ids:
 * `SELECT id FROM assignments WHERE is_active = true ORDER BY created_at DESC, id ASC LIMIT 25
 * OFFSET …`
 *
 *   | offset | before                                   | after                          |
 *   |--------|------------------------------------------|--------------------------------|
 *   |    150 | 33.4 ms, 4,971 buffers, parallel Gather Merge | 0.5 ms, **4 buffers**, Index Only Scan |
 *   |  5,000 | —                                        | 2.2 ms                         |
 *
 * `Heap Fetches: 0` — the id rides in the index, so the page of ids never touches the table at
 * all. That is the whole point of including `id` rather than indexing `created_at` alone.
 *
 * ## Why partial, and why `id` in the key
 *
 * `WHERE is_active = true` matches how every list query filters and keeps the index proportional
 * to live rows rather than to everything ever created — the same reasoning as the retention work,
 * from the other direction.
 *
 * `id` is the second key column because the list orders by `created_at DESC, id ASC`. The
 * tiebreak is not cosmetic: without a total order, two rows sharing a timestamp may be returned in
 * either order, so which of them lands on page 2 versus page 3 is not stable. Real data makes
 * that rare — the development database has 20 distinct timestamps for 20 rows — but the 200k
 * fixture generates 520 rows per timestamp, and a synthetic import or a bulk status change would
 * do the same in production. Ordering total, and indexing the total order, removes the question.
 */
export class AssignmentListPageIndex1791200000000 implements MigrationInterface {
  name = 'AssignmentListPageIndex1791200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Cannot be CONCURRENTLY here — TypeORM wraps each migration in a transaction and Postgres
    // forbids it there. On a database where `assignments` has already grown, build it by hand
    // first and let this no-op:
    //   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_assignments_recent_page"
    //     ON "assignments" ("created_at" DESC, "id") WHERE "is_active" = true;
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assignments_recent_page"
      ON "assignments" ("created_at" DESC, "id")
      WHERE "is_active" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assignments_recent_page"`);
  }
}
