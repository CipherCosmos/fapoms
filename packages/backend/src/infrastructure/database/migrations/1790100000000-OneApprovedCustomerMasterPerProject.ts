import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A project may have exactly one approved customer master at a time.
 *
 * `approveVersion` supersedes the previously approved version and then approves the new one,
 * both inside a transaction — which is correct against a single caller and not enough against
 * two. Under READ COMMITTED, two approvals of different versions of the same project each see
 * the other's row as still un-superseded, each supersede "all APPROVED" (finding nothing new),
 * and both commit. The project ends with two approved versions.
 *
 * Nothing in the code catches it afterwards. The one consumer — the assignment service, building
 * an assayer's customer list — happens to order by `versionNumber DESC` and take the first, so it
 * would keep working on the newer version and an audit would not be run against stale customer
 * data. But the older row stays APPROVED for good: the status column now says something untrue,
 * "which version is approved" has two answers, and the version list shows two approved rows with
 * nothing to say which is real.
 *
 * A partial unique index makes the invariant hold in the database rather than depending on every
 * future reader remembering to sort. The second transaction to commit fails instead of silently
 * creating the ambiguity — the right outcome, because approving two versions at once is a
 * genuine conflict a person should resolve, not something to paper over.
 *
 * `is_active` is part of the predicate because soft-deleted versions keep their status, and a
 * deleted approved version must not block approving a live one.
 */
export class OneApprovedCustomerMasterPerProject1790100000000 implements MigrationInterface {
  name = 'OneApprovedCustomerMasterPerProject1790100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Any database that already holds a duplicate would fail the index creation, so demote the
    // older rows first: the newest version number is the one every reader was already using.
    await queryRunner.query(`
      UPDATE customer_master_versions v
         SET status = 'SUPERSEDED'
       WHERE v.status = 'APPROVED'
         AND v.is_active = true
         AND EXISTS (
           SELECT 1 FROM customer_master_versions newer
            WHERE newer.project_id = v.project_id
              AND newer.status = 'APPROVED'
              AND newer.is_active = true
              AND newer.version_number > v.version_number
         )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_customer_master_approved_per_project"
        ON customer_master_versions (project_id)
        WHERE status = 'APPROVED' AND is_active = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_customer_master_approved_per_project"`);
  }
}
