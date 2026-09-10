/**
 * Bring a FAPOMS database from nothing to ready: roles, schema, grants — in that order.
 *
 * ## Why this is one compiled entry point and not three npm scripts
 *
 * The production image contains `dist` and nothing else: no `src`, no `ts-node`, no `scripts/`.
 * A deploy step that shells out to `npm run migration:run` works on a developer's checkout and
 * fails inside the container, which is the worst possible place to discover it — mid-deploy, with
 * the old containers already stopping. So the whole sequence is one module that compiles into the
 * same image the API runs from, and `deploy/docker-compose.prod.yml` runs it with plain `node`.
 *
 * ## The steps, and who performs them
 *
 *   bootstrap  an administrative login       creates the three roles, the database, the extensions
 *   migrate    `fapoms_migrator`             applies the migrations
 *   harden     `fapoms_migrator`             reassigns the audit objects, grants the runtime its
 *                                            minimum, then re-connects AS the runtime and checks
 *
 * The application then starts as `fapoms_runtime` with `DB_MIGRATIONS_RUN=false`. `main.ts`
 * refuses to boot in production if either is wrong, and `StartupChecksService` asks the database
 * itself what that identity can do — so a deployment that skipped this step is told at boot rather
 * than during an incident.
 *
 * Every step is idempotent, which is what lets the same command serve a first provision and every
 * subsequent deploy. `harden` in particular must run after EVERY migration: a new table arrives
 * with no grant for the runtime, and a recreated audit trigger function arrives owned by the
 * migrator again.
 *
 *   node packages/backend/dist/infrastructure/database/roles/provision.js            # all three
 *   node packages/backend/dist/infrastructure/database/roles/provision.js harden     # just one
 *
 * ## Environment
 *
 * | variable | step | notes |
 * |---|---|---|
 * | `DB_ADMIN_URL` | bootstrap | a login that may CREATE ROLE and CREATE EXTENSION. Deploy-time only. |
 * | `FAPOMS_MIGRATION_PASSWORD` | all | the deploy credential. Never in the API's environment. |
 * | `FAPOMS_RUNTIME_PASSWORD` | bootstrap, harden | the application credential. |
 * | `DB_HOST`, `DB_PORT`, `DB_DATABASE` | all | where the database is. |
 * | `SKIP_BOOTSTRAP=true` | — | migrate and harden only, for a managed cluster whose roles somebody else owns. |
 */
import { DataSource } from 'typeorm';
import { MIGRATIONS_GLOB } from '../database.config';
import {
  AUDIT_OWNER_ROLE,
  MIGRATION_ROLE,
  RUNTIME_ASSERTIONS,
  RUNTIME_ROLE,
  createRolesSql,
  hardenSql,
} from './role-model';

/**
 * Extensions the migrations assume are present.
 *
 * Installed here, by the administrative login, rather than left to
 * `EnableRequiredExtensions1783000000000` to create as the migrator. Three of these four are
 * "trusted" in PostgreSQL 13+ and a non-superuser CAN create them — but only with `CREATE` on the
 * DATABASE, which is a privilege the migrator only has because of the ownership convergence below.
 * `postgis` is not trusted and needs a superuser at any privilege level. Doing all four the same
 * way here means a cluster with a stricter policy on extension creation still provisions.
 *
 * `pg_trgm` and `btree_gist` were both missing and the omission was invisible: on a database the
 * migrator owns, the migration creates a trusted extension itself. It only surfaces on a database
 * somebody else created. `required-extensions.spec.ts` now derives the list from the migrations,
 * so this cannot silently fall behind a third time.
 *
 * `pg_stat_statements` is deliberately absent. Migration 1790700000000 creates it inside a guard,
 * because it is useless — and its views unreadable — unless the server was started with
 * `shared_preload_libraries=pg_stat_statements`, which is a compose concern rather than a
 * provisioning one.
 *
 * `pgcrypto` was here and is gone. No migration creates it and no SQL in this repository calls a
 * function it provides: `gen_random_uuid()` has been core since PostgreSQL 13 and this deployment
 * is 16, and every `digest`/`hmac`/`crypt` in the codebase is Node's own crypto module. An
 * extension nothing uses is surface for no benefit. If something needs it later, a migration will
 * create it and the spec beside this file will require it here.
 */
export const REQUIRED_EXTENSIONS = ['uuid-ossp', 'postgis', 'pg_trgm', 'btree_gist'];

export interface ProvisionTarget {
  host: string;
  port: number;
  database: string;
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. This step writes real credentials and schema; it will not guess one. ` +
        'See the table in provision.ts for what each step needs.',
    );
  }
  return value;
}

/** Connection options carrying no entity metadata: these steps issue catalogue statements only. */
function bareOptions(target: ProvisionTarget, username: string, password: string) {
  return {
    type: 'postgres' as const,
    host: target.host,
    port: target.port,
    database: target.database,
    username,
    password,
    entities: [],
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  };
}

const bare = (target: ProvisionTarget, username: string, password: string): DataSource =>
  new DataSource(bareOptions(target, username, password));

async function using<T>(ds: DataSource, fn: (ds: DataSource) => Promise<T>): Promise<T> {
  await ds.initialize();
  try {
    return await fn(ds);
  } finally {
    await ds.destroy();
  }
}

/**
 * Can this role sign in with this password right now?
 *
 * Its own short-lived connection, because a failed authentication is the answer rather than an
 * error to propagate. Any failure that is NOT an authentication rejection — the database not
 * existing yet on a first provision, say — counts as "cannot tell", and the caller stays quiet
 * rather than warning about a rotation that may not be happening.
 */
async function canSignIn(adminUrl: string, database: string, username: string, password: string): Promise<boolean> {
  // Host and port from the admin URL, credentials from the arguments — NOT `url` plus overrides.
  // TypeORM lets the URL's own credentials win, so a probe built that way signs in as the admin
  // every time and cheerfully reports that any password works. It did, and this check silently
  // never fired.
  const url = new URL(adminUrl);
  const probe = new DataSource({
    type: 'postgres',
    host: url.hostname,
    port: Number(url.port || 5432),
    database,
    username,
    password,
    entities: [],
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  try {
    await probe.initialize();
    return true;
  } catch (err) {
    const message = (err as Error).message ?? '';
    // 28P01 / "password authentication failed" is a real answer. Anything else is not.
    return !/password authentication failed|28P01/i.test(message);
  } finally {
    if (probe.isInitialized) await probe.destroy().catch(() => undefined);
  }
}

/**
 * Create the roles, the database and the extensions. The one step needing an administrative login.
 *
 * Re-running sets the passwords again and leaves everything else alone, so a credential rotation
 * is this step with new secrets rather than hand-written SQL on a production box.
 */
export async function bootstrapRoles(
  target: ProvisionTarget,
  adminUrl: string,
  runtimePassword: string,
  migrationPassword: string,
  log: (line: string) => void = console.log,
): Promise<void> {
  const admin = new DataSource({
    type: 'postgres',
    url: adminUrl,
    entities: [],
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });

  await using(admin, async (ds) => {
    const who = await ds.query('SELECT current_user AS who, usesuper AS super FROM pg_user WHERE usename = current_user');
    // Said out loud: running this as an ordinary role fails partway through with half the roles
    // created, and "permission denied for CREATE ROLE" does not obviously mean "wrong login".
    log(`Connected as ${who[0]?.who} (superuser: ${who[0]?.super === true}).`);

    /**
     * Say when a password is being CHANGED rather than set.
     *
     * `createRolesSql` runs `ALTER ROLE … PASSWORD` on every pass, which is what makes rotation
     * this script with new secrets rather than hand-written SQL on a production box. The cost is
     * that the variable declares what the password should be, not what it is: a mistyped or
     * accidentally-changed `FAPOMS_MIGRATION_PASSWORD` succeeds silently and rotates the deploy
     * credential, and anything still holding the old one breaks later, a long way from the cause.
     *
     * A warning rather than a refusal, deliberately — refusing would break the legitimate case
     * this behaviour exists for. What it buys is that an unintended rotation is visible in the
     * deploy log at the moment it happens instead of being inferred from a failure days later.
     */
    const known = await ds.query('SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])', [
      [MIGRATION_ROLE, RUNTIME_ROLE],
    ]);
    const existing = new Set((known ?? []).map((r: { rolname: string }) => r.rolname));
    const rotating: string[] = [];
    for (const [role, password] of [[MIGRATION_ROLE, migrationPassword], [RUNTIME_ROLE, runtimePassword]] as const) {
      if (!existing.has(role)) continue;
      if (!(await canSignIn(adminUrl, target.database, role, password))) rotating.push(role);
    }

    for (const statement of createRolesSql(runtimePassword, migrationPassword)) {
      await ds.query(statement);
    }
    if (rotating.length > 0) {
      log(
        `! ${rotating.join(' and ')} already existed and did NOT accept the supplied password, so it has ` +
          'been ROTATED to the value in this environment. If that was not intended, the old secret is ' +
          'gone and anything still using it will fail: put the previous value back and re-run.',
      );
    }
    log(`Roles ready: ${MIGRATION_ROLE} (deploy), ${AUDIT_OWNER_ROLE} (owns audit, no login), ${RUNTIME_ROLE} (the app).`);

    const exists = await ds.query('SELECT 1 FROM pg_database WHERE datname = $1', [target.database]);
    if (!Array.isArray(exists) || exists.length === 0) {
      // Owned by the migration role, so migrations create and alter without a further grant, and
      // the runtime — which owns nothing — cannot.
      await ds.query(`CREATE DATABASE "${target.database}" OWNER ${MIGRATION_ROLE}`);
      log(`Created database ${target.database}, owned by ${MIGRATION_ROLE}.`);
    } else {
      /**
       * The database usually already exists, and this branch used to leave it alone.
       *
       * That was the bug, and it was the branch every real deployment takes: the postgres image's
       * entrypoint creates `POSTGRES_DB` — which `deploy/docker-compose.prod.yml` sets — before
       * this code ever connects, owned by the superuser. So the migrator owned nothing, and since
       * PostgreSQL 15 took `CREATE` on `public` away from `PUBLIC` and bound it to
       * `pg_database_owner`, it had no `CREATE` there either. The first migration died on
       * "permission denied for schema public", `db-migrate` exited 1, and the API — which gates on
       * that container succeeding — never started.
       *
       * A `GRANT USAGE, CREATE ON SCHEMA public` would fix that one symptom and not the next two:
       * a trusted extension needs `CREATE` on the DATABASE rather than the schema, and hardening
       * later needs to own the audit tables in order to reassign them. Converging on the same end
       * state the create-branch produces fixes all three at once, and removes the divergence that
       * let the two branches behave differently in the first place.
       *
       * This changes ownership of the DATABASE, not of the objects in it: tables an earlier
       * deployment created stay owned by whoever created them, which is why `REASSIGN OWNED` runs
       * below. Nothing is dropped or recreated.
       */
      const owner = await ds.query(
        'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
        [target.database],
      );
      const currentOwner = owner?.[0]?.owner;
      if (currentOwner !== MIGRATION_ROLE) {
        await ds.query(`ALTER DATABASE "${target.database}" OWNER TO ${MIGRATION_ROLE}`);
        log(`Database ${target.database} exists, owned by ${currentOwner}; ownership moved to ${MIGRATION_ROLE}.`);
      } else {
        log(`Database ${target.database} already exists and is already owned by ${MIGRATION_ROLE}.`);
      }
    }
  });

  const url = new URL(adminUrl);
  url.pathname = `/${target.database}`;
  await using(new DataSource({ type: 'postgres', url: url.toString(), entities: [] }), async (ds) => {
    /**
     * Objects an earlier deployment created still belong to whoever created them.
     *
     * `ALTER DATABASE … OWNER` moves the database and nothing inside it, so on a deployment that
     * has been running the tables are still the old role's. Hardening then cannot do its job: it
     * runs as the migrator, and `ALTER TABLE audit_events OWNER TO fapoms_audit_owner` requires
     * owning the table. Reassigning is the admin's work, not the migrator's, so it happens here
     * while an administrative connection is still open.
     *
     * Scoped to the role that currently owns this schema, and to this database only — `REASSIGN
     * OWNED` never crosses a database boundary. On a fresh provision it matches nothing.
     */
    const reassigned = await ds.query(`
      DO $$
        DECLARE r record; moved int := 0;
      BEGIN
        FOR r IN
          SELECT c.oid::regclass AS ident
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public'
             AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
             -- An extension's own objects. spatial_ref_sys belongs to postgis and the database
             -- system refuses to release it — which is what makes REASSIGN OWNED the wrong
             -- instrument here: it is all-or-nothing over a role's whole estate and fails on the
             -- first object it may not touch, having moved nothing.
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
             -- A sequence behind a serial or identity column, and only that. Postgres refuses to
             -- change its owner independently ("cannot change owner of sequence
             -- audit_chain_seq_seq") because it follows its table, which this loop moves anyway.
             --
             -- Deliberately narrow: an earlier version excluded every 'a' and 'i' dependency and
             -- skipped assayer_location_pings and both of its partitions, which carry exactly
             -- those markers and ARE ours. Hardening then failed on "permission denied for table
             -- assayer_location_pings_default", several steps later and pointing nowhere useful.
             AND NOT (
               c.relkind = 'S'
               AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'a')
             )
             AND pg_get_userbyid(c.relowner) NOT IN ('${MIGRATION_ROLE}', '${AUDIT_OWNER_ROLE}')
        LOOP
          EXECUTE format('ALTER TABLE %s OWNER TO ${MIGRATION_ROLE}', r.ident);
          moved := moved + 1;
        END LOOP;
        FOR r IN
          SELECT p.oid::regprocedure AS ident
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
             AND pg_get_userbyid(p.proowner) NOT IN ('${MIGRATION_ROLE}', '${AUDIT_OWNER_ROLE}')
        LOOP
          EXECUTE format('ALTER FUNCTION %s OWNER TO ${MIGRATION_ROLE}', r.ident);
          moved := moved + 1;
        END LOOP;
        IF moved > 0 THEN
          RAISE NOTICE 'reassigned % object(s) to ${MIGRATION_ROLE}', moved;
        END IF;
      END $$;
      SELECT count(*)::int AS remaining
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
         AND NOT (
           c.relkind = 'S'
           AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'a')
         )
         AND pg_get_userbyid(c.relowner) NOT IN ('${MIGRATION_ROLE}', '${AUDIT_OWNER_ROLE}')
    `);
    const remaining = Number(reassigned?.[0]?.remaining ?? 0);
    if (remaining > 0) {
      throw new Error(
        `${remaining} object(s) in the public schema are still owned by neither ${MIGRATION_ROLE} ` +
          `nor ${AUDIT_OWNER_ROLE} after reassignment. Hardening cannot reassign what it does not ` +
          'own, so this would fail later and less clearly. Investigate before deploying.',
      );
    }

    for (const extension of REQUIRED_EXTENSIONS) {
      try {
        await ds.query(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
      } catch (err) {
        // PostGIS is absent from a plain `postgres` image. Named rather than swallowed: without
        // it the deployment fails later, on a migration, with a much worse message.
        log(`! could not install extension ${extension}: ${(err as Error).message}`);
      }
    }
    log(`Extensions checked: ${REQUIRED_EXTENSIONS.join(', ')}.`);
  });
}

/** Apply the migrations as the deploy role. */
export async function runMigrations(
  target: ProvisionTarget,
  migrationPassword: string,
  log: (line: string) => void = console.log,
): Promise<void> {
  // `MIGRATIONS_GLOB` from database.config.ts, resolved from `__dirname` — NOT `AppDataSource`,
  // whose globs are relative to `process.cwd()`. That is correct for the CLI, which runs from
  // `packages/backend`, and wrong for the deploy container, which runs from `/app`: the first
  // version of this reported "No migrations to apply" against an empty database and then failed
  // hardening on a table no migration had created. The same trap database.config.ts already
  // carries a comment about.
  const ds = new DataSource({
    ...bareOptions(target, MIGRATION_ROLE, migrationPassword),
    migrations: MIGRATIONS_GLOB,
  });
  await using(ds, async (connected) => {
    const applied = await connected.runMigrations({ transaction: 'each' });
    log(applied.length === 0 ? 'No migrations to apply.' : `Applied ${applied.length} migration(s).`);
    for (const migration of applied) log(`  ${migration.name}`);
  });
}

/**
 * Move the audit objects out of the runtime's reach, grant the runtime its minimum, and then
 * check the result from the runtime's own connection.
 *
 * The verification is the point. A GRANT that ran without error is not the same as a privilege
 * boundary that holds, and this is the difference between a deployment that is protected and one
 * that believes it is.
 */
export async function hardenDatabase(
  target: ProvisionTarget,
  migrationPassword: string,
  runtimePassword: string | undefined,
  log: (line: string) => void = console.log,
): Promise<void> {
  await using(bare(target, MIGRATION_ROLE, migrationPassword), async (ds) => {
    log(`Hardening ${target.database} as ${MIGRATION_ROLE}.`);
    for (const statement of hardenSql(target.database)) {
      try {
        await ds.query(statement);
      } catch (err) {
        // With the statement. A bare "permission denied for schema public" out of twenty
        // statements says nothing about which grant is wrong, on a box nobody will bisect by hand.
        throw new Error(`Hardening statement failed: ${(err as Error).message}\n${statement.trim().split('\n')[0]}…`);
      }
    }
    log('Grants applied; audit tables and their trigger functions reassigned.');
  });

  if (!runtimePassword) {
    log(
      `! FAPOMS_RUNTIME_PASSWORD not set, so the ${RUNTIME_ROLE} side was not checked. A deployment ` +
        'should always set it: applying a grant and confirming the boundary are different claims.',
    );
    return;
  }

  await using(bare(target, RUNTIME_ROLE, runtimePassword), async (ds) => {
    const failed: string[] = [];
    for (const { what, sql } of RUNTIME_ASSERTIONS) {
      const rows = await ds.query(sql);
      const ok = rows?.[0]?.ok === true;
      log(`  ${ok ? '✓' : '✗'} ${what}`);
      if (!ok) failed.push(what);
    }
    if (failed.length > 0) {
      throw new Error(
        `The runtime role is not where it should be after hardening:\n  - ${failed.join('\n  - ')}\n` +
          'Do not start the application against this database.',
      );
    }
    log(`✓ ${RUNTIME_ROLE} is least-privileged and cannot reach the audit structures.`);
  });
}

/** `provision.js [bootstrap|migrate|harden]…` — no argument means all three, in order. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const steps = argv.length > 0 ? argv : ['bootstrap', 'migrate', 'harden'];
  const target: ProvisionTarget = {
    host: env('DB_HOST', 'localhost'),
    port: Number(env('DB_PORT', '5432')),
    database: env('DB_DATABASE', 'fapoms'),
  };
  const migrationPassword = env('FAPOMS_MIGRATION_PASSWORD');
  const runtimePassword = process.env.FAPOMS_RUNTIME_PASSWORD;

  if (steps.includes('bootstrap') && process.env.SKIP_BOOTSTRAP !== 'true') {
    console.log('\n══ roles, database, extensions ══');
    await bootstrapRoles(target, env('DB_ADMIN_URL'), env('FAPOMS_RUNTIME_PASSWORD'), migrationPassword);
  } else if (steps.includes('bootstrap')) {
    console.log('\n══ roles, database, extensions — skipped (SKIP_BOOTSTRAP=true) ══');
  }

  if (steps.includes('migrate')) {
    console.log('\n══ migrations, as the deploy role ══');
    await runMigrations(target, migrationPassword);
  }

  if (steps.includes('harden')) {
    console.log('\n══ hardening, verified from the runtime side ══');
    await hardenDatabase(target, migrationPassword, runtimePassword);
  }

  console.log(
    `\n✓ database ready. Start the API and the worker with DB_USERNAME=${RUNTIME_ROLE}, ` +
      'DB_PASSWORD=$FAPOMS_RUNTIME_PASSWORD and DB_MIGRATIONS_RUN=false.',
  );
}

// Only when executed, never when imported by a test.
if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
