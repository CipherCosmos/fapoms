#!/usr/bin/env node
/**
 * BRING A FAPOMS DATABASE FROM NOTHING TO READY, IN ONE COMMAND — from a checkout.
 *
 * A thin wrapper around `packages/backend/src/infrastructure/database/roles/provision.ts`, which
 * is where the sequence actually lives. Production runs the COMPILED form of that module directly
 * (`deploy/docker-compose.prod.yml`'s `db-migrate` service): the image carries `dist` and nothing
 * else, so a deploy step that shelled out to `npm run` or `ts-node` would work here and fail
 * there. This wrapper exists so a developer does not have to know that.
 *
 * Roles, database, extensions, migrations, hardening — in the order they have to happen, with no
 * hand-written SQL at any point. This is what a fresh deployment runs, and what an existing one
 * runs on every deploy: every step is idempotent, so the difference between "provision" and
 * "upgrade" is only which steps have anything left to do.
 *
 *   1. create the three roles                     (needs DB_ADMIN_URL, an administrative login)
 *   2. create the database, owned by the migrator (skipped if it exists)
 *   3. install the extensions                     (needs the administrative login)
 *   4. run migrations                             as fapoms_migrator
 *   5. harden                                     as fapoms_migrator, verified as fapoms_runtime
 *
 * The application then starts as `fapoms_runtime` with `DB_MIGRATIONS_RUN=false`. `main.ts`
 * refuses to boot in production if either of those is wrong, and `StartupChecksService` asks the
 * database itself what that identity can do.
 *
 * ## Environment
 *
 * | variable | used by | notes |
 * |---|---|---|
 * | `DB_ADMIN_URL` | steps 1-3 | a login that may CREATE ROLE and CREATE EXTENSION. Deploy-time only. |
 * | `FAPOMS_MIGRATION_PASSWORD` | 1, 4, 5 | the deploy credential. Never in the API's environment. |
 * | `FAPOMS_RUNTIME_PASSWORD` | 1, 5, and the API | the application credential. |
 * | `DB_HOST`, `DB_PORT`, `DB_DATABASE` | 2-5 | where the database is, and what it is called. |
 * | `SKIP_BOOTSTRAP=true` | — | steps 4-5 only, for a cluster whose roles somebody else manages. |
 *
 * `DB_USERNAME` / `DB_PASSWORD` are deliberately NOT inputs here: this script decides which
 * identity performs which step, and taking the identity from the environment is how a deployment
 * ends up migrating as the runtime role.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'backend');

function need(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. See the table in this script's header for what each step needs.`);
    process.exit(1);
  }
  return value;
}

function run(script, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', '--silent', script], {
      cwd: BACKEND,
      stdio: 'inherit',
      env: {
        ...process.env,
        DB_SSL: process.env.DB_SSL ?? 'false',
        // A URL in the environment silently wins over the discrete DB_* vars in data-source.ts,
        // which would point a step at a different database than the one being provisioned.
        DATABASE_URL: '',
        DATABASE_URL_UNPOOLED: '',
        ...extraEnv,
      },
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
  });
}

const database = process.env.DB_DATABASE || 'fapoms';
const migrationPassword = need('FAPOMS_MIGRATION_PASSWORD');
const runtimePassword = need('FAPOMS_RUNTIME_PASSWORD');

// One process, all three steps, so this wrapper and the container path cannot diverge.
await run('db:provision', {
  DB_DATABASE: database,
  FAPOMS_MIGRATION_PASSWORD: migrationPassword,
  FAPOMS_RUNTIME_PASSWORD: runtimePassword,
  ...(process.env.DB_ADMIN_URL ? { DB_ADMIN_URL: process.env.DB_ADMIN_URL } : {}),
});
