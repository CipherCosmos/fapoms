#!/usr/bin/env node
/**
 * DO THE MIGRATIONS STILL BUILD A DATABASE FROM NOTHING?
 *
 * Every deployment runs `migration:run` against a database that already holds most of the schema,
 * so the only thing routinely proven is that the newest migration applies on top of the previous
 * one. A migration that depends on a table an earlier one created and a later one renamed, or on
 * a column `synchronize` once added by hand, keeps working for ever on the deployed database and
 * fails the first time somebody provisions a new environment — which is the worst moment to find
 * out, because there is no old container left to roll back to.
 *
 * So this builds a schema from empty, and then runs the migrations a SECOND time to prove the run
 * is idempotent: a migration that cannot be re-run turns a retried deploy into a broken one.
 *
 * It never touches the database it connects to. `CREATE DATABASE … TEMPLATE template0` gives a
 * database with no local additions at all, and it is dropped on every exit path — success,
 * failure, or Ctrl-C.
 *
 * Node rather than psql, because psql is not installed on every machine this has to run on and
 * `pg` already ships in this workspace.
 *
 * Usage:
 *   node scripts/verify-migrations-from-empty.mjs
 *   DB_PORT=55432 node scripts/verify-migrations-from-empty.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `DB_ADMIN_URL` wins when it is set, because creating a database from `template0` needs a login
 * that may CREATE DATABASE, and on a hardened cluster that is not the application's credential.
 * The discrete `DB_*` variables remain for a developer machine where one role does everything.
 */
const conn = (() => {
  if (process.env.DB_ADMIN_URL) {
    const url = new URL(process.env.DB_ADMIN_URL);
    return {
      host: url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      adminDb: url.pathname.replace(/^\//, '') || 'postgres',
    };
  }
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USERNAME || 'fapoms',
    password: process.env.DB_PASSWORD || 'fapoms_dev',
    adminDb: process.env.ADMIN_DB || 'postgres',
  };
})();
const ADMIN_DB = conn.adminDb;

/**
 * Floors, not exact counts — this file should not need editing every time a migration adds a
 * table. They exist so a run that creates the `migrations` table and nothing else cannot pass.
 */
const MIN_MIGRATIONS = Number(process.env.MIN_MIGRATIONS || 70);
const MIN_TABLES = Number(process.env.MIN_TABLES || 80);

/**
 * Controls that exist only because a migration added them. A schema that comes up without these
 * is structurally complete and functionally missing the things the audit trail and the money
 * depend on — which is exactly the failure a fresh provision would otherwise ship with.
 */
const REQUIRED_CONSTRAINTS = [
  ['assayer_payables', 'chk_assayer_payables_destination_evidence'],
  ['billing_payments', 'chk_billing_payments_destination_evidence'],
  ['assayer_document_versions', 'chk_assayer_document_versions_verified_keeps_evidence'],
];
const REQUIRED_INDEXES = [
  ['assignments', 'idx_assignments_single_active_assayer_day'],
  ['assignments', 'idx_assignments_single_active_branch'],
];

/**
 * The roles a fresh install must come up with. Without a floor here a database whose `roles`
 * table is empty would satisfy "every role holds what it declares" by holding nothing.
 *
 * PRODUCT_SUPPORT and ASSAYER are deliberately absent: the first declares no grants, and the
 * second has no role row on any database — assayers authenticate through the mobile app.
 */
const REQUIRED_ROLES = ['ADMIN', 'DEVELOPER', 'OPERATIONS', 'DESK', 'DESK_OPERATOR', 'AUDITOR'];

const scratch = `migcheck_${Date.now()}_${process.pid}`;

async function withClient(database, fn) {
  const client = new Client({ ...conn, database });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const one = async (client, sql) => (await client.query(sql)).rows[0];

function runInBackend(args, label = args.join(' ')) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, {
      cwd: join(REPO_ROOT, 'packages', 'backend'),
      env: {
        ...process.env,
        DB_HOST: conn.host,
        DB_PORT: String(conn.port),
        DB_USERNAME: conn.user,
        DB_PASSWORD: conn.password,
        DB_DATABASE: scratch,
        DB_SSL: 'false',
        // A URL in the environment wins over the discrete vars in data-source.ts, which would
        // silently point this whole run at whatever that URL names. Blank them.
        DATABASE_URL: '',
        DATABASE_URL_UNPOOLED: '',
      },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${label} exited ${code}\n${out}`))));
  });
}

const runMigrations = () => runInBackend(['run', '--silent', 'migration:run'], 'migration:run');
const runSeed = () => runInBackend(['run', '--silent', 'seed'], 'seed');

/**
 * What `ROLE_PERMISSIONS` says each built-in role holds, read from the source rather than from a
 * copy kept here — a copy would drift, and drift is the entire subject of this check.
 *
 * Transpile-only: this needs the value, not a type check, and the backend's own build covers the
 * latter.
 */
async function readDeclaredGrants() {
  const out = await new Promise((resolve, reject) => {
    const child = spawn(
      'npx',
      ['ts-node', '-T', '-e', "console.log(JSON.stringify(require('./src/modules/auth/role-permissions').ROLE_PERMISSIONS))"],
      { cwd: join(REPO_ROOT, 'packages', 'backend'), env: { ...process.env } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`reading ROLE_PERMISSIONS exited ${code}\n${stderr}`))));
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const appliedCount = (log) => (log.match(/has been executed successfully/g) || []).length;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

async function main() {
  console.log(`→ creating ${scratch} from template0 on ${conn.host}:${conn.port}`);
  await withClient(ADMIN_DB, (c) => c.query(`CREATE DATABASE "${scratch}" TEMPLATE template0`));

  // template0 carries no extensions, so a migration calling gen_random_uuid() would fail for a
  // reason that has nothing to do with the migration. The deployed image provides these.
  await withClient(scratch, async (c) => {
    await c.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  });

  console.log('→ first run: building the schema from nothing');
  const applied = appliedCount(await runMigrations());

  const { tables, recorded } = await withClient(scratch, async (c) => ({
    tables: Number((await one(c, `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`)).n),
    recorded: Number((await one(c, 'SELECT count(*)::int AS n FROM migrations')).n),
  }));
  console.log(`   applied=${applied}  recorded=${recorded}  tables=${tables}`);

  if (applied < MIN_MIGRATIONS) fail(`only ${applied} migration(s) ran; expected at least ${MIN_MIGRATIONS}`);
  if (recorded !== applied) fail(`${applied} ran but ${recorded} are recorded — a migration is not registering itself`);
  if (tables < MIN_TABLES) fail(`only ${tables} table(s) exist; expected at least ${MIN_TABLES}`);

  console.log('→ second run: proving a repeated deploy is a no-op');
  const again = appliedCount(await runMigrations());
  if (again !== 0) fail(`${again} migration(s) ran a second time; the run is not idempotent`);

  console.log('→ checking the controls a fresh provision must come up with');
  await withClient(scratch, async (c) => {
    for (const [table, name] of REQUIRED_CONSTRAINTS) {
      const { n } = await one(c, `SELECT count(*)::int AS n FROM pg_constraint WHERE conname='${name}' AND conrelid='${table}'::regclass`);
      if (Number(n) !== 1) fail(`${name} is missing from ${table} on a freshly migrated database`);
    }
    for (const [table, name] of REQUIRED_INDEXES) {
      const { n } = await one(c, `SELECT count(*)::int AS n FROM pg_indexes WHERE tablename='${table}' AND indexname='${name}'`);
      if (Number(n) !== 1) fail(`${name} is missing on a freshly migrated database`);
    }
  });

  /**
   * A fresh install is migrate THEN seed, and the seed used to undo part of what the migrations
   * had just done.
   *
   * Loading a role without its `permissions` relation and then assigning the array made TypeORM
   * delete every junction row the new array did not name, and the list it was given was itself
   * twelve keys behind `ROLE_PERMISSIONS`. Measured on the live deployment on 2026-09-10: ADMIN
   * held 57 of 63, DEVELOPER 57 of 64, OPERATIONS 36 of 39, DESK_OPERATOR 3 of 6 — nineteen
   * grants gone, among them the only SYSTEM:APPROVE:PLATFORM in the system, so nobody could
   * approve a destructive request and the two-person data-wipe rule could not be completed at all.
   *
   * Checking the schema was never going to find that: every table, constraint and index was
   * present and correct. Only the rows were wrong. So the check runs the real seed against the
   * real schema and compares what each role ends up holding to what the code table declares.
   */
  console.log('→ seeding, then checking every role holds what the code table declares');
  await runSeed();

  const declared = await readDeclaredGrants();
  const held = await withClient(scratch, async (c) => {
    const { rows } = await c.query(
      `SELECT r.name AS role, p.resource || ':' || p.action || ':' || p.scope AS key
         FROM roles r
         JOIN role_permissions rp ON rp.role_id = r.id
         JOIN permissions p ON p.id = rp.permission_id`,
    );
    const byRole = new Map();
    for (const row of rows) {
      if (!byRole.has(row.role)) byRole.set(row.role, new Set());
      byRole.get(row.role).add(row.key);
    }
    return byRole;
  });

  for (const role of REQUIRED_ROLES) {
    if (!held.has(role)) fail(`role ${role} holds no permissions after a fresh migrate and seed`);
  }

  let short = 0;
  for (const [role, keys] of Object.entries(declared)) {
    const have = held.get(role) ?? new Set();
    if (!keys.length) continue;
    const missing = keys.filter((k) => !have.has(k));
    console.log(`   ${role.padEnd(16)} declared ${String(keys.length).padStart(3)}  held ${String(have.size).padStart(3)}`);
    if (missing.length) {
      short += missing.length;
      console.error(`✗ ${role} is short ${missing.length}: ${missing.join(', ')}`);
    }
  }
  if (short) fail(`${short} declared grant(s) are missing after a fresh migrate and seed`);

  console.log('✓ migrations build a complete schema from empty, a repeated run changes nothing, and the seed leaves every role whole');
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  if (!process.exitCode) console.error(err.message);
  exitCode = process.exitCode || 1;
} finally {
  // Dropped whatever happened. FORCE so a connection abandoned by a killed migration cannot
  // leave the scratch database behind for somebody to notice later.
  try {
    await withClient(ADMIN_DB, (c) => c.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`));
  } catch (err) {
    console.error(`! could not drop ${scratch}: ${err.message}`);
  }
  process.exit(exitCode);
}
