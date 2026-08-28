import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two collisions the database was not stopping.
 *
 * Every other identifier in this system is protected by a unique constraint — `project_number`,
 * `assignment_number`, `assayer_code`, `client_code`, `contract_number`, `invoice_number`,
 * `entry_number`, `payable_number`, `username`, `email`. Branches had `branch_code` and `sol_id`
 * indexed for lookup and unique on neither, and `project_branches` had no bar on adding the same
 * branch to the same project twice.
 *
 * Neither has happened yet — 166 branches, no duplicate code, no duplicate SOL ID, no repeated
 * pair. That is what makes now the time: these can be added without a data migration, and the
 * import path that would eventually produce one is the reason they are needed. A branch sheet
 * re-uploaded with an edited row currently inserts a second branch carrying the same SOL ID, and
 * everything downstream — assignments, packets, billing lines — then points at whichever of the
 * two it happened to find.
 *
 * ## Scoped per client, not globally
 *
 * A SOL ID is a bank's own branch number. It is unique within that bank and says nothing about
 * anybody else's; two clients numbering their branches from 1 is ordinary, not a mistake. The
 * constraints are therefore on `(client_id, code)`, which is the real-world rule. Confirmed
 * against the data: no code is currently shared across clients, so nothing legitimate is refused.
 *
 * ## Partial, because blank is not a value
 *
 * A branch with no SOL ID recorded has not collided with another branch that also has none.
 * `WHERE … IS NOT NULL AND <> ''` keeps the constraint about branches that were given a number.
 */
export class BranchAndLinkUniqueness1792900000000 implements MigrationInterface {
  name = 'BranchAndLinkUniqueness1792900000000';

  public async up(q: QueryRunner): Promise<void> {
    // Refuse rather than half-apply: an index that cannot be built leaves the table exactly as it
    // was, and a migration that skipped it silently would report protection that is not there.
    const clashes: { kind: string; count: string }[] = await q.query(`
      SELECT 'branch_code' AS kind, COUNT(*)::text AS count FROM (
        SELECT 1 FROM branches WHERE branch_code IS NOT NULL AND branch_code <> ''
        GROUP BY client_id, branch_code HAVING COUNT(*) > 1) a
      UNION ALL
      SELECT 'sol_id', COUNT(*)::text FROM (
        SELECT 1 FROM branches WHERE sol_id IS NOT NULL AND sol_id <> ''
        GROUP BY client_id, sol_id HAVING COUNT(*) > 1) b
      UNION ALL
      SELECT 'project_branch', COUNT(*)::text FROM (
        SELECT 1 FROM project_branches GROUP BY project_id, branch_id HAVING COUNT(*) > 1) c
    `);
    const blocking = clashes.filter((c) => Number(c.count) > 0);
    if (blocking.length) {
      throw new Error(
        'Cannot add uniqueness: duplicates already exist — '
        + blocking.map((c) => `${c.kind} (${c.count} group(s))`).join(', ')
        + '. Merge them first; this migration will not choose which row survives.',
      );
    }

    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_branches_client_branch_code"
        ON "branches" ("client_id", "branch_code")
        WHERE "branch_code" IS NOT NULL AND "branch_code" <> ''
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_branches_client_sol_id"
        ON "branches" ("client_id", "sol_id")
        WHERE "sol_id" IS NOT NULL AND "sol_id" <> ''
    `);

    /**
     * One link per branch per project.
     *
     * Not filtered on `is_active`: a soft-deleted link still holds the pair, and allowing a second
     * live one beside it is how a branch ends up scheduled twice on the same project with two
     * different states. Re-adding a removed branch reactivates the row it already has.
     */
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_project_branches_pair"
        ON "project_branches" ("project_id", "branch_id")
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "UQ_project_branches_pair"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_branches_client_sol_id"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_branches_client_branch_code"`);
  }
}
