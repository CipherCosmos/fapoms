import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MAKE A FRESH DEPLOYMENT'S SCHEMA MATCH A MIGRATED ONE.
 *
 * ## Why this exists
 *
 * Certification built a database from `migration:run` alone, against an empty Postgres, and
 * diffed the result against the running deployment. All 71 migrations applied cleanly and no
 * manual SQL was needed — but the two schemas were not equal. Two differences, both real, both
 * invisible on any database that already had data when it was migrated.
 *
 * ### The four indexes that a new deployment never gets
 *
 * `1796500000000-BackfillTenantOwnership` opens by counting active organisations and returns
 * early if there is not exactly one:
 *
 *     if (orgs.length !== 1) { console.warn(...); return; }
 *
 * That guard is right for the backfill it protects — stamping ownership when you cannot tell whose
 * it is would be worse than leaving it null. But four `CREATE INDEX IF NOT EXISTS` statements sit
 * *after* it, and on a brand-new database `organizations` is empty at migration time, because the
 * organisation is created by the seed and the seed runs after migrations. So the migration
 * short-circuits, the indexes are never created, and the migration is recorded as applied — which
 * makes it unrecoverable by re-running. Confirmed end to end: migrate, seed, re-run, still absent.
 *
 * The indexes matter. `TenantScopedRepository` filters on `organization_id`, so every scoped read
 * of users, clients, projects and branches uses that predicate, and on a fresh deployment it is
 * unindexed — the exact performance risk the original migration's own comment says the index was
 * being added to avoid.
 *
 * Created here unconditionally, outside any guard, because an index does not depend on the data.
 *
 * ### Two constraints that ship NOT VALID and are never validated
 *
 * `1796200000000-Phase2OperationalIntegrity` adds `chk_assayers_employment_dates_sane` and
 * `chk_assayers_termination_dates_sane` with `NOT VALID`, which is correct: legacy rows might have
 * violated them, and `NOT VALID` lets the constraint start guarding new writes without failing the
 * deployment on old data. What was missing is the second half. A repository-wide search for
 * `VALIDATE CONSTRAINT` finds nothing — no migration, no script. The live database shows both as
 * valid; a freshly migrated one shows both as `NOT VALID`. The only way to get from one to the
 * other is an operator typing `ALTER TABLE ... VALIDATE CONSTRAINT` by hand.
 *
 * That is the same shape as the defect this project already fixed once: a migration plus an
 * undocumented manual step, which works on the machine where somebody remembered and nowhere else.
 * The consequence is narrow — a `NOT VALID` CHECK still enforces on every INSERT and UPDATE, so
 * this is catalogue drift rather than an open integrity hole — but "the schema depends on
 * somebody's memory" is the part worth ending.
 *
 * Validation is a no-op where it has already happened, and on any database whose rows satisfy the
 * constraint it is a cheap scan. If it fails, it fails loudly and names the rows to repair, which
 * is the correct outcome.
 */
export class FreshDeploymentSchemaParity1797000000000 implements MigrationInterface {
  name = 'FreshDeploymentSchemaParity1797000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Unconditional: an index is a property of the schema, not of the data in it.
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_branches_organization_id" ON "branches" ("organization_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_clients_organization_id" ON "clients" ("organization_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_projects_organization_id" ON "projects" ("organization_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_users_organization_id" ON "users" ("organization_id")`);

    /**
     * Validate the two date constraints, but only if they are actually present and not already
     * valid. Guarded rather than blind so this migration is safe on a database where the
     * constraints were validated by hand, and on one where an earlier migration was rolled back.
     */
    for (const name of ['chk_assayers_employment_dates_sane', 'chk_assayers_termination_dates_sane']) {
      const rows: Array<{ convalidated: boolean }> = await queryRunner.query(
        `SELECT convalidated FROM pg_constraint WHERE conname = $1 AND conrelid = 'assayers'::regclass`,
        [name],
      );
      if (rows.length === 0) continue;
      if (rows[0].convalidated) continue;
      await queryRunner.query(`ALTER TABLE "assayers" VALIDATE CONSTRAINT "${name}"`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The indexes come off. Validation is deliberately not reversed: a constraint cannot be
    // un-validated in Postgres without dropping and re-adding it, and re-introducing a NOT VALID
    // constraint over rows already known to satisfy it would be theatre.
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_branches_organization_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_clients_organization_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_projects_organization_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_organization_id"`);
  }
}
