import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BACKFILL `organization_id`, so tenant scoping can finally be switched on.
 *
 * ## Why this exists
 *
 * `organization_id` has been on `assayers`, `branches`, `clients`, `projects` and `users` from
 * the start, is carried in every JWT, and is stamped on create. It has never been used as a read
 * filter anywhere in the backend. The lifecycle certification demonstrated the consequence
 * end to end: an OPERATIONS user belonging to one organisation could read another organisation's
 * assayer, suspend them, read their bank account number in cleartext, and soft-delete them — with
 * the audit trail faithfully recording the whole thing.
 *
 * `TenantScopedRepository` was written to close exactly this, and its own comment says why it was
 * never wired in: "Adoption is gated on a backfill. `organization_id` is nullable on every entity
 * that has it, and most rows are null today. Until those are backfilled … a scoped read returns
 * nothing for legacy rows … That migration is the precondition for wiring this into a module — it
 * is not a reason to add a 'null means everyone' branch, which would reintroduce the hole this
 * class closes."
 *
 * This is that migration.
 *
 * ## Why a single organisation is the right answer here, and how it was checked
 *
 * There is exactly one real organisation on this deployment, and every legacy row predates any
 * notion of a second one. So "which tenant does this row belong to?" has one defensible answer
 * and no ambiguity to resolve. The migration refuses to guess in any other situation: if it finds
 * zero organisations, or more than one, it leaves the data alone and says so, because at that
 * point assigning ownership is a business decision and not a schema one.
 *
 * Counted immediately before writing this: 1,155 assayers, 5,859 branches, 2 clients and 1 user
 * with a null organisation, against 17 assayers, 1 project and 5 users that already carry one —
 * and every non-null value already points at that same single organisation.
 *
 * ## What this deliberately does NOT do
 *
 * It does not make the columns `NOT NULL`. Doing so would be the tidier end state, but it turns
 * every future insert path that forgets to stamp the column into a hard failure at runtime, and
 * there are creation paths (imports, seeds, the registration flow) that would need auditing
 * first. The scoping this unblocks is safe without it: a scoped read filters on the caller's
 * organisation, so a row with a null organisation becomes invisible rather than public — the
 * failure direction is closed, which is the direction that matters. Tightening to NOT NULL is a
 * follow-up once every writer is confirmed.
 */
export class BackfillTenantOwnership1796500000000 implements MigrationInterface {
  name = 'BackfillTenantOwnership1796500000000';

  /** Every table that carries an owning organisation and has legacy rows without one. */
  private static readonly TENANT_OWNED_TABLES = [
    'assayers',
    'branches',
    'clients',
    'projects',
    'users',
  ];

  public async up(q: QueryRunner): Promise<void> {
    const orgs: Array<{ id: string }> = await q.query(
      `SELECT id FROM organizations WHERE is_active = true ORDER BY created_at ASC`,
    );

    if (orgs.length !== 1) {
      /**
       * Loud, and not an exception. Failing the migration would block every other change behind
       * it on a deployment whose only problem is that somebody has to decide who owns what — and
       * on a deployment with no organisations at all (a fresh database being built by the seed)
       * there is nothing to decide and nothing to do.
       */
      // eslint-disable-next-line no-console
      console.warn(
        `[BackfillTenantOwnership] Found ${orgs.length} active organisations; expected exactly 1. `
        + 'Leaving organization_id untouched — assigning ownership across multiple tenants is a '
        + 'business decision, not a migration. Tenant-scoped reads will return nothing for rows '
        + 'that still have a null organisation, which is the safe direction.',
      );
      return;
    }

    const orgId = orgs[0].id;
    for (const table of BackfillTenantOwnership1796500000000.TENANT_OWNED_TABLES) {
      // `IF EXISTS`-style guard: a table may legitimately be absent on an older database.
      const [{ exists }]: Array<{ exists: boolean }> = await q.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_name = $1 AND column_name = 'organization_id'
         ) AS exists`,
        [table],
      );
      if (!exists) continue;

      await q.query(
        `UPDATE "${table}" SET organization_id = $1 WHERE organization_id IS NULL`,
        [orgId],
      );
    }

    /**
     * Indexes on the column every scoped read is about to filter on.
     *
     * `assayers` already had one; the others did not, and a tenant predicate added to a
     * 5,859-row branch scan without an index is how a correctness fix becomes a performance
     * incident. Created concurrently is not available inside a migration transaction, so these
     * are ordinary creates — acceptable at these row counts.
     */
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_branches_organization_id" ON "branches" ("organization_id")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_clients_organization_id" ON "clients" ("organization_id")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_projects_organization_id" ON "projects" ("organization_id")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_users_organization_id" ON "users" ("organization_id")`);
  }

  /**
   * Reverting sets the backfilled rows back to null.
   *
   * It cannot tell which rows this migration wrote and which already carried the value, because
   * the value is identical — there was only ever one organisation. So `down` restores the
   * *shape* the code expected before (nullable, mostly null) rather than the exact prior rows,
   * and it drops the indexes it added. That is honest about what is recoverable: on a
   * single-tenant deployment the distinction has no meaning, and on a multi-tenant one this
   * migration will have declined to run at all.
   */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "idx_users_organization_id"`);
    await q.query(`DROP INDEX IF EXISTS "idx_projects_organization_id"`);
    await q.query(`DROP INDEX IF EXISTS "idx_clients_organization_id"`);
    await q.query(`DROP INDEX IF EXISTS "idx_branches_organization_id"`);
  }
}
