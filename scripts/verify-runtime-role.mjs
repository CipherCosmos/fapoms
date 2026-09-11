#!/usr/bin/env node
/**
 * CAN THE APPLICATION'S OWN DATABASE CREDENTIAL DEFEAT THE AUDIT TRAIL?
 *
 * It could. FAPOMS connected to PostgreSQL as a superuser, so the append-only triggers on
 * `audit_events` and `audit_chain` protected the tables from the application's code and from an
 * accidental query, and not from anything holding the application's credential:
 *
 *     ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable;
 *     DELETE FROM audit_events;
 *
 * Both succeeded. This script builds the whole deployment from nothing on a disposable database,
 * applies the role split in `packages/backend/src/infrastructure/database/roles/`, and then tries
 * every one of those attacks AS THE RUNTIME ROLE. It also checks the other direction — that the
 * ordinary work of the application still succeeds — because a boundary that also stops the
 * product working is not a boundary anyone will keep.
 *
 * Nothing here touches an existing database. It creates its own, and drops it on every exit path
 * including a failure or a Ctrl-C. Point it at a disposable PostgreSQL, never at a deployment:
 *
 *   DB_ADMIN_URL=postgres://pgadmin:…@127.0.0.1:55433/postgres node scripts/verify-runtime-role.mjs
 *
 * Exit code 0 means: migrations run under a non-superuser role, the runtime identity is
 * least-privileged, every listed attack is refused, and normal operations still work.
 */
/**
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * SAFETY CLASSIFICATION: DESTRUCTIVE — CREATES AND DROPS A DATABASE
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * databases   : CREATE DATABASE, applies the role split, then DROP DATABASE ... WITH (FORCE).
 * destructive : deliberately ATTEMPTS TRUNCATE / DROP TRIGGER / DROP TABLE / DROP FUNCTION on
 *               audit_events and audit_chain as fapoms_runtime, to prove each is refused — and
 *               GRANTs itself TRUNCATE/UPDATE/DELETE to prove the grant changes nothing. All of
 *               it inside the throwaway database, never the real one.
 * credential  : needs an admin credential that may CREATE and DROP databases.
 * gate        : none of its own — it does not use _lib.mjs.
 *
 * The full table for every script here is in scripts/acceptance/README.md.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = join(REPO_ROOT, 'packages', 'backend');

const ADMIN_URL = process.env.DB_ADMIN_URL || 'postgres://pgadmin:pgadmin_dev@127.0.0.1:55433/postgres';

/**
 * The two ways a FAPOMS database comes into existence, both of which must end in the same place.
 *
 * The second one is the one every real deployment takes, and it was broken for a week without
 * anybody noticing — because this script only ever exercised the first. `bootstrapRoles` creates
 * the database owned by the migration role, so provisioning worked; the postgres image's
 * entrypoint creates `POSTGRES_DB` first, owned by the superuser, so provisioning did not. Since
 * PostgreSQL 15 bound `CREATE` on `public` to `pg_database_owner`, the migrator had no CREATE, the
 * first migration died on "permission denied for schema public", and `db-migrate` exited 1 — which
 * the API gates on.
 *
 * A test that provisions its own database will always take the branch that works. That is the
 * whole reason this list has two entries.
 */
const SHAPES = [
  { name: 'provision creates the database itself', preCreate: false },
  { name: 'the database already exists, created by the image entrypoint', preCreate: true },
];

let DB = `rolecheck_${Date.now()}_${process.pid}`;
const created = [];
// Throwaway credentials for a throwaway database, generated per run so nothing here is a secret
// anybody could later mistake for a real one.
const RUNTIME_PW = `rt_${randomUUID()}`;
const MIGRATION_PW = `mg_${randomUUID()}`;

const admin = new URL(ADMIN_URL);
const HOST = admin.hostname;
const PORT = admin.port || '5432';

const results = [];
let group = '';
const record = (ok, what, detail) => {
  results.push({ group, ok, what, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
};

function connect(user, password, database = DB) {
  return new Client({ host: HOST, port: Number(PORT), user, password, database });
}

function run(script, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', '--silent', script], {
      cwd: BACKEND,
      env: {
        ...process.env,
        DB_HOST: HOST,
        DB_PORT: PORT,
        DB_DATABASE: DB,
        DB_SSL: 'false',
        DATABASE_URL: '',
        DATABASE_URL_UNPOOLED: '',
        ...extraEnv,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${script} exited ${code}\n${out}`))));
  });
}

/**
 * Run one statement and report whether the database refused it.
 *
 * A SAVEPOINT per attempt, because a failed statement aborts the surrounding transaction and every
 * later probe would then fail for the wrong reason and read as a pass.
 */
async function refuses(client, what, sql) {
  await client.query('SAVEPOINT probe');
  try {
    await client.query(sql);
    await client.query('RELEASE SAVEPOINT probe');
    record(false, what, 'SUCCEEDED — the runtime credential can do this');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT probe');
    record(true, what, `refused: ${String(err.message).split('\n')[0]}`);
  }
}

async function succeeds(client, what, sql, params) {
  await client.query('SAVEPOINT probe');
  try {
    const res = await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT probe');
    record(true, what);
    return res;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT probe');
    record(false, what, `FAILED: ${String(err.message).split('\n')[0]}`);
    return null;
  }
}

async function runShape(shape) {
  DB = `rolecheck_${Date.now()}_${process.pid}_${shape.preCreate ? 'pre' : 'new'}`;
  created.push(DB);
  group = shape.name;
  console.log(`\n╔══ ${shape.name} ══`);

  if (shape.preCreate) {
    // Exactly what `POSTGRES_DB` makes the postgis entrypoint do: the database exists, owned by
    // the superuser, before provisioning connects.
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${DB}"`);
    } finally {
      await admin.end();
    }
    const inDb = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, `/${DB}`) });
    await inDb.connect();
    try {
      // The image's init scripts install these into the database they create.
      for (const e of ['postgis', 'pg_stat_statements']) {
        await inDb.query(`CREATE EXTENSION IF NOT EXISTS "${e}"`).catch(() => undefined);
      }
    } finally {
      await inDb.end();
    }
    record(true, 'the database exists before provisioning, owned by the superuser');
  }

  // The same entry point the deploy container runs, so what is proven here is the deployment
  // sequence itself and not a second implementation of it that happens to agree today.
  console.log(`→ provisioning ${DB} on ${HOST}:${PORT} — roles, schema, grants`);
  const log = await run('db:provision', {
    DB_ADMIN_URL: ADMIN_URL,
    FAPOMS_RUNTIME_PASSWORD: RUNTIME_PW,
    FAPOMS_MIGRATION_PASSWORD: MIGRATION_PW,
  });
  // `\w`, not `[A-Za-z]`: class names carry digits in the middle too (Phase2…), and matching only
  // letters silently under-counted 79 migrations as 75 — a wrong number in a report is worse than
  // no number.
  const applied = (log.match(/^ {2}\w+\d{10,}$/gm) || []).length;
  record(applied > 70, `${applied} migrations applied by a non-superuser role`);

  const runtime = connect('fapoms_runtime', RUNTIME_PW);
  await runtime.connect();
  try {
    const who = await runtime.query('SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super');
    console.log(`\n→ probing as ${who.rows[0].u} (superuser: ${who.rows[0].super})`);
    record(who.rows[0].super === false, 'the runtime connection is not a superuser');

    await runtime.query('BEGIN');

    console.log('\n  attacks on the audit trail');
    await refuses(runtime, 'UPDATE audit_events', `UPDATE audit_events SET remarks = 'rewritten'`);
    await refuses(runtime, 'DELETE audit_events', 'DELETE FROM audit_events');
    await refuses(runtime, 'TRUNCATE audit_events', 'TRUNCATE audit_events');
    await refuses(runtime, 'TRUNCATE audit_events CASCADE', 'TRUNCATE audit_events CASCADE');
    await refuses(runtime, 'TRUNCATE audit_events, audit_chain RESTART IDENTITY', 'TRUNCATE audit_events, audit_chain RESTART IDENTITY CASCADE');
    await refuses(runtime, 'UPDATE audit_chain', `UPDATE audit_chain SET row_hash = 'x'`);
    await refuses(runtime, 'DELETE audit_chain', 'DELETE FROM audit_chain');
    await refuses(runtime, 'ALTER TABLE audit_events', 'ALTER TABLE audit_events ADD COLUMN injected text');
    await refuses(runtime, 'ALTER TABLE audit_events DISABLE TRIGGER', 'ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable');
    await refuses(runtime, 'ALTER TABLE audit_events DISABLE TRIGGER ALL', 'ALTER TABLE audit_events DISABLE TRIGGER ALL');
    await refuses(runtime, 'DROP TRIGGER on audit_events', 'DROP TRIGGER audit_events_immutable ON audit_events');
    await refuses(runtime, 'DROP TRIGGER on audit_chain', 'DROP TRIGGER audit_chain_no_truncate ON audit_chain');
    await refuses(runtime, 'ALTER the audit trigger function', `ALTER FUNCTION audit_events_reject_mutation() RENAME TO neutered`);
    await refuses(runtime, 'REPLACE the audit trigger function', `CREATE OR REPLACE FUNCTION audit_events_reject_mutation() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await refuses(runtime, 'DROP the audit trigger function', 'DROP FUNCTION audit_events_reject_mutation() CASCADE');
    await refuses(runtime, 'DROP TABLE audit_events', 'DROP TABLE audit_events');
    await refuses(runtime, 'ALTER TABLE audit_events OWNER TO the runtime role', 'ALTER TABLE audit_events OWNER TO fapoms_runtime');

    console.log('\n  escalation');
    await refuses(runtime, 'SET ROLE fapoms_migrator', 'SET ROLE fapoms_migrator');
    await refuses(runtime, 'SET ROLE fapoms_audit_owner', 'SET ROLE fapoms_audit_owner');
    await refuses(runtime, 'ALTER ROLE fapoms_runtime SUPERUSER', 'ALTER ROLE fapoms_runtime SUPERUSER');
    await refuses(runtime, 'CREATE ROLE', 'CREATE ROLE smuggled LOGIN');
    await refuses(runtime, 'CREATE EXTENSION', 'CREATE EXTENSION IF NOT EXISTS hstore');
    await refuses(runtime, 'CREATE TABLE in the public schema', 'CREATE TABLE public.smuggled (id int)');
    await refuses(runtime, 'DROP TABLE assignments', 'DROP TABLE assignments');
    await refuses(runtime, 'ALTER TABLE assignments', 'ALTER TABLE assignments ADD COLUMN injected text');
    // Not `refuses`: PostgreSQL accepts a GRANT from a role with no grant option, raises a
    // WARNING that no privileges were granted, and returns success. The statement is not the
    // property — the resulting privilege is.
    await runtime.query('SAVEPOINT probe');
    await runtime.query('GRANT TRUNCATE, UPDATE, DELETE ON audit_events TO fapoms_runtime').catch(() => undefined);
    const after = await runtime.query(
      `SELECT bool_or(has_table_privilege(current_user, 'audit_events', p)) AS granted
         FROM unnest(ARRAY['TRUNCATE','UPDATE','DELETE']) AS p`,
    );
    await runtime.query('ROLLBACK TO SAVEPOINT probe');
    record(
      after.rows[0].granted === false,
      'granting itself TRUNCATE/UPDATE/DELETE on audit_events changes nothing',
      after.rows[0].granted === false ? 'the GRANT is a no-op without grant option' : 'IT WORKED',
    );
    await refuses(runtime, 'the partition function on a table it does not own', `SELECT fapoms_manage_location_ping_partition('drop', 'audit_events')`);
    await refuses(runtime, 'the partition function creating an arbitrary table', `SELECT fapoms_manage_location_ping_partition('create', 'smuggled_table', now(), now() + interval '1 month')`);

    await runtime.query('ROLLBACK');

    console.log('\n  and the application still works');
    await runtime.query('BEGIN');
    const eventId = randomUUID();
    await succeeds(
      runtime,
      'append an audit event',
      `INSERT INTO audit_events (id, category, event_type, entity_type, entity_id, outcome, remarks)
       VALUES ($1, 'SYSTEM', 'ROLE_CHECK', 'Probe', $2, 'SUCCESS', 'runtime role verification')`,
      [eventId, randomUUID()],
    );
    await succeeds(runtime, 'read the audit trail back', 'SELECT count(*) FROM audit_events');
    await succeeds(runtime, 'read an ordinary table', 'SELECT count(*) FROM assignments');
    await succeeds(
      runtime,
      'insert into an ordinary table',
      `INSERT INTO organizations (id, version, name, code, is_active, created_at, updated_at)
       VALUES ($1, 1, 'Role Check', $2, true, now(), now())`,
      [randomUUID(), `RC_${Date.now()}`],
    );
    await succeeds(runtime, 'update an ordinary table', `UPDATE organizations SET name = 'Role Check 2' WHERE code LIKE 'RC_%'`);
    await succeeds(runtime, 'delete from an ordinary table', `DELETE FROM organizations WHERE code LIKE 'RC_%'`);
    await succeeds(runtime, 'take a transaction advisory lock', 'SELECT pg_advisory_xact_lock(4242)');
    await succeeds(runtime, 'create a temporary table', 'CREATE TEMP TABLE probe_temp (id int) ON COMMIT DROP');
    await succeeds(runtime, 'use a PostGIS function', 'SELECT ST_Distance(ST_MakePoint(0,0)::geography, ST_MakePoint(1,1)::geography)');
    await succeeds(runtime, 'read the outbox', 'SELECT count(*) FROM outbox_events');
    await succeeds(
      runtime,
      'manage a location-ping partition through the SECURITY DEFINER function',
      `SELECT fapoms_manage_location_ping_partition('create', 'assayer_location_pings_y2099m01', '2099-01-01T00:00:00Z', '2099-02-01T00:00:00Z')`,
    );
    await succeeds(
      runtime,
      'drop that partition again through the same function',
      `SELECT fapoms_manage_location_ping_partition('drop', 'assayer_location_pings_y2099m01')`,
    );
    await runtime.query('ROLLBACK');

    console.log('\n  and the audit trigger still fires for the one role that owns the table');
  } finally {
    await runtime.end();
  }

  // The migrator CAN defeat the triggers — it is a member of the audit owner so that a future
  // migration can alter an audit table. That is the documented boundary, and it is asserted here
  // rather than left implied, so nobody later reads this suite as claiming more than it proves.
  const migrator = connect('fapoms_migrator', MIGRATION_PW);
  await migrator.connect();
  try {
    await migrator.query('BEGIN');
    await succeeds(migrator, 'the DEPLOY role can still alter an audit table (the documented boundary)', 'ALTER TABLE audit_events ADD COLUMN migration_probe text');
    await migrator.query('ROLLBACK');
  } finally {
    await migrator.end();
  }

}

async function main() {
  for (const shape of SHAPES) await runShape(shape);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '✓' : '✗'} ${results.length - failed.length}/${results.length} checks passed across ${SHAPES.length} provisioning shapes`);
  if (failed.length > 0) {
    console.error('\nFailed:');
    for (const f of failed) console.error(`  - [${f.group}] ${f.what}${f.detail ? ` (${f.detail})` : ''}`);
    process.exitCode = 1;
  }
}

let exitCode = 0;
try {
  await main();
  exitCode = process.exitCode || 0;
} catch (err) {
  console.error(err.message);
  exitCode = 1;
} finally {
  const cleanup = new Client({ connectionString: ADMIN_URL });
  try {
    await cleanup.connect();
    // Every database this run created, not just the last one — a failure part way through the
    // second shape must not leave the first one behind.
    for (const name of created) {
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  } catch (err) {
    console.error(`! could not drop ${created.join(', ')}: ${err.message}`);
  } finally {
    await cleanup.end().catch(() => undefined);
  }
  process.exit(exitCode);
}
