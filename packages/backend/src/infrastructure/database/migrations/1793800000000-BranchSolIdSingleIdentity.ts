import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SOL ID becomes a branch's single identity; `branch_code` is removed.
 *
 * A branch used to carry two identifiers — an auto-generated `branch_code` (`BR-####`) and an
 * optional `sol_id`. Bank files identify a branch only by its SOL id (an ICICI list's "BRANCH"
 * column holds it), so the second identifier was ceremony that spawned duplicate importers and a
 * `code` vs `sol_id` split. This migration makes `sol_id` the one required, unique-per-client
 * identifier and drops `branch_code` entirely.
 *
 * Safe because every live branch already has `sol_id` populated (both importers default it from the
 * branch code, and the deployed rows were backfilled). The backfill below repeats that for any
 * environment that predates it, with a last-resort synthetic value so the NOT NULL can never wedge
 * a boot on a stray empty row. Migrations run on boot, and the code that stops reading `branch_code`
 * ships in the same commit.
 */
export class BranchSolIdSingleIdentity1793800000000 implements MigrationInterface {
  name = 'BranchSolIdSingleIdentity1793800000000';

  public async up(q: QueryRunner): Promise<void> {
    // Idempotent across two starting shapes: a DB that still has `branch_code` (the one this
    // migration transforms) and one already migrated to SOL-ID-only (a fresh DB whose baseline
    // never had it). Every step below is guarded so re-running, or running on the target shape,
    // is a no-op rather than an error.

    // 1. Fill in any missing SOL id: from the branch code where that column still exists, then a
    //    synthetic per-branch fallback so the NOT NULL below always holds.
    await q.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_name = 'branches' AND column_name = 'branch_code'
        ) THEN
          UPDATE "branches"
             SET "sol_id" = COALESCE(NULLIF("sol_id", ''), NULLIF("branch_code", ''), 'SOL-' || left(id::text, 8))
           WHERE "sol_id" IS NULL OR "sol_id" = '';
        ELSE
          UPDATE "branches"
             SET "sol_id" = COALESCE(NULLIF("sol_id", ''), 'SOL-' || left(id::text, 8))
           WHERE "sol_id" IS NULL OR "sol_id" = '';
        END IF;
      END $$;
    `);

    // 2. SOL id is now the identity — required.
    await q.query(`ALTER TABLE "branches" ALTER COLUMN "sol_id" SET NOT NULL`);

    // 3. Replace the partial-on-sol unique with one scoped to live branches — one active branch per
    //    (client, sol_id), the same scope the importer checks conflicts under (`isActive: true`).
    //    Soft-deleted rows are deliberately excluded: a removed branch still holds its old sol_id,
    //    and re-creating that branch, or merging a duplicate, must not be blocked by the corpse.
    //    Retire the branch_code uniqueness at the same time.
    await q.query(`DROP INDEX IF EXISTS "UQ_branches_client_sol_id"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_branches_client_branch_code"`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_branches_client_sol_id"
        ON "branches" ("client_id", "sol_id")
        WHERE "is_active" = true
    `);

    // 4. Drop the branch_code trigram/search index explicitly (named), then the column. CASCADE
    //    clears any remaining index or constraint that still references it (the auto-named
    //    @Index(['branchCode']) among them).
    await q.query(`DROP INDEX IF EXISTS "IDX_trgm_branches_branch_code"`);
    await q.query(`ALTER TABLE "branches" DROP COLUMN IF EXISTS "branch_code" CASCADE`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Re-add the column nullable (its former values are gone) and restore the prior uniqueness
    // shape. This does not resurrect the dropped codes; the data was disposable/re-importable.
    await q.query(`ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "branch_code" character varying(50)`);
    await q.query(`DROP INDEX IF EXISTS "UQ_branches_client_sol_id"`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_branches_client_sol_id"
        ON "branches" ("client_id", "sol_id")
        WHERE "sol_id" IS NOT NULL AND "sol_id" <> ''
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_branches_client_branch_code"
        ON "branches" ("client_id", "branch_code")
        WHERE "branch_code" IS NOT NULL AND "branch_code" <> ''
    `);
    await q.query(`ALTER TABLE "branches" ALTER COLUMN "sol_id" DROP NOT NULL`);
  }
}
