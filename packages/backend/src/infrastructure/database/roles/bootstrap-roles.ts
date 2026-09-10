/**
 * Create the cluster's three FAPOMS roles and, if asked, the database itself.
 *
 * The ONE step that needs an administrative connection, because creating roles and installing
 * extensions are cluster-level acts that no least-privileged role can perform — which is the
 * point of them being least-privileged. Everything after this runs as `fapoms_migrator`.
 *
 * It is idempotent: re-running it sets the passwords again and leaves the rest alone, so a
 * credential rotation is this script with new secrets rather than hand-written SQL on a
 * production box at the moment somebody is worried.
 *
 *   DB_ADMIN_URL=postgres://postgres:…@host:5432/postgres \
 *   FAPOMS_RUNTIME_PASSWORD=… FAPOMS_MIGRATION_PASSWORD=… \
 *   npm run db:bootstrap-roles --workspace=packages/backend
 *
 * `CREATE_DATABASE=fapoms` also creates the database owned by the migration role and installs the
 * extensions the migrations expect. Omit it when the database already exists.
 */
import { DataSource } from 'typeorm';
import {
  AUDIT_OWNER_ROLE,
  MIGRATION_ROLE,
  RUNTIME_ROLE,
  createRolesSql,
} from './role-model';

/** Extensions the migrations assume are present. Installing one needs superuser; the app never does. */
const REQUIRED_EXTENSIONS = ['uuid-ossp', 'pgcrypto', 'postgis'];

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. This script writes real credentials into the cluster; it will not ` +
        'invent one, and a role created with a password nobody recorded is a deployment that ' +
        'cannot start.',
    );
  }
  return value;
}

async function main(): Promise<void> {
  const adminUrl = required('DB_ADMIN_URL');
  const runtimePassword = required('FAPOMS_RUNTIME_PASSWORD');
  const migrationPassword = required('FAPOMS_MIGRATION_PASSWORD');
  const createDatabase = process.env.CREATE_DATABASE;

  // A bare DataSource with no entities: this script issues catalogue statements and knows
  // nothing about the domain. `pg` is used through TypeORM rather than directly because it ships
  // no type declarations of its own.
  const admin = new DataSource({ type: 'postgres', url: adminUrl, entities: [] });
  await admin.initialize();
  try {
    const rows = await admin.query('SELECT current_user AS who, usesuper AS super FROM pg_user WHERE usename = current_user');
    // Said out loud, because running this as an ordinary role fails several statements in with
    // half the roles created, and "permission denied for CREATE ROLE" does not obviously mean
    // "you connected as the wrong user".
    console.log(`Connected as ${rows[0]?.who} (superuser: ${rows[0]?.super === true}).`);

    for (const statement of createRolesSql(runtimePassword, migrationPassword)) {
      await admin.query(statement);
    }
    console.log(`Roles ready: ${MIGRATION_ROLE} (deploy), ${AUDIT_OWNER_ROLE} (owns audit, no login), ${RUNTIME_ROLE} (the app).`);

    if (createDatabase) {
      const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [createDatabase]);
      if (!Array.isArray(exists) || exists.length === 0) {
        // Owned by the migration role, so migrations can create and alter without any further
        // grant, and the runtime — which owns nothing — cannot.
        await admin.query(`CREATE DATABASE "${createDatabase}" OWNER ${MIGRATION_ROLE}`);
        console.log(`Created database ${createDatabase}, owned by ${MIGRATION_ROLE}.`);
      } else {
        console.log(`Database ${createDatabase} already exists; leaving its owner alone.`);
      }

      const inDb = new DataSource({
        type: 'postgres',
        url: new URL(`/${createDatabase}`, adminUrl).toString(),
        entities: [],
      });
      await inDb.initialize();
      try {
        for (const extension of REQUIRED_EXTENSIONS) {
          try {
            await inDb.query(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
          } catch (err) {
            // PostGIS is absent from a plain `postgres` image. Named rather than swallowed: a
            // deployment without it will fail later, on a migration, with a much worse message.
            console.warn(`! could not install extension ${extension}: ${(err as Error).message}`);
          }
        }
        console.log(`Extensions checked: ${REQUIRED_EXTENSIONS.join(', ')}.`);
      } finally {
        await inDb.destroy();
      }
    }
  } finally {
    await admin.destroy();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
