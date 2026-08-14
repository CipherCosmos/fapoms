import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops the table behind a parallel platform layer that nothing used.
 *
 * `PlatformFoundationModule` registered a second implementation of six things the application
 * already had — configuration, authorization, event dispatch, workflow, audit, observability,
 * queueing — under string tokens that no service ever injected. `PlatformAuditService` was the
 * one with a table behind it: `platform_audit_logs`, written by nobody, while every real audit
 * event went to `audit_events` (1,782 rows against 0).
 *
 * The danger was not the wasted code. It was that a reader looking for "how does this system
 * audit things" or "where is authorization decided" could find the wrong answer first, wire to
 * it, and produce writes nothing else reads. The whole layer is deleted; this removes the table
 * it left behind.
 *
 * **Guarded.** The drop only happens if the table is genuinely empty. If any deployment somehow
 * accumulated rows, they are left in place and a notice is raised instead — an unused table is
 * a small cost, and deleting somebody's audit history to tidy a schema is not a trade this
 * migration is entitled to make.
 */
export class RemoveParallelPlatformLayer1789700000000 implements MigrationInterface {
  name = 'RemoveParallelPlatformLayer1789700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE row_count bigint;
      BEGIN
        IF to_regclass('public.platform_audit_logs') IS NULL THEN
          RETURN;
        END IF;
        EXECUTE 'SELECT count(*) FROM platform_audit_logs' INTO row_count;
        IF row_count = 0 THEN
          DROP TABLE platform_audit_logs;
        ELSE
          RAISE NOTICE 'platform_audit_logs holds % row(s); left in place. Review and drop by hand.', row_count;
        END IF;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    /**
     * Deliberately not recreated.
     *
     * Rolling this migration back would restore an empty table that no code writes to — the
     * code that wrote to it is gone from the branch, so a re-created table would be inert.
     * Reverting the feature means reverting the code; the schema follows from it.
     */
  }
}
