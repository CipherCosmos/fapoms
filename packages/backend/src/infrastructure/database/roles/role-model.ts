/**
 * WHO THE APPLICATION IS WHEN IT TALKS TO POSTGRES, AND WHAT THAT IDENTITY MAY DO.
 *
 * FAPOMS connected as a superuser. `audit_events` and `audit_chain` are append-only by trigger,
 * and a trigger fires for every row-level write no matter who is connected — but a superuser, or
 * the table's owner, can simply take the trigger away first:
 *
 *     ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable;
 *     DELETE FROM audit_events;
 *
 * Both succeed. Demonstrated in a throwaway database on 2026-09-09. So the append-only guarantee
 * held against the application's own code and against an accidental query, and did not hold
 * against anything that had the application's credential. For a system whose product is audit
 * evidence for banks, that is the wrong place for the boundary.
 *
 * `AuditEventsImmutable1794000000000` said so at the time: "Splitting migration-time and runtime
 * credentials into separate roles would close this the normal way, but that is a
 * deployment-architecture change, not something this migration can safely decide on its own."
 * This file is that change.
 *
 * ## Three roles
 *
 * | role | logs in | owns | may |
 * |---|---|---|---|
 * | `fapoms_migrator` | yes, at deploy time only | the ordinary schema | everything DDL; it is the deploy identity |
 * | `fapoms_audit_owner` | NO | the audit tables, their triggers and functions | nothing on its own; it exists to be an owner nobody can log in as |
 * | `fapoms_runtime` | yes, the API and the worker | nothing | SELECT/INSERT/UPDATE/DELETE on the ordinary tables, SELECT/INSERT on the audit tables |
 *
 * The control is ownership, not permission. `fapoms_runtime` owns nothing, so `ALTER TABLE`,
 * `DROP TABLE`, `DROP TRIGGER`, `ALTER FUNCTION` and `ALTER TABLE … DISABLE TRIGGER` are all
 * refused by PostgreSQL's ownership check before any grant is consulted — and there is no grant
 * that can confer ownership. It is also a member of no role, so `SET ROLE` reaches nothing, and it
 * is not a superuser, so `CREATE EXTENSION` and the rest are refused outright.
 *
 * `fapoms_migrator` CAN defeat the audit triggers, and that is the documented boundary: it is a
 * deploy-time credential that a running process never holds, so compromising the application does
 * not yield it. It is a member of `fapoms_audit_owner` so that a future migration altering an
 * audit table still works; nothing else is.
 *
 * ## Why the runtime still needs a little DDL, and how it gets it without the privilege
 *
 * `assayer_location_pings` is partitioned by month and `RetentionService` creates next month's
 * partition and drops expired ones on a schedule — real DDL, in the running process. Granting
 * `CREATE` on the schema for it would hand the runtime identity the ability to alter schema
 * objects, which is the thing being taken away.
 *
 * So it goes through `fapoms_manage_location_ping_partition`, a `SECURITY DEFINER` function owned
 * by the migrator with a pinned `search_path`. It accepts only names matching
 * `assayer_location_pings_YYYY_MM` and only creates them as partitions of that one parent, so the
 * privilege the runtime borrows is exactly "manage a month of location pings" and nothing wider.
 *
 * ## What is deliberately NOT here
 *
 * Row-level security. It would be the next layer, and it is a much larger change: every query in
 * the application would run under a policy, and a policy that is wrong fails closed in production
 * rather than in a test. The ownership split closes the finding that was actually demonstrated.
 */

/** The role the API and the worker connect as. Owns nothing, is a member of nothing. */
export const RUNTIME_ROLE = 'fapoms_runtime';
/** The role migrations run as. Deploy-time only; never in a running process's environment. */
export const MIGRATION_ROLE = 'fapoms_migrator';
/** Owns the audit objects. `NOLOGIN`: it exists so that nobody who can log in owns them. */
export const AUDIT_OWNER_ROLE = 'fapoms_audit_owner';

/** Append-only, and owned by `AUDIT_OWNER_ROLE` after hardening. */
export const AUDIT_TABLES = ['audit_events', 'audit_chain'] as const;

/** The trigger functions those tables' triggers call. Reassigned alongside the tables. */
export const AUDIT_FUNCTIONS = ['audit_events_reject_mutation()', 'audit_reject_truncate()'] as const;

/** The narrow DDL the runtime borrows, and the only `SECURITY DEFINER` function it may call. */
export const PARTITION_FUNCTION = 'fapoms_manage_location_ping_partition(text, text, timestamptz, timestamptz)';

/**
 * Create the three roles. Run once per cluster, by whoever provisions the database.
 *
 * Idempotent: re-running updates the passwords and leaves everything else alone, so a credential
 * rotation is this same script with new secrets rather than a hand-written `ALTER ROLE`.
 *
 * `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS` is stated explicitly rather than
 * relied on as the default, because `CREATE ROLE` inherits nothing but a future `ALTER ROLE` by
 * somebody else would not be caught by a default.
 */
export function createRolesSql(runtimePassword: string, migrationPassword: string): string[] {
  const quoted = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return [
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${AUDIT_OWNER_ROLE}') THEN
         CREATE ROLE ${AUDIT_OWNER_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       END IF;
     END $$;`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIGRATION_ROLE}') THEN
         CREATE ROLE ${MIGRATION_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       END IF;
     END $$;`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
         CREATE ROLE ${RUNTIME_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       END IF;
     END $$;`,
    // Stated every run, so a role that was altered by hand is put back.
    `ALTER ROLE ${AUDIT_OWNER_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    `ALTER ROLE ${MIGRATION_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoted(migrationPassword)}`,
    `ALTER ROLE ${RUNTIME_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoted(runtimePassword)}`,
    // The migrator can act as the audit owner, so a future migration that alters an audit table
    // still works. The runtime is a member of nothing, which is the whole point.
    `GRANT ${AUDIT_OWNER_ROLE} TO ${MIGRATION_ROLE}`,
    `REVOKE ${AUDIT_OWNER_ROLE} FROM ${RUNTIME_ROLE}`,
    `REVOKE ${MIGRATION_ROLE} FROM ${RUNTIME_ROLE}`,
  ];
}

/**
 * Grant the runtime exactly what it needs, take away everything else, and move the audit objects
 * out of reach. Run as `MIGRATION_ROLE`, after every migration run, on every deployment.
 *
 * Idempotent by construction — every statement is a GRANT, a REVOKE, or an ownership assignment
 * that is already true — so it is safe to run when nothing has changed, which is what lets it sit
 * unconditionally in the deploy sequence rather than being remembered.
 *
 * Ordered deliberately: the blanket grants come first and the audit-table revokes after, so the
 * `GRANT ... ON ALL TABLES` cannot re-open a table the previous statement had just closed.
 */
export function hardenSql(database: string): string[] {
  const auditList = AUDIT_TABLES.map((t) => `"${t}"`).join(', ');
  return [
    // ── Nobody at large gets anything ────────────────────────────────────────────────────────
    `REVOKE ALL ON DATABASE "${database}" FROM PUBLIC`,
    `REVOKE ALL ON SCHEMA public FROM PUBLIC`,
    `GRANT CONNECT, TEMPORARY ON DATABASE "${database}" TO ${MIGRATION_ROLE}`,
    // TEMPORARY, because a temp table lives in the session's own schema and cannot reach anything
    // else; CONNECT, because without it the application cannot open a connection at all.
    `GRANT CONNECT, TEMPORARY ON DATABASE "${database}" TO ${RUNTIME_ROLE}`,

    // The migrator owns the schema through `pg_database_owner`, but say it anyway: an existing
    // database whose `public` came from a template owned by somebody else would otherwise lose
    // its own deploy identity's access to the statement above.
    `GRANT USAGE, CREATE ON SCHEMA public TO ${MIGRATION_ROLE}`,
    // `CREATE`, for the audit owner, is not the ability to create anything — it cannot log in.
    // PostgreSQL requires the INCOMING owner to hold CREATE on the schema before it will accept
    // `ALTER TABLE … OWNER TO`, so without this the reassignment below is refused with
    // "permission denied for schema public", which points nowhere near the cause.
    `GRANT USAGE, CREATE ON SCHEMA public TO ${AUDIT_OWNER_ROLE}`,

    // ── The runtime reads and writes rows, and nothing else ──────────────────────────────────
    // USAGE, never CREATE: creating an object in `public` is altering the schema, which is the
    // privilege this whole change exists to remove from the running process.
    `GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME_ROLE}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${RUNTIME_ROLE}`,
    // Tables a later migration creates are covered without re-running anything, so a deployment
    // that forgets this script still fails closed rather than half-open.
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATION_ROLE} IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RUNTIME_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATION_ROLE} IN SCHEMA public
       GRANT USAGE, SELECT ON SEQUENCES TO ${RUNTIME_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATION_ROLE} IN SCHEMA public
       GRANT EXECUTE ON FUNCTIONS TO ${RUNTIME_ROLE}`,

    // ── PostGIS lives in whichever schema the extension chose ────────────────────────────────
    // Read-only: the runtime calls its functions, and never installs or alters an extension.
    `DO $$
       DECLARE s text;
     BEGIN
       FOR s IN SELECT DISTINCT n.nspname
                  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
                 -- plpgsql lives in pg_catalog, and GRANT SELECT ON ALL TABLES there reaches
                 -- pg_statistic, which even a superuser-owned grant is refused on. System
                 -- schemas are already readable by everyone; they are not what this loop is for.
                 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       LOOP
         EXECUTE format('GRANT USAGE ON SCHEMA %I TO ${RUNTIME_ROLE}', s);
         EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO ${RUNTIME_ROLE}', s);
         EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO ${RUNTIME_ROLE}', s);
       END LOOP;
     END $$;`,

    // ── The audit tables move out of reach ───────────────────────────────────────────────────
    // Ownership first: after this the runtime cannot ALTER, DROP, TRUNCATE or DISABLE TRIGGER on
    // them at any price, because none of those consults a grant.
    ...AUDIT_TABLES.map((t) => `ALTER TABLE "${t}" OWNER TO ${AUDIT_OWNER_ROLE}`),
    ...AUDIT_FUNCTIONS.map(
      (f) => `DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = '${f}'::regprocedure) THEN
                  EXECUTE 'ALTER FUNCTION ${f} OWNER TO ${AUDIT_OWNER_ROLE}';
                END IF;
              EXCEPTION WHEN undefined_function THEN NULL;
              END $$;`,
    ),
    // Then the grants: append and read, nothing more. TRUNCATE is never granted to anybody.
    `REVOKE ALL ON ${auditList} FROM PUBLIC`,
    `REVOKE ALL ON ${auditList} FROM ${RUNTIME_ROLE}`,
    `GRANT SELECT, INSERT ON ${auditList} TO ${RUNTIME_ROLE}`,

    // ── The one piece of DDL the runtime borrows ─────────────────────────────────────────────
    `DO $$ BEGIN
       IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = '${PARTITION_FUNCTION}'::regprocedure) THEN
         EXECUTE 'REVOKE ALL ON FUNCTION ${PARTITION_FUNCTION} FROM PUBLIC';
         EXECUTE 'GRANT EXECUTE ON FUNCTION ${PARTITION_FUNCTION} TO ${RUNTIME_ROLE}';
       END IF;
     EXCEPTION WHEN undefined_function THEN NULL;
     END $$;`,
  ];
}

/**
 * What a hardened database must be able to say about itself.
 *
 * Used by the deployment check and by `runtime-privileges.db.spec.ts`, so the property the tests
 * assert and the property the deployment verifies are the same list rather than two that can
 * drift. Every entry is a query returning a single boolean column `ok`.
 */
export const RUNTIME_ASSERTIONS: Array<{ what: string; sql: string }> = [
  {
    what: 'the runtime connection is not a superuser',
    sql: `SELECT NOT rolsuper AS ok FROM pg_roles WHERE rolname = current_user`,
  },
  {
    what: 'the runtime connection cannot create roles or databases',
    sql: `SELECT (NOT rolcreaterole AND NOT rolcreatedb) AS ok FROM pg_roles WHERE rolname = current_user`,
  },
  {
    what: 'the runtime connection cannot bypass row-level security',
    sql: `SELECT NOT rolbypassrls AS ok FROM pg_roles WHERE rolname = current_user`,
  },
  {
    what: 'the runtime role owns no table in the public schema',
    sql: `SELECT count(*) = 0 AS ok FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`,
  },
  {
    what: 'the runtime role is a member of no other role',
    sql: `SELECT count(*) = 0 AS ok FROM pg_auth_members m
            JOIN pg_roles r ON r.oid = m.member
           WHERE r.rolname = current_user`,
  },
  {
    what: 'the audit tables are owned by a role that cannot log in',
    sql: `SELECT count(*) = ${AUDIT_TABLES.length} AS ok
            FROM pg_tables t JOIN pg_roles r ON r.rolname = t.tableowner
           WHERE t.schemaname = 'public'
             AND t.tablename IN (${AUDIT_TABLES.map((x) => `'${x}'`).join(', ')})
             AND NOT r.rolcanlogin`,
  },
  {
    what: 'the runtime holds no UPDATE, DELETE or TRUNCATE on the audit tables',
    sql: `SELECT bool_and(NOT has_table_privilege(current_user, t, 'UPDATE')
                      AND NOT has_table_privilege(current_user, t, 'DELETE')
                      AND NOT has_table_privilege(current_user, t, 'TRUNCATE')) AS ok
            FROM unnest(ARRAY[${AUDIT_TABLES.map((x) => `'${x}'`).join(', ')}]) AS t`,
  },
  {
    what: 'the runtime can still append to and read the audit tables',
    sql: `SELECT bool_and(has_table_privilege(current_user, t, 'INSERT')
                      AND has_table_privilege(current_user, t, 'SELECT')) AS ok
            FROM unnest(ARRAY[${AUDIT_TABLES.map((x) => `'${x}'`).join(', ')}]) AS t`,
  },
  {
    what: 'the runtime cannot create objects in the public schema',
    sql: `SELECT NOT has_schema_privilege(current_user, 'public', 'CREATE') AS ok`,
  },
  {
    what: 'the audit trigger functions are owned by a role that cannot log in',
    sql: `SELECT count(*) FILTER (WHERE r.rolcanlogin) = 0 AS ok
            FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
           WHERE p.proname IN ('audit_events_reject_mutation', 'audit_reject_truncate')`,
  },
];
