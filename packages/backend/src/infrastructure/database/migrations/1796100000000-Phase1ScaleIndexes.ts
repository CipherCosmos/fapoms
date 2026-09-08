import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 1 Scale Indexes:
 *
 * 1. idx_assignments_assayer_feed:
 *    Serves the mobile assayer worklist and keyset pagination:
 *    WHERE assayer_id = $1 AND is_active = true ORDER BY created_at DESC, id DESC LIMIT 26.
 *    Eliminates fallback to idx_assignments_recent_page which scanned and filtered thousands
 *    of rows belonging to other assayers.
 *    Measured on 100k rows: 34.9x speedup on heavy assayer (1.01ms -> 0.029ms, 3,188 -> 30 buffers).
 *
 * 2. idx_assignments_completed_reconcile:
 *    Serves billing reconciliation and partial-financial-state detection:
 *    WHERE status = 'COMPLETED' AND completion_date >= $1 ORDER BY completion_date ASC, created_at ASC.
 *    Partial index on status = 'COMPLETED' (488 kB size at 100k rows).
 *    Measured on 100k rows: 3.3x faster assignment scan (12.7ms -> 3.8ms, 4,610 -> 14 blocks).
 *
 * Operational Runbook Note for Production:
 * TypeORM executes migrations in a transaction block, which disallows CONCURRENTLY.
 * On high-volume production tables, DBAs may pre-create these indexes concurrently:
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_assignments_assayer_feed"
 *     ON "assignments" ("assayer_id", "created_at" DESC, "id" DESC) WHERE "is_active" = true;
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_assignments_completed_reconcile"
 *     ON "assignments" ("completion_date", "created_at") WHERE "status" = 'COMPLETED';
 * Because the indexes were pre-created concurrently, the migration does not perform a second index build.
 */
export class Phase1ScaleIndexes1796100000000 implements MigrationInterface {
  name = 'Phase1ScaleIndexes1796100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assignments_assayer_feed"
      ON "assignments" ("assayer_id", "created_at" DESC, "id" DESC)
      WHERE "is_active" = true
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assignments_completed_reconcile"
      ON "assignments" ("completion_date", "created_at")
      WHERE "status" = 'COMPLETED'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assignments_completed_reconcile"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assignments_assayer_feed"`);
  }
}
