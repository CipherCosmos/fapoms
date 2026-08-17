import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `pg_stat_statements` — the cumulative, per-normalised-statement history that makes a query
 * regression attributable to a query.
 *
 * Phase 4 of the 2026-08-16 audit tuned Postgres off its image defaults but left this half done:
 * `shared_preload_libraries=pg_stat_statements` went into the compose files, and the extension
 * itself was left as a sentence in a comment telling an operator to type `CREATE EXTENSION` once,
 * by hand, after the first start. Nobody ever did, on any environment. The result was the worst of
 * both worlds — the library was loaded and paying its (small) cost in every backend, and no
 * database had the view to read it back from.
 *
 * WHY THIS IS A MIGRATION AND NOT CONTAINER INIT
 * ----------------------------------------------
 * The obvious alternative is `/docker-entrypoint-initdb.d`, and it was rejected for a specific
 * reason: those scripts run exactly once, on an EMPTY data directory. Every database this project
 * actually has — dev, `fapoms_scale2`, and the live homeserver deployment — was initialised long
 * ago, so an init script would have been dead code on every machine that exists and would only
 * ever help a machine created after this commit. Migrations are the one mechanism in this repo
 * that reaches databases that already exist, and `1783000000000-EnableRequiredExtensions` already
 * establishes migrations as the home for "extensions this schema needs". Adding a second
 * mechanism for the same concern is exactly what the one-implementation rule forbids.
 *
 * The stated objection to a migration was privileges, and it deserves a real answer rather than an
 * assumption. Checked on 2026-08-17 against the running container:
 *
 *     \du  →  fapoms | Superuser, Create role, Create DB, Replication, Bypass RLS
 *
 * The application connects as `DB_USERNAME`, and both compose files pass that same value as the
 * image's `POSTGRES_USER`, which the postgres/postgis entrypoint creates as the bootstrap
 * superuser. So the migration runner is a superuser here and `CREATE EXTENSION` is permitted.
 * That is a property of THIS deployment, not of the code — see the fallback below.
 *
 * The second stated objection was ordering: that `CREATE EXTENSION` "errors outright when the
 * library is not preloaded", which would break `migration:run` on a developer machine whose
 * Postgres predates the compose change. That was tested rather than believed, on PG 16.4:
 *
 *     CREATE EXTENSION IF NOT EXISTS pg_stat_statements;   → CREATE EXTENSION   (exit 0)
 *     SELECT count(*) FROM pg_stat_statements;             → ERROR 55000:
 *                              pg_stat_statements must be loaded via shared_preload_libraries
 *
 * Creating the extension only installs SQL objects; it does not touch the shared-memory hash
 * table, so it is safe with or without the preload. The ordering hazard is entirely on the READER,
 * and that is handled where it belongs — `RuntimeMetricsService` treats 55000 as "not collecting
 * yet" and reports zero rather than throwing. This migration therefore cannot break a boot on a
 * machine that has not yet recreated its Postgres container.
 *
 * WHY THE DO/EXCEPTION WRAPPER
 * ----------------------------
 * `pg_stat_statements` is not a *trusted* extension (unlike `pg_trgm`), so a database owner who is
 * not a superuser cannot install it — which is the normal situation on RDS, Cloud SQL and any
 * hardened deployment where the app does not own the cluster. Those two cases must behave
 * differently from a bug:
 *
 *   42501 insufficient_privilege — the app role is not a superuser. Managed Postgres usually
 *         ships this extension pre-created in `rdsadmin`/`cloudsqlsuperuser` terms anyway, so the
 *         right response is to skip and let the operator handle it, not to refuse to deploy.
 *   58P01 undefined_file        — the contrib .so is not installed at all (a slim base image).
 *
 * A bare `CREATE EXTENSION` that raised either would abort the migration's transaction, and every
 * subsequent statement in it would fail with "current transaction is aborted" — catching the error
 * in TypeScript does NOT undo that, which is the trap that makes best-effort SQL in a transactional
 * migration surprisingly hard. A PL/pgSQL `EXCEPTION` block opens an implicit subtransaction, so a
 * caught error rolls back only the CREATE and the outer transaction survives intact. Any OTHER
 * error still propagates and fails the migration, because an unexpected failure here is a real
 * defect and should be loud. Verified by running this exact block against a scratch database.
 *
 * Observability is not correctness: a deployment that cannot install this must still deploy. What
 * it loses is the ability to answer "which query got slower?" without reproducing it by hand — and
 * the `db_query_stats_available` gauge says so out loud instead of reading as a healthy zero.
 */
export class EnableQueryStatistics1790700000000 implements MigrationInterface {
  name = 'EnableQueryStatistics1790700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
      EXCEPTION
        WHEN insufficient_privilege THEN
          RAISE WARNING 'pg_stat_statements not installed: % connects as a non-superuser. Slow-query attribution will be unavailable until a superuser runs: CREATE EXTENSION pg_stat_statements;', current_user;
        WHEN undefined_file THEN
          RAISE WARNING 'pg_stat_statements not installed: the contrib library is missing from this Postgres build. Slow-query attribution will be unavailable.';
      END
      $$;
    `);
  }

  public async down(): Promise<void> {
    // Deliberately not dropped, for the same reason 1783000000000 does not drop PostGIS: an
    // extension is database-wide state, not schema state. Rolling back one migration must not
    // discard the accumulated statement history that whoever is debugging the rollback is very
    // likely to want. `DROP EXTENSION pg_stat_statements` is a one-line manual step if it is ever
    // genuinely wanted, and it also throws away every counter — which is not a side effect a
    // rollback should have.
  }
}
